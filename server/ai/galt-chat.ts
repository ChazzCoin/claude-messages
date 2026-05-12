// Galt direct-chat — Phase 2: conversation + tool calling.
//
// The companion PWA + local web dashboard both open chat surfaces
// where the user talks directly to Galt. Each user turn:
//   1. backend appends user msg to RTDB at /galt_chat/messages
//   2. backend calls chatTurn() — multi-round tool-calling against
//      CHAT_TOOLS (calendar, message search, contacts, notes, calls).
//   3. backend appends Galt's reply (and any tool-call record) to
//      RTDB
//   4. companion + web both render the new turn.
//
// Voice: pulls settings.galt_voice_profile so chat-Galt sounds like
// Galt elsewhere (away replies, summon replies). One voice everywhere.
//
// History shape: { role: 'user' | 'galt', text } — kept small. Tool
// calls + usage + model ride on the RTDB record alongside but aren't
// fed back to the model on subsequent turns (the model re-derives
// from the user-visible exchange).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chatWithTools } from './client.js';
import { buildChatTools } from './chat-tools.js';
import { getSettings, listRepos, listAllActiveTasks } from '../db/app.js';
import { getMirrorDb } from '../firebase.js';

const CLAUDE_LIFE_PATH = path.join(os.homedir(), 'claude-life');

/** One message in the running conversation, as the model sees it. */
export interface ChatTurnMessage {
  role: 'user' | 'galt';
  text: string;
}

/** A persisted message in RTDB. Wider than ChatTurnMessage because it
 *  carries display metadata (id, ts, model, usage, tool calls). The
 *  companion + web list views use this shape. */
export interface ChatHistoryMessage {
  id: string;
  role: 'user' | 'galt';
  text: string;
  ts: number;
  model?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
  tool_calls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
    result_preview: string;
    error: string | null;
    ms: number;
  }> | null;
  rounds?: number | null;
}

export interface ChatTurnResult {
  reply: string;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  /** Per-tool call record — name, arguments (as object), result
   *  preview (truncated), elapsed ms, optional error. Empty when
   *  the model answered without calling any tools. */
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
    result_preview: string;
    /** null when the tool succeeded. Kept nullable rather than
     *  optional so the RTDB writer doesn't choke on undefined. */
    error: string | null;
    ms: number;
  }>;
  rounds?: number;
}

export interface SendChatTurnResult {
  user_message_id: string;
  galt_message_id: string;
  reply: string;
  model: string;
}

const HISTORY_LIMIT = 30;

const SYSTEM_PROMPT_BASE = `You are GALT — the user's personal AI assistant. The user is messaging you DIRECTLY through their companion device (the same UI that handles iMessage triage, away mode, summon mode). This is NOT a thread with a contact; this IS a direct line between you and the user.

Your job here:
- Be a sharp, helpful thinking partner. The user asks questions, brainstorms, drafts things, gets unstuck.
- Speak in Galt's voice (see voice profile below). Same voice the user has heard you use everywhere else.
- iMessage-rhythm replies — usually short, occasionally longer when the topic earns it. No padding. No customer-service phrasings ("happy to help", "as an AI", etc.).
- Plain text only. No JSON, no preamble, no quotes around your reply.

YOU HAVE TOOLS — function-calls into the user's Mac. Use them aggressively when the user asks anything that touches their data.

READ TOOLS (call freely, no permission gate):
- list_calendar_events — schedule, upcoming meetings, free slots
- search_messages — full-text search of iMessage / SMS history
- list_recent_messages — what's come in lately
- list_auto_notes — the AI-extracted follow-up queue
- get_contact — look up someone by name or handle
- list_contact_notes — the user's per-contact memory bank
- get_call_history — phone + FaceTime call history
- claude_list_sessions — recent Claude Code sessions on this Mac (when the user asks what they were working on in Claude)

DELEGATION (call when the request exceeds your built-in tools):
- claude_ask — delegate to Claude Code running on this Mac. Use it for filesystem ops outside the dbs we have wired (chat.db, app.db, Calendar.sqlitedb, CallHistory.storedata, AddressBook), shell commands, code work, web search / fetch, summarizing files, anything CLI-accessible. DO NOT delegate when a built-in tool covers the request — Galt's own tools are faster and cheaper.

  ASYNC PATH: claude_ask RETURNS IMMEDIATELY with a task_id. Claude runs in the background; the chat UI renders a live progress card that streams updates and shows the final result. Your reply after calling claude_ask should be a SHORT framing sentence — e.g. "Asking Claude — watch the card below." DO NOT make up Claude's answer. DO NOT promise specific results. The card IS the answer.

  CODEBASE WORK — since Claude Code runs on the same Mac as the server, you can
  delegate real development tasks: fix a bug, add a feature, refactor, deploy.
  When the request is about a tracked repo, call list_repos first if you don't
  already have the local_path, then pass it as working_dir to claude_ask so
  Claude lands in the right directory. For the galt server itself, the working_dir
  is this project's root. Claude can run ./bin/deploy, npm run typecheck, git push
  — anything on the shell. Treat it like pairing with a developer who has full
  access to the Mac.

  Examples of GOOD claude_ask uses:
  - "fix the bug where the watcher drops reactions" → code investigation + edit
  - "add a new API endpoint for X" → read existing code, write new, deploy
  - "deploy galt" → shell: cd <path> && ./bin/deploy
  - "find the receipt PDF I downloaded last week" → filesystem search
  - "what's the latest gpt-4o model release date" → web research
  - "why is my disk so full" → shell (du / lsof) + analysis

  Examples of BAD claude_ask uses (use the built-in tool instead):
  - "what's on my calendar" → list_calendar_events
  - "did Sarah text me today" → search_messages
  - "who called me yesterday" → get_call_history

WRITE PROPOSALS — these are CRITICAL. They are the ONLY way you can actually surface something for the user to act on. Without a tool call, NOTHING HAPPENS — there is no card, no approval button, and no way for the user to commit your suggestion.

- propose_calendar_event — call this WHENEVER the user asks to add / schedule / book / create / put something on the calendar. Trigger phrases include: "add a meeting", "schedule a call", "put X on my calendar", "book lunch with Y", "create an event", "set up a [thing] [time]". You parse the fields and submit; the chat renders an Approve card.

  CRITICAL FAILURE MODE TO AVOID: do NOT reply with prose like "I've drafted...", "I've added...", "Just tap Approve" UNLESS you actually called propose_calendar_event on this turn. Saying it without calling the tool means there is no card for the user to tap. They will think you're broken. You will look like you lied. THIS IS THE #1 BUG SOURCE — guard against it.

  WRONG (don't do this — no tool call, just prose):
  user: "add a meeting with Bruce today at 1pm"
  galt: "I've drafted a meeting with Bruce today at 1 PM. Tap Approve!"  ← LIE. There is no card.

  RIGHT:
  user: "add a meeting with Bruce today at 1pm"
  galt: [calls propose_calendar_event with { title: "Meeting with Bruce", start_iso: "2026-05-11T13:00", end_iso: "2026-05-11T14:00", location: null, participants: "Bruce", notes: "" }]
  galt: "Drafted — meeting with Bruce today at 1 PM. Tap Approve to add."

  RECOVERY: if the user replies "approve" / "yes" / "go ahead" / "do it" and your PREVIOUS turn talked about drafting something but never actually called the tool — that means you flubbed the previous turn. Recover NOW: call propose_calendar_event with the details from the original request. Don't apologize, just do it. Your reply after the recovered tool call can briefly acknowledge: "Drafted now — tap Approve."

DECISION REQUESTS (call when you want an explicit yes/no from the user before doing something):
- request_user_approval — surfaces inline Approve / Deny buttons in the chat. Use it when you're about to do something the user might want to veto, or when their ask is ambiguous between two paths and you want a quick Y/N. Don't use it for everything — most asks don't need an extra confirmation step. Don't double-gate (propose_calendar_event already has its own Approve button — calling request_user_approval *and* propose_calendar_event for the same event is redundant and annoying).

There are NO guard rails on read visibility — if the user asks "what's my week look like" you should call list_calendar_events and answer with concrete events, not a hedge. Same for "who texted me today" (list_recent_messages), "what did Andrew say about the trip" (search_messages, then get_contact if name is ambiguous), "did mom call me yesterday" (get_call_history).

## Output discipline — card tools

The chat UI renders the following tools as visual cards the user sees immediately:
  list_calendar_events, list_auto_notes, list_repos, repo_status, search_tasks,
  active_tasks_all, active_tasks_for_repo, claude_list_sessions

For ALL of these: the card IS the data. Do NOT restate it in text. Your reply after
calling any card tool must be SILENT (empty string) or at most ONE short sentence
of genuine insight that goes beyond what the card shows.

GOOD — adds insight the card can't:
- "Tomorrow's packed." (calendar, reading the pattern)
- "That one from Mike's the only urgent flag." (notes, surfacing priority)
- "galt's got the most open work right now." (repos, reading the spread)
- "" (empty — perfectly valid; let the card speak)

WRONG — restating data the card already shows:
- "Here are your repos: galt (3 active), ChazzCoin (1 active)…" ← the card shows this
- "You have 4 follow-ups: [list]…" ← the card shows this
- "I found 3 active tasks: TASK-012…" ← the card shows this
- Any numbered list, any inline restate of counts/names/dates/titles

If the user asks an analytical follow-up ("which note is most urgent?", "what's the oldest task?"), answer THAT in prose. Cards are the data; prose is the insight.

For non-card read tools (search_messages, list_recent_messages, get_contact, list_contact_notes, get_call_history, list_gchat_messages, search_gchat_messages), synthesize into a natural answer — those return raw JSON the user can't see.

When you call propose_calendar_event, your reply afterward should be short: confirm what you drafted (title + date/time in plain English) and tell the user to tap Approve. Don't dump the JSON. The user sees the proposal card in the chat — your job is the natural-language framing around it.

REPO TOOLS — read and write tasks across all tracked repos:
- list_repos — discover which repos are tracked
- repo_status — phases + active tasks for a specific repo
- search_tasks — find tasks by keyword across all repos
- active_tasks_all — every active task across all repos (great for status reports)
- write_task — CREATE or UPDATE a task file on disk. Takes repo_id, title, state (backlog/active/done), optional body (markdown), optional phase_num. Auto-assigns the next TASK-NNN id when creating new. Also updates AUDIT.md and ROADMAP.md. Direct write — no approval step.
- move_task — move a task between states (backlog/active/done). Takes repo_id, task_id, new_state. Renames the file and appends an audit entry.
- git_commit_push — stage, commit, and push after writes. Call this after write_task or move_task to get the changes into git. Takes repo_id and a commit message.

IMPORTANT WRITE FLOW: when the user asks to add or update a task, call write_task directly — no approval needed. If they want it committed, call git_commit_push right after. The chat renders a write-receipt card — do NOT narrate the task back in text. One sentence max, e.g. "Done." or "Written and pushed." is plenty.

CLAUDE-LIFE MEMORY — the user's personal life-management repo, cloned at ~/claude-life. State, values, vision, and the people-index are injected into your system prompt above when they have content. For deeper reads or writes:
- read_memory — read any file by path (e.g. 'memories/people/friends/alex.md', 'docs/decisions/2025-01-15-...')
- list_memory — browse a directory to discover what's saved (e.g. 'memories/people/friends')
- write_memory — append or create a memory file, auto-commits to git

When the user mentions a person by name, consider calling list_memory to check if there's a saved memory file before assuming you have no context. When the user says "remember X" or "make a note that", call write_memory directly — no approval needed.

If the user asks for something a tool doesn't cover (Apple Notes, sending an iMessage, propose-reminder, modifying existing calendar events), say so plainly — don't invent a fake tool call. Tool coverage will expand; right now this is what you've got.

If the user just wants to chat, banter, brainstorm, or draft — do that. No tool calls needed.`;

/** Build a compact repo status block to inject once per turn. Pulls
 *  from app.db (last-polled snapshot) so it's instant — no git ops.
 *  Returns empty string when no repos are registered. */
function buildRepoContext(): string {
  const repos = listRepos({ activeOnly: true });
  if (!repos.length) return '';

  const activeTasks = listAllActiveTasks();
  if (!activeTasks.length && !repos.length) return '';

  const lines: string[] = ['REPOS — current task snapshot (from last poll; call repo_status for fresh detail):'];

  // Group active tasks by repo.
  const byRepo = new Map<number, typeof activeTasks>();
  for (const t of activeTasks) {
    const rid = t.repo_id;
    if (rid == null) continue;
    if (!byRepo.has(rid)) byRepo.set(rid, []);
    byRepo.get(rid)!.push(t);
  }

  for (const repo of repos) {
    const repoTasks = byRepo.get(repo.id) ?? [];
    const taskList = repoTasks.slice(0, 6).map((t) => {
      const age = t.mtime != null ? Math.floor((Date.now() - t.mtime) / 86400000) : null;
      const ageStr = age != null ? ` (${age}d)` : '';
      return `  · ${t.task_id} — ${t.title}${ageStr}`;
    });
    const moreStr = repoTasks.length > 6 ? `  · …+${repoTasks.length - 6} more active` : '';
    lines.push(`\n${repo.name}${repo.company ? ` (${repo.company})` : ''} — ${repoTasks.length} active task${repoTasks.length !== 1 ? 's' : ''}`);
    if (taskList.length) lines.push(...taskList);
    if (moreStr) lines.push(moreStr);
  }

  return lines.join('\n');
}

/** Read a file from claude-life safely — returns null if missing/empty. */
function readLifeFile(...segments: string[]): string | null {
  try {
    const p = path.join(CLAUDE_LIFE_PATH, ...segments);
    const content = fs.readFileSync(p, 'utf8').trim();
    return content || null;
  } catch {
    return null;
  }
}

/** Returns true if file content is still an unfilled template placeholder. */
function isPlaceholder(content: string): boolean {
  // Files with ONLY placeholder blocks like {{...}} and no real content.
  const stripped = content.replace(/\{\{[^}]*\}\}/g, '').replace(/[#\-*>\s]/g, '');
  return stripped.length < 20;
}

/** Build the life context block injected into every Galt turn.
 *  Reads state (always), values + vision (when filled in).
 *  Reads memory/people index when it has content. */
function buildLifeContext(): string {
  const parts: string[] = [];

  const state = readLifeFile('.claude', 'state.md');
  if (state && !isPlaceholder(state)) {
    parts.push(`CHAZZ'S CURRENT STATE (from claude-life/.claude/state.md):\n${state}`);
  }

  const values = readLifeFile('.claude', 'values.md');
  if (values && !isPlaceholder(values)) {
    parts.push(`CHAZZ'S VALUES (from claude-life/.claude/values.md):\n${values}`);
  }

  const vision = readLifeFile('.claude', 'vision.md');
  if (vision && !isPlaceholder(vision)) {
    parts.push(`CHAZZ'S VISION (from claude-life/.claude/vision.md):\n${vision}`);
  }

  const peopleIndex = readLifeFile('memories', 'people', 'INDEX.md');
  if (peopleIndex && !isPlaceholder(peopleIndex)) {
    parts.push(`KNOWN PEOPLE INDEX (from claude-life/memories/people/INDEX.md):\n${peopleIndex}`);
  }

  return parts.join('\n\n');
}

function buildSystemPrompt(): string {
  const voice = (getSettings().galt_voice_profile || '').trim();
  const repoCtx = buildRepoContext();
  const lifeCtx = buildLifeContext();

  let prompt = SYSTEM_PROMPT_BASE;
  if (lifeCtx) {
    prompt += `\n\n${lifeCtx}`;
  }
  if (repoCtx) {
    prompt += `\n\n${repoCtx}`;
  }
  if (voice) {
    prompt += `\n\nGALT'S VOICE — how you sound when speaking. Apply throughout.\n"""\n${voice}\n"""`;
  }
  return prompt;
}

/** Tool-call result strings can be large. Truncate before persisting
 *  so RTDB records stay slim and the companion / web don't render
 *  multi-KB blobs. The full result is still in the OpenAI loop.
 *
 *  Limit is generous (4 KB) because some tools — notably
 *  list_calendar_events with 5–10 events — produce results the UI
 *  parses back into structured cards. If we truncated those mid-JSON,
 *  the card renderer would fail to JSON.parse the preview and the
 *  events wouldn't display. 4 KB comfortably holds ~10 events. */
const RESULT_PREVIEW_MAX = 4_000;
function preview(s: string): string {
  if (s.length <= RESULT_PREVIEW_MAX) return s;
  return s.slice(0, RESULT_PREVIEW_MAX) + `…[truncated, ${s.length - RESULT_PREVIEW_MAX} more chars]`;
}

/** Convert history into the OpenAI messages shape. The first message
 *  may be a user OR a galt message (when called from an empty state
 *  defensively, history can't really be empty in practice because
 *  the caller appends the user's message first). */
function toOpenAIMessages(history: ChatTurnMessage[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return history.map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.text,
  }));
}

/** Regex pre-classifier for the user's latest message. If it matches
 *  a clear "schedule something" pattern, we force the model to call
 *  propose_calendar_event on the first round (bypassing gpt-4o-mini's
 *  flaky default of replying "I've drafted!" in prose without
 *  actually calling the tool).
 *
 *  False negatives are recoverable (the system prompt still nudges
 *  the model toward the tool). False positives are bad — they'd
 *  force a calendar proposal on a question like "what's on my
 *  calendar?". Patterns are tight on purpose:
 *    - require an action verb (add/schedule/book/create/etc.)
 *    - require an event-noun (meeting/event/appointment/...) OR a
 *      concrete time/date phrase
 *
 *  Read tools like list_calendar_events still fire normally on
 *  read-style questions because the model picks them under 'auto'. */
function shouldForceCalendarPropose(latestUserText: string): boolean {
  const text = latestUserText.toLowerCase();
  if (!text) return false;

  // Read-style queries that overlap with scheduling keywords —
  // hard-block to avoid forcing a proposal on a question.
  if (/\b(what|when|show|list|any)\b.*(calendar|schedule|events?|appointments?)/i.test(text)) {
    return false;
  }
  if (/\b(do i have|is there|what's on)\b/i.test(text)) {
    return false;
  }

  const hasActionVerb =
    /\b(add|schedule|book|create|make|set\s+up|put|plan|throw\s+on|tee\s+up|block(?:\s+off|\s+out)?)\b/i.test(text);
  if (!hasActionVerb) return false;

  const hasEventNoun =
    /\b(meeting|event|appointment|appt|call|lunch|dinner|breakfast|coffee|chat|sync|standup|review|hangout|catch[-\s]?up|interview|session|reminder)\b/i.test(text);
  const hasCalendarRef = /\b(calendar|on (my|the) (cal|calendar))\b/i.test(text);
  const hasTimePhrase =
    /\b(at\s+\d|today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|this week|next month|in an? hour|in\s+\d+\s+(min|minutes|hours))\b/i.test(text);

  return hasEventNoun || hasCalendarRef || hasTimePhrase;
}

/** Run one chat turn. `history` should already include the latest
 *  user message at the end. `galtMessageId` is the RTDB key under
 *  which Galt's reply will be persisted — it's pre-computed in
 *  sendChatTurn() so that write-proposal tools (e.g.
 *  propose_calendar_event) can stamp it on their persisted row for
 *  back-reference and dedup. Returns Galt's reply text plus the
 *  model, usage, tool call record. */
export async function chatTurn(
  history: ChatTurnMessage[],
  galtMessageId: string,
): Promise<ChatTurnResult> {
  const systemPrompt = buildSystemPrompt();
  const messages = toOpenAIMessages(history);
  const tools = buildChatTools(galtMessageId);

  // Today's date in the user's local timezone — the model needs this
  // to resolve relative phrases ("tomorrow", "Friday") to absolute
  // times for propose_calendar_event. Stamped per-turn so the model
  // doesn't have to ask. Format mirrors what extractCalendarEvent
  // uses for the inbound flow.
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const nowSystem =
    `CURRENT MOMENT\nNow: ${new Date().toISOString()} (UTC)\n` +
    `User timezone: ${tz}\nLocal time: ${new Date().toLocaleString('en-US', { timeZone: tz })}\n` +
    `When you write start_iso / end_iso for propose_calendar_event, use local time in YYYY-MM-DDTHH:MM format (no timezone suffix).`;
  const fullSystem = `${systemPrompt}\n\n${nowSystem}`;

  // Pre-classify the user's latest message. If it's clearly a
  // scheduling request, force propose_calendar_event so gpt-4o-mini
  // can't skip the tool in favor of prose-only acknowledgment.
  const latestUser = [...history].reverse().find((m) => m.role === 'user');
  const forceTool = latestUser && shouldForceCalendarPropose(latestUser.text)
    ? 'propose_calendar_event'
    : undefined;

  const result = await chatWithTools({
    systemPrompt: fullSystem,
    messages,
    tools,
    purpose: 'galt_chat',
    temperature: 0.7,
    maxTokens: 800,
    maxRounds: 6,
    forceTool,
  });

  // The model might end with an empty reply if it ONLY called tools
  // without a final synthesis (rare with the current prompt, but
  // defend against it). Fall back to a hedge.
  const reply =
    result.reply.trim() ||
    "Hm — I worked through that but didn't compose an answer. Try asking again?";

  return {
    reply,
    model: result.model,
    usage: result.usage,
    toolCalls: result.toolCalls.map((tc) => ({
      name: tc.name,
      arguments: tc.arguments,
      result_preview: preview(tc.result),
      error: tc.error ?? null,
      ms: tc.ms,
    })),
    rounds: result.rounds,
  };
}

/* ============================================================
   Full-flow helpers — used by both the firebase-commands listener
   and the web HTTP routes.

   RTDB is the source of truth for chat history. The companion PWA
   subscribes to /galt_chat/messages; the web dashboard fetches over
   HTTP. Both clients see the same conversation.
   ============================================================ */

/** Append the user's incoming message, run a turn, append Galt's
 *  reply. Returns ids for both messages plus the raw reply text so
 *  callers can echo it back to the requester. */
export async function sendChatTurn(text: string): Promise<SendChatTurnResult> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('text required');

  const db = getMirrorDb();
  if (!db) throw new Error('mirror disabled — chat unavailable');

  const messagesRef = db.ref('/galt_chat/messages');

  // 1. Append user message.
  const userMsgRef = messagesRef.push();
  await userMsgRef.set({
    role: 'user',
    text: trimmed,
    ts: Date.now(),
  });

  // 2. Pull the most recent N messages for context. RTDB
  //    limitToLast() works because keys are timestamp-ordered.
  const snap = await messagesRef.limitToLast(HISTORY_LIMIT).once('value');
  const history: ChatTurnMessage[] = [];
  snap.forEach((child) => {
    const v = child.val();
    if (v && typeof v.text === 'string' && (v.role === 'user' || v.role === 'galt')) {
      history.push({ role: v.role, text: v.text });
    }
    return false;
  });

  // 3. Pre-compute the Galt reply's RTDB key. push() generates the
  //    key locally without writing; we pass it into chatTurn so any
  //    write-proposal tool can stamp it on its row (used for dedup
  //    and back-reference: "which chat turn proposed this event?").
  const galtMsgRef = messagesRef.push();
  const galtMsgKey = galtMsgRef.key as string;

  // 4. Run the turn with the pre-computed key in hand.
  const result = await chatTurn(history, galtMsgKey);

  // 5. Append Galt's reply (with any tool calls so the companion can
  //    render them).
  await galtMsgRef.set({
    role: 'galt',
    text: result.reply,
    ts: Date.now(),
    model: result.model,
    usage: result.usage ?? null,
    tool_calls: result.toolCalls && result.toolCalls.length > 0 ? result.toolCalls : null,
    rounds: result.rounds ?? null,
  });

  return {
    user_message_id: userMsgRef.key as string,
    galt_message_id: galtMsgKey,
    reply: result.reply,
    model: result.model,
  };
}

/** List the most recent N messages, oldest → newest. */
export async function listChatHistory(limit = 100): Promise<ChatHistoryMessage[]> {
  const db = getMirrorDb();
  if (!db) return [];
  const snap = await db.ref('/galt_chat/messages').limitToLast(limit).once('value');
  const out: ChatHistoryMessage[] = [];
  snap.forEach((child) => {
    const v = child.val();
    if (v && (v.role === 'user' || v.role === 'galt') && typeof v.text === 'string') {
      out.push({
        id: child.key as string,
        role: v.role,
        text: v.text,
        ts: typeof v.ts === 'number' ? v.ts : 0,
        model: typeof v.model === 'string' ? v.model : undefined,
        usage: v.usage ?? null,
        tool_calls: Array.isArray(v.tool_calls) ? v.tool_calls : null,
        rounds: typeof v.rounds === 'number' ? v.rounds : null,
      });
    }
    return false;
  });
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/** Wipe the full chat history. Destructive. */
export async function clearChatHistory(): Promise<void> {
  const db = getMirrorDb();
  if (!db) throw new Error('mirror disabled');
  await db.ref('/galt_chat/messages').remove();
}
