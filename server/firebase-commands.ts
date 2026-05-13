// Command bus: the frontend (Firebase-hosted PWA) writes intents to
// /commands/<auto_id>; this listener picks them up, dispatches via the
// same internal helpers used by the local HTTP routes, writes a result
// back, and deletes the command after a short grace window.
//
// All commands are idempotent — they set values, not deltas — so a
// listener restart that replays the same command is safe.
//
// SQLite remains the source of truth. After every applied command we
// push a fresh /state snapshot so the frontend re-renders against the
// live server, not against its optimistic local state.

import crypto from 'node:crypto';
import type { DataSnapshot, Reference } from 'firebase-admin/database';
import {
  updateSettings,
  endAllActiveAwaySessions,
  endAllActiveSummonSessions,
  addAwayContact,
  removeAwayContact,
  setAwayContactEnabled,
  getSettings,
  markAutoNoteReviewed,
  markAllAutoNotesReviewed,
  removeAutoNote,
  getAutoNote,
  listAutoNotes,
  setCalendarProposalTarget,
  getRepo,
  updateTaskPR,
} from './db/app.js';
import { exportCalendarProposal, dismissCalendarProposal } from './calendar-export.js';
import { cancelTask, startClaudeTask } from './task-runner.js';
import { getContactNameForHandle, normalizeHandle } from './db/contacts.js';
import { getMirrorDb, mirrorUpdateNote, mirrorDeleteNote } from './firebase.js';
import { pushAllRepoSnapshots, pushRepoSnapshot } from './firebase-repos.js';
import {
  sanitizeBranchName,
  worktreeBranchName,
  pushBranch,
  createPR,
  mergePR,
  closePR,
  readTaskSpec,
  buildRepoTaskPrompt,
  buildSpecTaskPrompt,
  buildCreateTaskPrompt,
  buildCreatePhasePrompt,
  getLastCommitMessage,
  getWorktreePath,
  removeWorktree,
} from './repo-tasks.js';
import { mirrorTaskPr } from './firebase-tasks.js';
import { pushStateSnapshot, pushStateSnapshotNow } from './firebase-state.js';
import { saveDeviceToken, removeDevice, sendPushToAll } from './firebase-push.js';
import { sendChatTurn, clearChatHistory } from './ai/galt-chat.js';

interface CommandResult {
  ok: boolean;
  error?: string;
  data?: unknown;
  processed_at: number;
}

interface RawCommand {
  type?: string;
  payload?: Record<string, unknown>;
  requested_at?: number;
  result?: CommandResult;
}

const GRACE_BEFORE_DELETE_MS = 5_000;

let _started = false;
let _ref: Reference | null = null;

/** Register the /commands listener. Idempotent — calling twice is a
 *  no-op. Safe to call before Firebase init returns null; the inner
 *  getMirrorDb() will lazy-disable if creds are missing. */
export function startCommandListener(): void {
  if (_started) return;
  const db = getMirrorDb();
  if (!db) {
    console.log('[firebase-commands] mirror disabled — listener not started');
    return;
  }
  _started = true;
  _ref = db.ref('/commands');

  _ref.on('child_added', (snap) => {
    void processCommand(snap).catch((err) => {
      console.error('[firebase-commands] processCommand crashed:', (err as Error).message);
    });
  });

  console.log('[firebase-commands] listener started on /commands');
}

export function stopCommandListener(): void {
  if (_ref) {
    _ref.off();
    _ref = null;
  }
  _started = false;
}

async function processCommand(snap: DataSnapshot): Promise<void> {
  const id = snap.key;
  if (!id) return;
  const raw = snap.val() as RawCommand | null;

  // Skip entries we already wrote a result onto. Happens when the
  // listener restarts and replays children that were processed but not
  // yet deleted. We still re-apply (idempotent), but don't double-write
  // the result/delete-timer.
  if (raw && raw.result) {
    console.log(`[firebase-commands] skip already-processed id=${id}`);
    return;
  }

  console.log(`[firebase-commands] recv id=${id} type=${raw?.type}`);

  let result: CommandResult;
  try {
    const data = await dispatch(raw ?? {});
    result = { ok: true, data, processed_at: Date.now() };
  } catch (err) {
    result = { ok: false, error: (err as Error).message, processed_at: Date.now() };
    console.error(`[firebase-commands] dispatch failed id=${id}:`, (err as Error).message);
  }

  // Push fresh state regardless of success — failure modes can still
  // shift state (e.g. settings rejected after partial work — none of
  // ours do that today, but cheap insurance).
  pushStateSnapshot();

  try {
    await snap.ref.child('result').set(result);
  } catch (err) {
    console.error(`[firebase-commands] write result failed id=${id}:`, (err as Error).message);
  }

  // Grace window so the frontend has time to read the result, then
  // garbage-collect the command. Don't await — the listener should
  // free up to process the next child_added immediately.
  setTimeout(() => {
    snap.ref.remove().catch((err: Error) => {
      console.error(`[firebase-commands] delete failed id=${id}:`, err.message);
    });
  }, GRACE_BEFORE_DELETE_MS).unref();
}

/** Whitelist + validate + apply. Throws on unknown type or bad payload —
 *  the caller wraps that into a structured error result. */
async function dispatch(cmd: RawCommand): Promise<unknown> {
  const type = typeof cmd.type === 'string' ? cmd.type : '';
  const p = (cmd.payload ?? {}) as Record<string, unknown>;

  switch (type) {
    case 'set_summon_enabled': {
      const enabled = !!p.enabled;
      const before = getSettings();
      const after = updateSettings({ summon_enabled: enabled ? 1 : 0 });
      if (before.summon_enabled && !enabled) {
        const ended = endAllActiveSummonSessions('globally_disabled');
        if (ended > 0) console.log(`[firebase-commands] ended ${ended} summon session(s) on remote disable`);
      }
      return { summon_enabled: !!after.summon_enabled };
    }

    case 'set_away_enabled': {
      const enabled = !!p.enabled;
      const before = getSettings();
      const after = updateSettings({ away_mode_enabled: enabled ? 1 : 0 });
      if (before.away_mode_enabled && !enabled) {
        const ended = endAllActiveAwaySessions('away_mode_disabled');
        if (ended > 0) console.log(`[firebase-commands] ended ${ended} away session(s) on remote disable`);
      }
      return { away_mode_enabled: !!after.away_mode_enabled };
    }

    case 'set_away_message': {
      const text = typeof p.text === 'string' ? p.text : '';
      const after = updateSettings({ away_message: text });
      return { away_message: after.away_message };
    }

    // 'set_voice_profile' (the old user voice profile) was retired when
    // Galt became the system-wide AI voice. Companion clients calling
    // this command on this build get an error and should switch to
    // set_galt_voice_profile.

    case 'set_galt_voice_profile': {
      const text = typeof p.text === 'string' ? p.text : '';
      const after = updateSettings({ galt_voice_profile: text });
      return { galt_voice_profile: after.galt_voice_profile };
    }

    case 'set_auto_notes_enabled': {
      const enabled = !!p.enabled;
      const after = updateSettings({ auto_notes_enabled: enabled ? 1 : 0 });
      return { auto_notes_enabled: !!after.auto_notes_enabled };
    }

    case 'add_watched_contact': {
      const handleRaw = typeof p.handle === 'string' ? p.handle : '';
      const handle = normalizeHandle(handleRaw);
      if (!handle) throw new Error('handle required');
      const labelRaw = typeof p.label === 'string' ? p.label.trim() : '';
      const label = labelRaw || getContactNameForHandle(handle);
      const contact = addAwayContact(handle, label);
      return {
        contact: {
          ...contact,
          enabled: !!contact.enabled,
          contact_name: getContactNameForHandle(contact.handle),
        },
      };
    }

    case 'remove_watched_contact': {
      const id = typeof p.id === 'number' ? p.id : NaN;
      if (!Number.isFinite(id)) throw new Error('id required');
      const ok = removeAwayContact(id);
      if (!ok) throw new Error('contact not found');
      return { removed_id: id };
    }

    case 'set_watched_contact_enabled': {
      const id = typeof p.id === 'number' ? p.id : NaN;
      if (!Number.isFinite(id)) throw new Error('id required');
      const enabled = !!p.enabled;
      const ok = setAwayContactEnabled(id, enabled);
      if (!ok) throw new Error('contact not found');
      return { id, enabled };
    }

    case 'mark_note_reviewed': {
      const id = typeof p.id === 'number' ? p.id : NaN;
      if (!Number.isFinite(id)) throw new Error('id required');
      const note = markAutoNoteReviewed(id);
      if (!note) throw new Error('note not found');
      void mirrorUpdateNote(note.message_guid, { reviewed_at: note.reviewed_at });
      return { id: note.id, reviewed_at: note.reviewed_at };
    }

    case 'mark_all_notes_reviewed': {
      const unreviewed = listAutoNotes({ reviewed: false, limit: 500 });
      const n = markAllAutoNotesReviewed();
      const reviewedAt = Date.now();
      for (const note of unreviewed) {
        void mirrorUpdateNote(note.message_guid, { reviewed_at: reviewedAt });
      }
      return { marked_reviewed: n };
    }

    case 'delete_note': {
      const id = typeof p.id === 'number' ? p.id : NaN;
      if (!Number.isFinite(id)) throw new Error('id required');
      const before = getAutoNote(id);
      const ok = removeAutoNote(id);
      if (!ok || !before) throw new Error('note not found');
      void mirrorDeleteNote(before.message_guid);
      return { removed_id: id };
    }

    case 'refresh_state': {
      // Force a fresh /state push without changing any local data.
      // Used by the frontend on connect / pull-to-refresh to make sure
      // it's seeing the current snapshot instead of a stale RTDB cache.
      await pushStateSnapshotNow();
      return { refreshed_at: Date.now() };
    }

    case 'register_device_token': {
      // Companion registers an FCM token after the user grants
      // notification permission. Idempotent on the token itself —
      // re-registering the same token updates the existing record.
      const token = typeof p.token === 'string' ? p.token.trim() : '';
      if (!token) throw new Error('token required');
      const ua = typeof p.user_agent === 'string' ? p.user_agent : undefined;
      const out = await saveDeviceToken({ token, user_agent: ua });
      return { device_id: out.device_id };
    }

    case 'unregister_device_token': {
      // Companion unregisters when the user disables notifications.
      // Accepts either device_id (preferred) or raw token.
      const deviceId = typeof p.device_id === 'string' ? p.device_id : '';
      if (!deviceId) throw new Error('device_id required');
      await removeDevice(deviceId);
      return { removed_id: deviceId };
    }

    case 'galt_chat': {
      // Direct chat between the user and Galt. sendChatTurn handles
      // the full flow: append user msg, pull history, call chatTurn,
      // append Galt's reply.
      const text = typeof p.text === 'string' ? p.text : '';
      const out = await sendChatTurn(text);
      return {
        user_message_id: out.user_message_id,
        galt_message_id: out.galt_message_id,
        reply: out.reply,
      };
    }

    case 'quick_claude': {
      // Home-screen "Claude" quick action — bypasses Galt's LLM and
      // delegates directly to Claude Code as a background task.
      // Returns the task_id immediately; the companion subscribes to
      // /tasks/<task_id> and renders the streaming output inline.
      const text = typeof p.text === 'string' ? p.text.trim() : '';
      if (!text) throw new Error('text required');
      const task = startClaudeTask({ task: text });
      return { ok: true, task_id: task.id };
    }

    case 'galt_chat_clear': {
      // Wipe the entire chat history. Destructive.
      await clearChatHistory();
      return { cleared: true };
    }

    case 'export_calendar_proposal': {
      // Companion taps "Approve" on a proposal card. Same path the
      // local web's HTTP /export endpoint uses — writes an .ics file
      // and `open`s it so Calendar.app's native importer takes over.
      const id = typeof p.id === 'number' ? p.id : NaN;
      if (!Number.isFinite(id)) throw new Error('id required');
      const out = await exportCalendarProposal(id);
      return { proposal: out.proposal };
    }

    case 'dismiss_calendar_proposal': {
      // Companion taps "Dismiss". No Calendar.app side effect.
      const id = typeof p.id === 'number' ? p.id : NaN;
      if (!Number.isFinite(id)) throw new Error('id required');
      const proposal = dismissCalendarProposal(id);
      return { proposal };
    }

    case 'cancel_task': {
      // Companion taps "Cancel" on a live task card. Backend kills
      // the subprocess (SIGTERM → SIGKILL) and flips status.
      const id = typeof p.task_id === 'string' ? p.task_id.trim() : '';
      if (!id) throw new Error('task_id required');
      const ok = cancelTask(id);
      return { ok, task_id: id };
    }

    case 'set_proposal_calendar': {
      // Companion changes the destination calendar dropdown on a
      // proposal card. Stored on the row; consumed by the .ics
      // export step which stamps it as X-WR-CALNAME so Calendar.app
      // pre-selects it in the import dialog.
      const id = typeof p.id === 'number' ? p.id : NaN;
      if (!Number.isFinite(id)) throw new Error('id required');
      const calRaw = p.calendar;
      const calendar: string | null =
        calRaw === null ? null
        : typeof calRaw === 'string' && calRaw.trim() ? calRaw.trim()
        : null;
      const updated = setCalendarProposalTarget(id, calendar);
      if (!updated) throw new Error('proposal not found');
      return { id, target_calendar: updated.target_calendar };
    }

    case 'refresh_repos': {
      // Force-push all active repo snapshots to RTDB. The companion's
      // /repos subscription picks them up automatically — no page reload.
      await pushAllRepoSnapshots();
      return { refreshed_at: Date.now() };
    }

    case 'start_repo_task': {
      // Companion taps "▶ Run" on a task row in the repo detail sheet.
      // Flow: read task spec → create git branch → start Claude task
      //   (with the repo's own .claude/ context) → on completion:
      //   push branch → gh pr create → mirror PR info to RTDB.
      const repoId = typeof p.repo_id === 'number' ? p.repo_id : NaN;
      if (!Number.isFinite(repoId)) throw new Error('repo_id required');
      const taskId = typeof p.task_id === 'string' ? p.task_id.trim() : '';
      if (!taskId) throw new Error('task_id required');

      const repo = getRepo(repoId);
      if (!repo) throw new Error(`repo ${repoId} not found`);
      if (!repo.active) throw new Error(`repo ${repo.name} is inactive`);

      // Read spec from disk — throws if not found.
      const spec = readTaskSpec(repo.local_path, taskId);

      // Branch name — Claude CLI creates the worktree + branch via --worktree.
      // The CLI transforms the name: "galt/foo" → branch "worktree-galt+foo".
      const worktreeName = sanitizeBranchName(taskId);
      const branch       = worktreeBranchName(worktreeName);

      // Build prompt and start the Claude task.
      const prompt = buildRepoTaskPrompt(spec, repo.name);

      const task = startClaudeTask({
        task:          prompt,
        working_dir:   repo.local_path,
        worktree_name: worktreeName,
        timeout_ms:    30 * 60_000,   // repo tasks can run longer
        onComplete: async (completedTask) => {
          // Only push + PR on success — cancelled/failed stay on the branch.
          if (completedTask.status !== 'succeeded') {
            console.log(`[repo-tasks] skipping push/PR — task ${completedTask.id} status=${completedTask.status}`);
            return;
          }
          try {
            await pushBranch(repo.local_path, branch);
            const prBody = `Automated implementation via Galt companion.\n\nTask: \`${taskId}\`\nSpec: \`${spec.filePath}\``;
            const pr = await createPR(repo.local_path, {
              title: `${taskId}: ${spec.title}`,
              body:  prBody,
              branch,
            });
            const prMeta = { url: pr.url, number: pr.number, title: pr.title, body: prBody, branch, repo_id: repoId, repo_name: repo.name, state: 'open' as const };
            await mirrorTaskPr(completedTask.id, prMeta);
            updateTaskPR(completedTask.id, 'open', pr.number, repoId, prMeta);
            // Clean up the worktree now that the branch is on origin.
            const wtPath = await getWorktreePath(repo.local_path, branch);
            if (wtPath) await removeWorktree(repo.local_path, wtPath);
            // Re-mirror the repo so the briefing reflects the branch state.
            void pushRepoSnapshot(repoId);
          } catch (err) {
            console.error(`[repo-tasks] post-task push/PR failed:`, (err as Error).message);
            // Append error event so the companion task card shows it.
            const { appendTaskEvent } = await import('./db/app.js');
            const { mirrorTaskEvent } = await import('./firebase-tasks.js');
            const row = appendTaskEvent(completedTask.id, 'stderr', {
              line: `push/PR failed: ${(err as Error).message}`,
            });
            void mirrorTaskEvent(row);
          }
        },
      });

      return { ok: true, task_id: task.id, branch, spec_title: spec.title };
    }

    case 'approve_pr': {
      // Companion taps "Merge" on a PR card.
      const repoId = typeof p.repo_id === 'number' ? p.repo_id : NaN;
      if (!Number.isFinite(repoId)) throw new Error('repo_id required');
      const prNumber = typeof p.pr_number === 'number' ? p.pr_number : NaN;
      if (!Number.isFinite(prNumber)) throw new Error('pr_number required');
      const taskId = typeof p.task_id === 'string' ? p.task_id.trim() : '';

      const repo = getRepo(repoId);
      if (!repo) throw new Error(`repo ${repoId} not found`);

      await mergePR(repo.local_path, prNumber);

      // Update PR state in RTDB + app.db so the card and briefing reflect the merge.
      if (taskId) {
        const db = getMirrorDb();
        if (db) await db.ref(`/tasks/${taskId}/pr/state`).set('merged');
        updateTaskPR(taskId, 'merged', prNumber);
      }
      void pushRepoSnapshot(repoId);
      return { ok: true, pr_number: prNumber, state: 'merged' };
    }

    case 'deny_pr': {
      // Companion taps "Close" on a PR card.
      const repoId = typeof p.repo_id === 'number' ? p.repo_id : NaN;
      if (!Number.isFinite(repoId)) throw new Error('repo_id required');
      const prNumber = typeof p.pr_number === 'number' ? p.pr_number : NaN;
      if (!Number.isFinite(prNumber)) throw new Error('pr_number required');
      const taskId = typeof p.task_id === 'string' ? p.task_id.trim() : '';

      const repo = getRepo(repoId);
      if (!repo) throw new Error(`repo ${repoId} not found`);

      await closePR(repo.local_path, prNumber);

      if (taskId) {
        const db = getMirrorDb();
        if (db) await db.ref(`/tasks/${taskId}/pr/state`).set('closed');
        updateTaskPR(taskId, 'closed', prNumber);
      }
      void pushRepoSnapshot(repoId);
      return { ok: true, pr_number: prNumber, state: 'closed' };
    }

    case 'spec_task': {
      // Expand a stub task into a full spec using Claude.
      // Same flow as start_repo_task but with buildSpecTaskPrompt:
      // Claude reads the stub + codebase → rewrites the file as a full spec → commit.
      // A branch + PR lets the human review the spec before merging.
      const repoId = typeof p.repo_id === 'number' ? p.repo_id : NaN;
      if (!Number.isFinite(repoId)) throw new Error('repo_id required');
      const taskId = typeof p.task_id === 'string' ? p.task_id.trim() : '';
      if (!taskId) throw new Error('task_id required');

      const repo = getRepo(repoId);
      if (!repo) throw new Error(`repo ${repoId} not found`);

      const spec       = readTaskSpec(repo.local_path, taskId);
      const worktreeName = sanitizeBranchName(`spec-${taskId}`);
      const branch       = worktreeBranchName(worktreeName);

      const prompt = buildSpecTaskPrompt(spec, repo.name);
      const task   = startClaudeTask({
        task:          prompt,
        working_dir:   repo.local_path,
        worktree_name: worktreeName,
        timeout_ms:    20 * 60_000,
        onComplete: async (completedTask) => {
          if (completedTask.status !== 'succeeded') return;
          try {
            await pushBranch(repo.local_path, branch);
            const specBody = `Expands stub \`${spec.filePath}\` into a full spec.\n\nGenerated by Galt.`;
            const pr = await createPR(repo.local_path, {
              title:  `spec(${taskId}): ${spec.title}`,
              body:   specBody,
              branch,
            });
            const prMeta2 = { url: pr.url, number: pr.number, title: pr.title, body: specBody, branch: pr.branch, repo_id: repoId, repo_name: repo.name, state: 'open' as const };
            await mirrorTaskPr(completedTask.id, prMeta2);
            updateTaskPR(completedTask.id, 'open', pr.number, repoId, prMeta2);
            const wtPath = await getWorktreePath(repo.local_path, branch);
            if (wtPath) await removeWorktree(repo.local_path, wtPath);
            void pushRepoSnapshot(repoId);
          } catch (err) {
            console.error(`[spec_task] post-task push/PR failed:`, (err as Error).message);
            const { appendTaskEvent } = await import('./db/app.js');
            const { mirrorTaskEvent } = await import('./firebase-tasks.js');
            const row = appendTaskEvent(completedTask.id, 'stderr', {
              line: `push/PR failed: ${(err as Error).message}`,
            });
            void mirrorTaskEvent(row);
          }
        },
      });

      return { ok: true, task_id: task.id, branch, spec_title: spec.title };
    }

    case 'create_repo_task': {
      // Claude reads the narrative + codebase, writes a real spec to tasks/backlog/,
      // commits, then we push and open a PR for review.
      const repoId = typeof p.repo_id === 'number' ? p.repo_id : NaN;
      if (!Number.isFinite(repoId)) throw new Error('repo_id required');
      const narrative = typeof p.narrative === 'string' ? p.narrative.trim() : '';
      if (!narrative) throw new Error('narrative required');

      const repo   = getRepo(repoId);
      if (!repo) throw new Error(`repo ${repoId} not found`);
      const shortId      = crypto.randomUUID().slice(0, 8);
      const worktreeName = `galt/new-task-${shortId}`;
      const branch       = worktreeBranchName(worktreeName);

      const prompt = buildCreateTaskPrompt(narrative, repo.name);
      const task   = startClaudeTask({
        task:          prompt,
        working_dir:   repo.local_path,
        worktree_name: worktreeName,
        timeout_ms:    15 * 60_000,
        onComplete: async (completedTask) => {
          if (completedTask.status !== 'succeeded') return;
          try {
            await pushBranch(repo.local_path, branch);
            const commitTitle = await getLastCommitMessage(repo.local_path);
            const prBody = `New task spec created from narrative.\n\n> ${narrative.slice(0, 400)}${narrative.length > 400 ? '…' : ''}`;
            const pr = await createPR(repo.local_path, {
              title: commitTitle,
              body:  prBody,
              branch,
            });
            const prMeta3 = { url: pr.url, number: pr.number, title: pr.title, body: prBody, branch, repo_id: repoId, repo_name: repo.name, state: 'open' as const };
            await mirrorTaskPr(completedTask.id, prMeta3);
            updateTaskPR(completedTask.id, 'open', pr.number, repoId, prMeta3);
            const wtPath = await getWorktreePath(repo.local_path, branch);
            if (wtPath) await removeWorktree(repo.local_path, wtPath);
            void pushRepoSnapshot(repoId);
          } catch (err) {
            console.error('[create_repo_task] push/PR failed:', (err as Error).message);
            const { appendTaskEvent } = await import('./db/app.js');
            const { mirrorTaskEvent } = await import('./firebase-tasks.js');
            const row = appendTaskEvent(completedTask.id, 'stderr', {
              line: `push/PR failed: ${(err as Error).message}`,
            });
            void mirrorTaskEvent(row);
          }
        },
      });

      return { ok: true, task_id: task.id };
    }

    case 'create_repo_phase': {
      // Claude reads the narrative, writes the phase entry + task stubs,
      // commits, then we push and open a PR for review.
      const repoId = typeof p.repo_id === 'number' ? p.repo_id : NaN;
      if (!Number.isFinite(repoId)) throw new Error('repo_id required');
      const narrative = typeof p.narrative === 'string' ? p.narrative.trim() : '';
      if (!narrative) throw new Error('narrative required');

      const repo   = getRepo(repoId);
      if (!repo) throw new Error(`repo ${repoId} not found`);
      const shortId      = crypto.randomUUID().slice(0, 8);
      const worktreeName = `galt/new-phase-${shortId}`;
      const branch       = worktreeBranchName(worktreeName);

      const prompt = buildCreatePhasePrompt(narrative, repo.name);
      const task   = startClaudeTask({
        task:          prompt,
        working_dir:   repo.local_path,
        worktree_name: worktreeName,
        timeout_ms:    20 * 60_000,
        onComplete: async (completedTask) => {
          if (completedTask.status !== 'succeeded') return;
          try {
            await pushBranch(repo.local_path, branch);
            const commitTitle = await getLastCommitMessage(repo.local_path);
            const prBody = `New phase plan created from narrative.\n\n> ${narrative.slice(0, 400)}${narrative.length > 400 ? '…' : ''}`;
            const pr = await createPR(repo.local_path, {
              title: commitTitle,
              body:  prBody,
              branch,
            });
            const prMeta4 = { url: pr.url, number: pr.number, title: pr.title, body: prBody, branch, repo_id: repoId, repo_name: repo.name, state: 'open' as const };
            await mirrorTaskPr(completedTask.id, prMeta4);
            updateTaskPR(completedTask.id, 'open', pr.number, repoId, prMeta4);
            const wtPath = await getWorktreePath(repo.local_path, branch);
            if (wtPath) await removeWorktree(repo.local_path, wtPath);
            void pushRepoSnapshot(repoId);
          } catch (err) {
            console.error('[create_repo_phase] push/PR failed:', (err as Error).message);
            const { appendTaskEvent } = await import('./db/app.js');
            const { mirrorTaskEvent } = await import('./firebase-tasks.js');
            const row = appendTaskEvent(completedTask.id, 'stderr', {
              line: `push/PR failed: ${(err as Error).message}`,
            });
            void mirrorTaskEvent(row);
          }
        },
      });

      return { ok: true, task_id: task.id };
    }

    case 'send_test_push': {
      // Smoke test from the Settings sheet — sends a one-shot push
      // to every registered device. Returns the per-device result
      // count so the UI can confirm delivery worked.
      const title = (typeof p.title === 'string' && p.title.trim()) || 'Galt test';
      const body = (typeof p.body === 'string' && p.body.trim()) || 'Push notifications are working.';
      const result = await sendPushToAll({ title, body, click_url: 'https://galt-messages.web.app' });
      return result;
    }

    case 'sync_open_prs': {
      // Back-fill PR data from RTDB into app.db for PRs created before
      // the pr_data column was added. Reads /tasks from RTDB, finds entries
      // with pr.state === 'open', writes them to app.db, then refreshes
      // all repo snapshots so open_prs shows up on the companion.
      const db = getMirrorDb();
      if (!db) return { ok: false, error: 'Firebase not connected' };
      const snap = await db.ref('/tasks').get();
      const tasksVal = snap.val() as Record<string, Record<string, unknown>> | null;
      if (!tasksVal) return { ok: true, synced: 0 };
      let synced = 0;
      for (const [taskId, taskData] of Object.entries(tasksVal)) {
        const pr = taskData.pr as Record<string, unknown> | undefined;
        if (!pr || pr.state !== 'open') continue;
        const repoId = typeof pr.repo_id === 'number' ? pr.repo_id : null;
        const prNumber = typeof pr.number === 'number' ? pr.number : null;
        if (!repoId || !prNumber) continue;
        updateTaskPR(taskId, 'open', prNumber, repoId, pr);
        synced++;
      }
      await pushAllRepoSnapshots();
      console.log(`[sync_open_prs] synced ${synced} open PRs from RTDB`);
      return { ok: true, synced };
    }

    case 'get_note_source': {
      // Fetch the full source message for an auto-note on demand. Bypass
      // FIREBASE_MIRROR_INCLUDE_MESSAGE_TEXT — that flag controls what
      // gets *persisted* on the open /notes mirror; this is an
      // authenticated request-response over the command bus, returning
      // the cached row from the local app.db.
      const id = typeof p.id === 'number' ? p.id : NaN;
      if (!Number.isFinite(id)) throw new Error('id required');
      const note = getAutoNote(id);
      if (!note) throw new Error('note not found');
      return {
        id: note.id,
        handle: note.handle,
        contact_name: getContactNameForHandle(note.handle),
        message_guid: note.message_guid,
        message_text: note.message_text,
        summary: note.summary,
        category: note.category,
        created_at: note.created_at,
      };
    }

    default:
      throw new Error(`unknown command type: ${type || '(missing)'}`);
  }
}
