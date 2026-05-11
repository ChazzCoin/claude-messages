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

import { chatWithTools } from './client.js';
import { CHAT_TOOLS } from './chat-tools.js';
import { getSettings } from '../db/app.js';
import { getMirrorDb } from '../firebase.js';

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

YOU HAVE TOOLS — function-calls into the user's Mac. Use them aggressively when the user asks anything that touches their data:
- list_calendar_events — schedule, upcoming meetings, free slots
- search_messages — full-text search of iMessage / SMS history
- list_recent_messages — what's come in lately
- list_auto_notes — the AI-extracted follow-up queue
- get_contact — look up someone by name or handle
- list_contact_notes — the user's per-contact memory bank
- get_call_history — phone + FaceTime call history

These tools are read-only. There are NO guard rails on visibility — if the user asks "what's my week look like" you should call list_calendar_events and answer with concrete events, not a hedge. Same for "who texted me today" (list_recent_messages), "what did Andrew say about the trip" (search_messages, then get_contact if name is ambiguous), "did mom call me yesterday" (get_call_history).

When you call a tool, the result comes back as JSON. Synthesize it into a natural answer in your voice — don't dump JSON at the user. Quote specific data (times, names, exact phrases) when the user asked for specifics.

If the user asks for something a tool doesn't cover (Apple Notes, sending an iMessage, modifying calendar events), say so plainly — don't invent a fake tool call. Tool coverage will expand; right now this is what you've got.

If the user just wants to chat, banter, brainstorm, or draft — do that. No tool calls needed.`;

function buildSystemPrompt(): string {
  const voice = (getSettings().galt_voice_profile || '').trim();
  if (!voice) return SYSTEM_PROMPT_BASE;
  return `${SYSTEM_PROMPT_BASE}\n\nGALT'S VOICE — how you sound when speaking. Apply throughout.\n"""\n${voice}\n"""`;
}

/** Tool-call result strings can be large. Truncate before persisting
 *  so RTDB records stay slim and the companion / web don't render
 *  multi-KB blobs. The full result is still in the OpenAI loop. */
const RESULT_PREVIEW_MAX = 600;
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

/** Run one chat turn. `history` should already include the latest
 *  user message at the end. Returns Galt's reply text plus the
 *  model, usage, tool call record. */
export async function chatTurn(history: ChatTurnMessage[]): Promise<ChatTurnResult> {
  const systemPrompt = buildSystemPrompt();
  const messages = toOpenAIMessages(history);

  const result = await chatWithTools({
    systemPrompt,
    messages,
    tools: CHAT_TOOLS,
    purpose: 'galt_chat',
    temperature: 0.7,
    maxTokens: 800,
    maxRounds: 6,
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

  // 3. Run the turn.
  const result = await chatTurn(history);

  // 4. Append Galt's reply (with any tool calls so the companion can
  //    render them).
  const galtMsgRef = messagesRef.push();
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
    galt_message_id: galtMsgRef.key as string,
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
