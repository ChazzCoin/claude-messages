// Galt direct-chat — Phase 1: conversation only, no tool use yet.
//
// The companion PWA opens a chat surface where the user talks directly
// to Galt. Each user turn fires a `galt_chat` RTDB command → backend
// calls chatTurn() here → response appended back to RTDB → companion
// renders the new message. No tools yet; Galt has no read/write access
// to chat.db, calendar, etc. through this path. Add function-calling
// in Phase 2.
//
// Voice: pulls settings.galt_voice_profile so the chat-Galt sounds
// like Galt elsewhere (away replies, summon replies). One voice
// across every mode.
//
// History shape: { role: 'user' | 'galt', text } — keeps things small.
// Higher-fidelity fields (model, usage, ts) ride alongside on the
// RTDB record but aren't passed to the model.

import { chat } from './client.js';
import { getSettings } from '../db/app.js';

/** One message in the running conversation, as the model sees it. */
export interface ChatTurnMessage {
  role: 'user' | 'galt';
  text: string;
}

export interface ChatTurnResult {
  reply: string;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

const SYSTEM_PROMPT_BASE = `You are GALT — the user's personal AI assistant. The user is messaging you DIRECTLY through their companion device (the same UI that handles iMessage triage, away mode, summon mode). This is NOT a thread with a contact; this IS a direct line between you and the user.

Your job here:
- Be a sharp, helpful thinking partner. The user asks questions, brainstorms, drafts things, gets unstuck.
- Speak in Galt's voice (see voice profile below). Same voice the user has heard you use everywhere else.
- iMessage-rhythm replies — usually short, occasionally longer when the topic earns it. No padding. No customer-service phrasings ("happy to help", "as an AI", etc.).
- Plain text only. No JSON, no preamble, no quotes around your reply.

You DO NOT currently have tools — you cannot search the user's messages, read their calendar, send messages on their behalf, or check who they've talked to recently. That's coming in a later phase. If the user asks you to do something that requires accessing data outside this conversation, say so plainly: "I don't have that hooked up yet — coming in the next phase. For now I can help with X." Don't make up data you don't have.

If the user just wants to chat, banter, brainstorm, or draft — do that. You're useful even without tools.`;

function buildSystemPrompt(): string {
  const voice = (getSettings().galt_voice_profile || '').trim();
  if (!voice) return SYSTEM_PROMPT_BASE;
  return `${SYSTEM_PROMPT_BASE}\n\nGALT'S VOICE — how you sound when speaking. Apply throughout.\n"""\n${voice}\n"""`;
}

/** Format the conversation history as a single user-role string,
 *  oldest → newest, latest user message last. By framework
 *  convention everywhere else, the latest line is the freshest in
 *  attention — same rule here. */
function formatHistory(history: ChatTurnMessage[]): string {
  if (history.length === 0) {
    // Empty history shouldn't happen in practice — the command
    // appends the user's incoming message before calling chatTurn —
    // but defend against it.
    return 'You: (no message)';
  }
  return history
    .map((m) => (m.role === 'user' ? 'You' : 'Galt') + ': ' + m.text)
    .join('\n');
}

/** Run one chat turn. `history` should already include the latest
 *  user message at the end. Returns Galt's reply text plus the
 *  model + usage that produced it. */
export async function chatTurn(history: ChatTurnMessage[]): Promise<ChatTurnResult> {
  const systemPrompt = buildSystemPrompt();
  const userContent = formatHistory(history);

  const result = await chat({
    systemPrompt,
    userContent,
    purpose: 'galt_chat',
    count: 1,
    temperature: 0.7,
    maxTokens: 600,
  });

  const variant = result.variants.find((v) => !v.skipped && v.body.trim().length > 0);
  // Galt-chat never SKIPs — the user is talking TO Galt. If the model
  // returns nothing usable, fall back to a polite hedge so the chat
  // doesn't dead-end.
  const reply = variant?.body || "Hm, I got nothing useful that turn. Try rephrasing?";

  return {
    reply,
    model: result.model,
    usage: result.usage,
  };
}
