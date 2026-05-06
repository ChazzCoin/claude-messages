import OpenAI from 'openai';
import { config } from './config.js';
import type { MessageRow } from './db/messages.js';

let _client: OpenAI | null = null;

export function isAIConfigured(): boolean {
  return !!config.openai.apiKey;
}

export function getOpenAI(): OpenAI {
  if (!config.openai.apiKey) {
    throw new Error('OPENAI_API_KEY is not set in .env');
  }
  if (!_client) _client = new OpenAI({ apiKey: config.openai.apiKey });
  return _client;
}

/* ------------------------------------------------------------------ */
/* classification — Phase 3 fast lane                                  */
/* ------------------------------------------------------------------ */

export type Category = 'question' | 'scheduling' | 'urgent' | 'casual' | 'other';

export interface ClassificationResult {
  shouldRespond: boolean;
  category: Category;
  confidence: number;
  reasoning: string;
}

const CLASSIFY_SYSTEM = `You are an iMessage triage assistant. Given a single incoming message, decide whether the recipient should respond, what kind of message it is, and your confidence.

Categories (pick exactly one):
- "question"   — direct or implicit question requiring an answer
- "scheduling" — proposing or confirming a time/place/availability
- "urgent"     — time-sensitive, emergency, or critical action needed
- "casual"     — banter, reactions, small talk; no response needed
- "other"      — informational, statement, doesn't fit above

Respond ONLY with JSON of this exact shape:
{
  "shouldRespond": boolean,
  "category": "question" | "scheduling" | "urgent" | "casual" | "other",
  "confidence": number between 0 and 1,
  "reasoning": "one short sentence"
}`;

export async function classifyIncoming(text: string): Promise<ClassificationResult> {
  const client = getOpenAI();
  const resp = await client.chat.completions.create({
    model: config.openai.model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: CLASSIFY_SYSTEM },
      { role: 'user', content: `Message: ${text}` },
    ],
    max_tokens: 200,
    temperature: 0.2,
  });
  const raw = resp.choices[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(raw);
  if (
    typeof parsed.shouldRespond !== 'boolean' ||
    typeof parsed.category !== 'string' ||
    typeof parsed.confidence !== 'number'
  ) {
    throw new Error(`classifier returned malformed JSON: ${raw}`);
  }
  return parsed as ClassificationResult;
}

/* ------------------------------------------------------------------ */
/* drafting — Phase 4 generation                                       */
/* ------------------------------------------------------------------ */

const DRAFT_SYSTEM = `You are predicting the user's most likely next reply in this iMessage thread. You are writing AS the user — match their voice exactly. Don't draft what a generic helpful person would say; draft what THIS specific user would actually type.

Study the user's prior messages (lines starting with "me:") to learn their style:
- Capitalization habits (all lowercase, Title case, mixed, sentence case)
- Reply length (terse one-liners vs. longer messages)
- Punctuation (periods or none, ellipses, dashes, exclamations)
- Emoji density and which ones they actually use
- Casual quirks (slang, abbreviations, "lol", "haha", "lmao", swears)
- Tone toward THIS specific contact (warm, dry, sarcastic, businesslike)

Constraints:
- Plain text only — no quoting, no JSON, no commentary.
- Length should match the user's typical reply length in this thread.
- No greetings or signoffs unless the user uses them.
- Don't fabricate specific facts (times, addresses, numbers, names) the thread doesn't establish — write what the user would write while deferring on the unknowns ("let me check and get back to you").
- Don't be more polite or formal than the user is. Don't sound like a customer-service bot.

If you genuinely cannot predict an appropriate reply (sensitive topic, missing personal info, recipient asked for something only the user can decide), respond with literally: SKIP

Output ONLY the predicted reply text — no preamble, no quotes, no explanation.`;

export interface ThreadTurn {
  author: 'me' | 'them';
  text: string;
}

export interface DraftReplyInput {
  thread: ThreadTurn[];
  contextNote?: string;
}

export interface DraftReplyResult {
  body: string;
  skipped: boolean;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  model: string;
}

export async function draftReply(input: DraftReplyInput): Promise<DraftReplyResult> {
  const client = getOpenAI();
  const threadText = input.thread.map((m) => `${m.author}: ${m.text}`).join('\n');
  const note = input.contextNote?.trim();
  const userContent = note
    ? `Thread (oldest → newest):\n${threadText}\n\nUser's guidance for this specific reply (factor this in while still matching their voice): ${note}`
    : `Thread (oldest → newest):\n${threadText}`;

  const resp = await client.chat.completions.create({
    model: config.openai.model,
    messages: [
      { role: 'system', content: DRAFT_SYSTEM },
      { role: 'user', content: userContent },
    ],
    max_tokens: 300,
    temperature: 0.7,
  });

  const raw = (resp.choices[0]?.message?.content ?? '').trim();
  const usage = resp.usage
    ? {
        prompt_tokens: resp.usage.prompt_tokens,
        completion_tokens: resp.usage.completion_tokens,
        total_tokens: resp.usage.total_tokens,
      }
    : undefined;
  const model = resp.model || config.openai.model;

  if (raw === 'SKIP' || raw === '') return { body: '', skipped: true, usage, model };

  // Strip leading/trailing quotes the model sometimes adds.
  const body = raw.replace(/^["']|["']$/g, '').trim();
  return { body, skipped: false, usage, model };
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const OBJ_REPLACEMENT_CHAR = '￼'; // Apple's attachment placeholder

export function isMeaningfulMessageText(text: string | null | undefined): boolean {
  if (!text) return false;
  const stripped = text.replace(new RegExp(OBJ_REPLACEMENT_CHAR, 'g'), '').trim();
  return stripped.length > 0;
}

/**
 * Convert a list of MessageRow (from chat.db, DESC by date) into a
 * chronological thread of `me`/`them` turns suitable for prompting.
 * Drops attachment-only and undecodable rows; collapses adjacent turns
 * from the same author with newlines so the LLM sees one block per speaker.
 */
export function buildThreadFromMessages(messagesDesc: MessageRow[]): ThreadTurn[] {
  const ascending = messagesDesc.slice().reverse();
  const turns: ThreadTurn[] = [];
  for (const m of ascending) {
    if (!isMeaningfulMessageText(m.text)) continue;
    const author: 'me' | 'them' = m.is_from_me === 1 ? 'me' : 'them';
    const text = m.text!.trim();
    const last = turns[turns.length - 1];
    if (last && last.author === author) {
      last.text = `${last.text}\n${text}`;
    } else {
      turns.push({ author, text });
    }
  }
  return turns;
}
