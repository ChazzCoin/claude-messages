// Task runner — orchestrates long-running operations against the
// /tasks DB + RTDB mirror.
//
// Phase 2 ships one runner: Claude CLI delegations. The shape is
// general enough that future heavy ops (multi-file refactor agent,
// auto-extraction batch, Chrome browse) drop in as new runners
// without changing the chat layer.
//
// Flow for a Claude task:
//   1. createTask(...) in app.db                   — status=queued
//   2. mirrorTask → RTDB                            — clients see queued
//   3. spawn claude (via claudeCliStreamer.start)   — fire-and-forget
//   4. flip status→'running' + mirror
//   5. for each stream event: appendTaskEvent + mirrorTaskEvent
//   6. on result: updateTask(status='succeeded'|'failed', result, model,
//      session_id, total_cost_usd, num_turns) + mirror
//   7. drop subprocess from cancel registry

import crypto from 'node:crypto';
import fs from 'node:fs';

import {
  createTask,
  getTask,
  updateTask,
  appendTaskEvent,
  resetRepoSession,
  type TaskRow,
} from './db/app.js';
import { mirrorTask, mirrorTaskEvent } from './firebase-tasks.js';
import { claudeCliStreamer, type ChatStreamHandle } from './integrations/claude-cli.js';

/** Live subprocess registry — keyed by task_id so cancel can find
 *  and SIGTERM the right one. Cleared on task completion / error. */
const liveTasks = new Map<string, ChatStreamHandle>();

/** Completion callbacks — registered by callers that need to run
 *  post-task work (e.g. git push + gh pr create). Cleared after fire. */
const completionCallbacks = new Map<string, (task: TaskRow) => Promise<void>>();

/** Append + RTDB-mirror in one shot. Fire-and-forget on the RTDB
 *  side; the DB write is the source of truth. */
function persistEvent(taskId: string, kind: string, data: unknown): void {
  try {
    const row = appendTaskEvent(taskId, kind, data);
    void mirrorTaskEvent(row);
  } catch (err) {
    console.warn(`[task-runner] event persist failed (task=${taskId}): ${(err as Error).message}`);
  }
}

/** Update task row + RTDB mirror. */
function persistTaskUpdate(taskId: string, patch: Parameters<typeof updateTask>[1]): TaskRow | null {
  const next = updateTask(taskId, patch);
  if (next) void mirrorTask(next);
  return next;
}

export interface ClaudeTaskInput {
  task: string;
  working_dir?: string;
  allowed_tools?: string[];
  disallowed_tools?: string[];
  max_budget_usd?: number;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  max_turns?: number;
  /** The galt-chat message id that kicked this task off, used for
   *  back-reference + display. */
  source_chat_msg_id?: string;
  /** Create a git worktree with this branch name before starting.
   *  Passed as `--worktree <name>` to the Claude CLI. Claude handles
   *  the branch + worktree creation itself and works inside it. */
  worktree_name?: string;
  /** Optional: surface a stricter timeout. Defaults to 15 minutes
   *  for Claude tasks (vs the 5min sync chat()) — streaming tasks
   *  can be longer. */
  timeout_ms?: number;
  /** Reuse a persistent Claude session. Passed as --session-id to the
   *  CLI so context accumulates across tasks for this repo. */
  session_id?: string;
  /** Owning repo — used to rotate the session on max-turn rollover. */
  repo_id?: number;
  /** Called once after the task reaches a terminal state (succeeded,
   *  failed, or cancelled). Use for post-task work like git push + PR. */
  onComplete?: (task: TaskRow) => Promise<void>;
}

/** Kick off a Claude delegation as a background task. Returns the
 *  task row immediately (status='queued'); the subprocess runs
 *  fire-and-forget afterward. Caller is expected to embed the task
 *  id in its tool result so the chat UI can render a live card. */
export function startClaudeTask(input: ClaudeTaskInput): TaskRow {
  const id = crypto.randomUUID();
  const created = createTask({
    id,
    type: 'claude_delegate',
    input: {
      task: input.task,
      working_dir: input.working_dir ?? null,
      allowed_tools: input.allowed_tools ?? null,
      disallowed_tools: input.disallowed_tools ?? null,
      max_budget_usd: input.max_budget_usd ?? null,
      model: input.model ?? null,
      effort: input.effort ?? null,
      max_turns: input.max_turns ?? null,
    },
    source_chat_msg_id: input.source_chat_msg_id ?? null,
  });
  void mirrorTask(created);

  if (input.onComplete) {
    completionCallbacks.set(id, input.onComplete);
  }

  // Fire-and-forget — the runner closes the loop on its own.
  void runClaudeTaskBody(created, input);
  return created;
}

async function runClaudeTaskBody(task: TaskRow, input: ClaudeTaskInput): Promise<void> {
  // Validate working_dir if provided — the model sometimes hallucinates
  // paths (observed: '/Users/adam' on a different user's Mac), which
  // makes spawn() return ENOENT with a misleading "binary not found"
  // message. Fall back to the backend's cwd silently.
  let resolvedWorkingDir = input.working_dir;
  if (resolvedWorkingDir) {
    try {
      const stat = fs.statSync(resolvedWorkingDir);
      if (!stat.isDirectory()) resolvedWorkingDir = undefined;
    } catch {
      // ENOENT / EACCES — drop the bogus path
      appendTaskEvent(task.id, 'stderr', {
        line: `requested working_dir does not exist: ${resolvedWorkingDir}; falling back to backend cwd`,
      });
      resolvedWorkingDir = undefined;
    }
  }

  const handle = claudeCliStreamer.start({
    prompt: input.task,
    workingDir: resolvedWorkingDir,
    allowedTools: input.allowed_tools,
    disallowedTools: input.disallowed_tools,
    maxBudgetUsd: input.max_budget_usd,
    model: input.model,
    effort: input.effort,
    maxTurns: input.max_turns ?? 30,
    worktreeName: input.worktree_name,
    sessionId: input.session_id,
  });
  liveTasks.set(task.id, handle);

  // Belt timeout — Claude tasks can legitimately run long, but we
  // still want a ceiling. Defaults to 15 minutes; caller can extend
  // via input.timeout_ms.
  const timeoutMs = input.timeout_ms ?? 15 * 60_000;
  const timer = setTimeout(() => {
    console.warn(`[task-runner] task ${task.id} timed out after ${timeoutMs}ms; killing`);
    handle.cancel();
  }, timeoutMs);
  if (timer.unref) timer.unref();

  persistTaskUpdate(task.id, { status: 'running' });

  // Aggregate state as the stream progresses.
  let resultText = '';
  let sessionId: string | null = null;
  let model: string | null = null;
  let totalCostUsd: number | null = null;
  let numTurns: number | null = null;
  let sawResult = false;
  let sawError = false;
  let errorMsg: string | null = null;

  try {
    for await (const ev of handle.events) {
      switch (ev.kind) {
        case 'init':
          sessionId = ev.sessionId || sessionId;
          model = ev.model || model;
          persistEvent(task.id, 'init', {
            session_id: ev.sessionId,
            model: ev.model,
            tools: ev.tools,
          });
          break;
        case 'text':
          persistEvent(task.id, 'message', { text: ev.text });
          break;
        case 'tool_use':
          persistEvent(task.id, 'tool_use', {
            tool: ev.tool,
            tool_use_id: ev.toolUseId,
            input_preview: shortPreview(ev.input),
          });
          break;
        case 'tool_result':
          persistEvent(task.id, 'tool_result', {
            tool_use_id: ev.toolUseId,
            preview: ev.preview,
            is_error: ev.isError,
          });
          break;
        case 'usage':
          // Usage events are noisy + cumulative — skip persisting per
          // event; the final result event carries the totals.
          break;
        case 'stderr':
          if (ev.line.trim()) persistEvent(task.id, 'stderr', { line: ev.line });
          break;
        case 'result':
          sawResult = true;
          sawError = ev.isError;
          resultText = ev.result;
          sessionId = ev.sessionId || sessionId;
          totalCostUsd = ev.totalCostUsd;
          numTurns = ev.numTurns;
          break;
      }
    }
  } catch (err) {
    errorMsg = (err as Error).message;
  } finally {
    clearTimeout(timer);
    liveTasks.delete(task.id);
  }

  const current = getTask(task.id);
  if (!current) return;

  // Don't clobber a 'cancelled' status set by the cancel handler.
  if (current.status === 'cancelled') {
    persistTaskUpdate(task.id, {
      session_id: sessionId,
      model,
      total_cost_usd: totalCostUsd,
      num_turns: numTurns,
      result: resultText || null,
    });
    return;
  }

  // Max-turn rollover: when the CLI exits with is_error because --max-turns
  // was reached, rotate the repo session so the next task starts fresh.
  // Show as 'context_limit' in the UI rather than 'failed'.
  const maxTurns = input.max_turns ?? 30;
  const hitTurnLimit = sawError && numTurns !== null && numTurns >= maxTurns - 1;
  if (hitTurnLimit && input.repo_id) {
    resetRepoSession(input.repo_id);
    persistTaskUpdate(task.id, {
      status: 'context_limit',
      result: resultText || 'turn limit reached — session rotated for next task',
      session_id: sessionId,
      model,
      total_cost_usd: totalCostUsd,
      num_turns: numTurns,
    });
    const cb = completionCallbacks.get(task.id);
    if (cb) {
      completionCallbacks.delete(task.id);
      const row = getTask(task.id);
      if (row) void cb(row).catch((err) => {
        console.error(`[task-runner] onComplete failed (task=${task.id}):`, (err as Error).message);
      });
    }
    return;
  }

  if (!sawResult) {
    persistTaskUpdate(task.id, {
      status: 'failed',
      error: errorMsg || 'claude exited without a result event',
      session_id: sessionId,
      model,
      total_cost_usd: totalCostUsd,
      num_turns: numTurns,
    });
    return;
  }

  const finalRow = persistTaskUpdate(task.id, {
    status: sawError ? 'failed' : 'succeeded',
    result: resultText,
    error: sawError ? resultText : null,
    session_id: sessionId,
    model,
    total_cost_usd: totalCostUsd,
    num_turns: numTurns,
  });

  // Fire onComplete callback — used by repo tasks to push branch + open PR.
  const cb = completionCallbacks.get(task.id);
  if (cb) {
    completionCallbacks.delete(task.id);
    if (finalRow) {
      void cb(finalRow).catch((err) => {
        console.error(`[task-runner] onComplete failed (task=${task.id}):`, (err as Error).message);
      });
    }
  }
}

/** Cancel a running task. Returns false if the task isn't running
 *  (already terminal, unknown id, etc.). The async task body sees
 *  the subprocess die, exits its event loop, and the final state
 *  update preserves the 'cancelled' status set here. */
export function cancelTask(taskId: string): boolean {
  const handle = liveTasks.get(taskId);
  if (!handle) return false;
  persistTaskUpdate(taskId, { status: 'cancelled' });
  handle.cancel();
  return true;
}

/** Compact a tool-call input for display (e.g. the `query` arg of a
 *  Bash call). Strings truncate; objects JSON-stringified then
 *  truncated. Keeps RTDB writes small. */
function shortPreview(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') {
    return value.length > 200 ? value.slice(0, 200) + '…' : value;
  }
  let s: string;
  try { s = JSON.stringify(value); } catch { s = String(value); }
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}
