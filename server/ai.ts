import OpenAI from 'openai';
import { config } from './config.js';
import { getSettings } from './db/app.js';
import type { MessageRow } from './db/messages.js';

/**
 * The OpenAI API key can come from two places, settings wins:
 *   1. app.db settings.openai_api_key  (set via the dashboard's Settings page)
 *   2. process.env.OPENAI_API_KEY      (set via .env, picked up at boot)
 *
 * Source #1 lets users configure AI from the UI without editing files.
 * Source #2 is the historical/dev path and a fallback if app.db is fresh.
 */
function effectiveApiKey(): string {
  const fromSettings = getSettings().openai_api_key?.trim();
  if (fromSettings) return fromSettings;
  return config.openai.apiKey;
}

export function effectiveModel(): string {
  const fromSettings = getSettings().openai_model?.trim();
  if (fromSettings) return fromSettings;
  return config.openai.model;
}

/** Where is the active key coming from? Useful for /api/health + UI. */
export function apiKeySource(): 'settings' | 'env' | 'none' {
  if (getSettings().openai_api_key?.trim()) return 'settings';
  if (config.openai.apiKey) return 'env';
  return 'none';
}

// Cache the OpenAI client per-key so a settings change invalidates it
// without needing a service restart.
let _client: OpenAI | null = null;
let _clientForKey: string | null = null;

export function isAIConfigured(): boolean {
  return !!effectiveApiKey();
}

export function getOpenAI(): OpenAI {
  const key = effectiveApiKey();
  if (!key) {
    throw new Error(
      'OpenAI API key not configured. Add one in Settings → OpenAI, or set OPENAI_API_KEY in .env.',
    );
  }
  if (_client && _clientForKey === key) return _client;
  _client = new OpenAI({ apiKey: key });
  _clientForKey = key;
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
    model: effectiveModel(),
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
/* voice profile — incremental refinement of the user's writing style */
/* ------------------------------------------------------------------ */

const VOICE_PROFILE_SYSTEM = `You are profiling how a specific user writes iMessages so that an AI can later draft replies in their voice. Output a concise prose voice profile (300–600 words) — no JSON, no preamble, no headers required, no markdown bullets unless they help. Be specific and evidence-based. Do NOT invent traits not visible in the data.

Cover (where the data supports it):
- Capitalization habits (all-lowercase, sentence case, mixed)
- Punctuation tendencies (periods? ellipses? em dashes? exclamations?)
- Length / brevity preferences (one-liners vs. paragraphs; per-context)
- Vocabulary, slang, catchphrases, acronyms, signature words
- Profanity usage and which words appear
- Emoji density and which emoji actually show up
- Tone (humor, sarcasm, warmth, terseness, formality)
- Greeting / signoff habits (or absence thereof)
- Per-context shifts you can observe (work vs. friends vs. family)
- Anything else distinctive

When given an EXISTING profile, treat it as prior knowledge: preserve well-grounded observations, refine when new evidence sharpens or contradicts them, and add new patterns visible in the recent sample. Do not throw away good prior insights just because the recent sample is small.`;

export interface VoiceProfileInput {
  /** Current voice profile, if any. Empty string = fresh generation. */
  existing: string;
  /** Optional user-supplied context/guidance (e.g. background, accents, regional notes). */
  userContext: string;
  /** Recent sent messages from the user, oldest first. Used as the evidence corpus. */
  samples: string[];
}

export interface VoiceProfileResult {
  profile: string;
  model: string;
  sampleCount: number;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export async function generateVoiceProfile(input: VoiceProfileInput): Promise<VoiceProfileResult> {
  const client = getOpenAI();
  const corpus = input.samples
    .map((s, i) => `[${i + 1}] ${s.replace(/\n+/g, ' ').trim()}`)
    .join('\n');

  const sections: string[] = [];
  if (input.existing && input.existing.trim()) {
    sections.push(
      `EXISTING PROFILE (refine, don't replace cold — preserve what holds up, sharpen what new evidence supports):\n"""\n${input.existing.trim()}\n"""`,
    );
  }
  if (input.userContext && input.userContext.trim()) {
    sections.push(`USER-SUPPLIED CONTEXT:\n"""\n${input.userContext.trim()}\n"""`);
  }
  sections.push(
    `RECENT SAMPLE (${input.samples.length} of the user's most recent sent messages, oldest first):\n${corpus}`,
  );
  sections.push(
    `Now output the UPDATED voice profile in concise prose. ${
      input.existing ? 'Build on the existing profile; do not start over.' : 'Generate a fresh profile.'
    }`,
  );

  const resp = await client.chat.completions.create({
    model: effectiveModel(),
    messages: [
      { role: 'system', content: VOICE_PROFILE_SYSTEM },
      { role: 'user', content: sections.join('\n\n') },
    ],
    max_tokens: 900,
    temperature: 0.3,
  });

  const profile = (resp.choices[0]?.message?.content ?? '').trim();
  const usage = resp.usage
    ? {
        prompt_tokens: resp.usage.prompt_tokens,
        completion_tokens: resp.usage.completion_tokens,
        total_tokens: resp.usage.total_tokens,
      }
    : undefined;
  return {
    profile,
    model: resp.model || effectiveModel(),
    sampleCount: input.samples.length,
    usage,
  };
}

/* ------------------------------------------------------------------ */
/* summarize — quick TL;DR of a thread                                 */
/* ------------------------------------------------------------------ */

const SUMMARIZE_SYSTEM = `You are summarizing recent iMessages for the user.

Output a tight bullet-point digest of what was actually said and what (if anything) needs the user's attention. Be honest — if the thread is just banter or has no substance, say that in one line.

Format:
- 2–7 bullet points covering the main topics or asks (markdown "-" bullets are fine)
- Group by topic when distinct things happened
- Skip greetings, pleasantries, and trivia unless they matter
- For anything that needs a response, end the bullet with "→ needs reply"
- No preamble, no closing — just the bullets

Plain text only — no JSON, no headers.`;

export interface SummarizeInput {
  thread: ThreadTurn[];
}

export interface SummarizeResult {
  summary: string;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export async function summarizeThread(input: SummarizeInput): Promise<SummarizeResult> {
  const client = getOpenAI();
  const threadText = input.thread
    .map((m) => `${m.author === 'me' ? 'me' : m.attribution ? `them (${m.attribution})` : 'them'}: ${m.text}`)
    .join('\n');

  const resp = await client.chat.completions.create({
    model: effectiveModel(),
    messages: [
      { role: 'system', content: SUMMARIZE_SYSTEM },
      { role: 'user', content: `Recent thread (oldest → newest):\n${threadText}\n\nSummarize.` },
    ],
    max_tokens: 600,
    temperature: 0.3,
  });

  const summary = (resp.choices[0]?.message?.content ?? '').trim();
  const usage = resp.usage
    ? {
        prompt_tokens: resp.usage.prompt_tokens,
        completion_tokens: resp.usage.completion_tokens,
        total_tokens: resp.usage.total_tokens,
      }
    : undefined;
  return { summary, model: resp.model || effectiveModel(), usage };
}

/* ------------------------------------------------------------------ */
/* radar — per-contact memory bank: extract signals + distill profile  */
/* ------------------------------------------------------------------ */

export const RADAR_CATEGORIES_SET = new Set([
  'likes',
  'dislikes',
  'wants',
  'obsessed',
  'schedule',
  'vacation',
  'gifts',
  'family',
  'health',
  'work',
  'other',
]);

export type RadarCategoryAI =
  | 'likes' | 'dislikes' | 'wants' | 'obsessed' | 'schedule'
  | 'vacation' | 'gifts' | 'family' | 'health' | 'work' | 'other';

export interface RadarSignalExtract {
  category: RadarCategoryAI;
  content: string;
  confidence: number;
}

const RADAR_EXTRACT_SYSTEM = `You are extracting durable facts about a specific person from a single iMessage they sent. The output feeds a long-term memory bank the user keeps about this contact — a "radar" of who they are, what they like, what they want, what's coming up, etc.

Extract ONLY facts that say something LASTING — things still relevant a week from now. Skip:
- Transient logistics ("running 5 min late", "be there in a bit")
- Pure banter, jokes, reactions
- Things about the user (this is about the SENDER)
- One-off small talk

Categories (pick exactly one per signal):
- "likes"     — things they enjoy / are into
- "dislikes"  — things they hate / avoid
- "wants"     — concrete things they've expressed wanting
- "obsessed"  — things they're heavily into right now
- "schedule"  — recurring routines, jobs, regular commitments
- "vacation"  — travel plans (past, planned, dreaming about)
- "gifts"     — explicit gift hints or "I would love that" mentions
- "family"    — partner, kids, parents, siblings, pets — names, ages, relationships
- "health"    — medical context worth remembering
- "work"      — job, role, employer, projects
- "other"     — durable but doesn't fit above

Output ONLY JSON of this exact shape (empty array if nothing extractable):
{
  "signals": [
    { "category": "likes" | "dislikes" | ..., "content": "concise third-person statement", "confidence": 0..1 }
  ]
}

Be conservative — false positives pollute the memory bank. When uncertain, skip it.`;

export async function extractRadarSignals(input: { sender: string; messageText: string }): Promise<{
  signals: RadarSignalExtract[];
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}> {
  const client = getOpenAI();
  const resp = await client.chat.completions.create({
    model: effectiveModel(),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: RADAR_EXTRACT_SYSTEM },
      { role: 'user', content: `Sender: ${input.sender}\nMessage: "${input.messageText}"` },
    ],
    max_tokens: 500,
    temperature: 0.2,
  });
  const raw = resp.choices[0]?.message?.content ?? '{}';
  let parsed: { signals?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const arr = Array.isArray(parsed.signals) ? parsed.signals : [];
  const signals: RadarSignalExtract[] = [];
  for (const s of arr as Array<Record<string, unknown>>) {
    const cat = typeof s.category === 'string' ? s.category : '';
    const content = typeof s.content === 'string' ? s.content.trim() : '';
    const conf = typeof s.confidence === 'number' ? Math.max(0, Math.min(1, s.confidence)) : 0.5;
    if (!RADAR_CATEGORIES_SET.has(cat) || !content) continue;
    signals.push({ category: cat as RadarCategoryAI, content, confidence: conf });
  }
  return {
    signals,
    model: resp.model || effectiveModel(),
    usage: resp.usage
      ? {
          prompt_tokens: resp.usage.prompt_tokens,
          completion_tokens: resp.usage.completion_tokens,
          total_tokens: resp.usage.total_tokens,
        }
      : undefined,
  };
}

const RADAR_PROFILE_SYSTEM = `You are maintaining a memory bank about a specific person, used to help the user remember what matters about them.

Take the existing profile (if any), the recent extracted signals (categorized facts from their messages), and any user-supplied notes about this person. Produce an UPDATED narrative profile in concise prose.

Cover these sections WHEN the data supports them — skip a section entirely if there's nothing to say:
- Identity / context (who they are, relationship to user if known)
- Likes / interests / passions
- Dislikes / aversions
- Wants / wishlist / things they've expressed wanting
- Schedule / routines / regular commitments
- Family / important people in their life
- Gift ideas (synthesizing from likes + wants + recent obsessions)
- Vacations / travel
- Health / work / other relevant context

Rules:
- Be specific and evidence-based. Don't invent.
- Mark uncertain inferences as "(possibly)".
- Preserve existing observations when they still hold; refine when new evidence sharpens or contradicts.
- ~300–600 words, plain prose, simple section headers in **bold** are fine. No JSON, no preamble.`;

export interface RadarProfileInput {
  sender: string;
  existingProfile: string;
  signalsByCategory: Record<string, Array<{ content: string; confidence: number; date_ms: number }>>;
  userNotes: string[];
}

export async function distillRadarProfile(input: RadarProfileInput): Promise<{
  profile: string;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}> {
  const client = getOpenAI();

  const sections: string[] = [];
  if (input.existingProfile && input.existingProfile.trim()) {
    sections.push(
      `EXISTING PROFILE (refine, don't replace cold — preserve what holds up):\n"""\n${input.existingProfile.trim()}\n"""`,
    );
  }
  if (input.userNotes && input.userNotes.length > 0) {
    sections.push(
      `USER-SUPPLIED NOTES ABOUT THIS CONTACT:\n${input.userNotes.map((n) => `- ${n}`).join('\n')}`,
    );
  }
  // Signals grouped by category, recent first
  const catLines: string[] = [];
  for (const [cat, sigs] of Object.entries(input.signalsByCategory)) {
    if (!sigs || sigs.length === 0) continue;
    catLines.push(`# ${cat}`);
    for (const s of sigs) {
      const dt = new Date(s.date_ms).toISOString().slice(0, 10);
      catLines.push(`- [${dt} · conf ${s.confidence.toFixed(2)}] ${s.content}`);
    }
    catLines.push('');
  }
  sections.push(
    `RECENT EXTRACTED SIGNALS (grouped by category, newest first):\n${catLines.join('\n') || '(none)'}`,
  );
  sections.push(
    `Now produce the UPDATED memory-bank profile for ${input.sender}. ${
      input.existingProfile ? 'Build on the existing profile; do not start over.' : 'Generate fresh.'
    }`,
  );

  const resp = await client.chat.completions.create({
    model: effectiveModel(),
    messages: [
      { role: 'system', content: RADAR_PROFILE_SYSTEM },
      { role: 'user', content: sections.join('\n\n') },
    ],
    max_tokens: 1200,
    temperature: 0.3,
  });

  const profile = (resp.choices[0]?.message?.content ?? '').trim();
  return {
    profile,
    model: resp.model || effectiveModel(),
    usage: resp.usage
      ? {
          prompt_tokens: resp.usage.prompt_tokens,
          completion_tokens: resp.usage.completion_tokens,
          total_tokens: resp.usage.total_tokens,
        }
      : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* auto-calendar — extract structured event from a scheduling msg      */
/* ------------------------------------------------------------------ */

const CAL_EXTRACT_SYSTEM = `You extract calendar events from iMessages. Run on every message a calendar-monitor rule sees; only flag the message as an event when it clearly commits the user (or sender) to a specific time and/or place.

Output ONLY JSON of this exact shape:
{
  "is_event": boolean,
  "title": "concise event title",
  "start_iso": "YYYY-MM-DDTHH:MM" in local time, or null if not specified,
  "end_iso":   "YYYY-MM-DDTHH:MM" in local time, or null,
  "location":  "..." or null,
  "participants": "comma-separated names" or null,
  "notes": "one short sentence of context",
  "confidence": 0..1,
  "reasoning": "why you think this is/isn't an event"
}

Rules:
- The CURRENT date/time is provided in the user message; use it to resolve relative phrases like "tomorrow", "Friday", "next week", "in an hour".
- If only a date is given (no time), use a reasonable default time and set is_event=true; set end_iso to null and the user can adjust.
- If only a time is given (no date), assume today.
- Vague hangouts without a concrete time ("we should hang soon") → is_event=false.
- Past events being recapped → is_event=false.
- Be conservative on confidence. False positives are worse than missed events.`;

export interface CalendarExtractResult {
  is_event: boolean;
  title: string;
  start_iso: string | null;
  end_iso: string | null;
  location: string | null;
  participants: string | null;
  notes: string;
  confidence: number;
  reasoning: string;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export async function extractCalendarEvent(input: {
  sender: string;
  messageText: string;
  nowIso: string;
  timezone: string;
}): Promise<CalendarExtractResult> {
  const client = getOpenAI();
  const resp = await client.chat.completions.create({
    model: effectiveModel(),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: CAL_EXTRACT_SYSTEM },
      {
        role: 'user',
        content: `Current date/time: ${input.nowIso} (timezone: ${input.timezone})\nSender: ${input.sender}\nMessage: "${input.messageText}"`,
      },
    ],
    max_tokens: 400,
    temperature: 0.2,
  });
  const raw = resp.choices[0]?.message?.content ?? '{}';
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const usage = resp.usage
    ? {
        prompt_tokens: resp.usage.prompt_tokens,
        completion_tokens: resp.usage.completion_tokens,
        total_tokens: resp.usage.total_tokens,
      }
    : undefined;
  return {
    is_event: parsed.is_event === true,
    title: typeof parsed.title === 'string' ? parsed.title : '',
    start_iso: typeof parsed.start_iso === 'string' && parsed.start_iso ? parsed.start_iso : null,
    end_iso: typeof parsed.end_iso === 'string' && parsed.end_iso ? parsed.end_iso : null,
    location: typeof parsed.location === 'string' && parsed.location ? parsed.location : null,
    participants:
      typeof parsed.participants === 'string' && parsed.participants ? parsed.participants : null,
    notes: typeof parsed.notes === 'string' ? parsed.notes : '',
    confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    model: resp.model || effectiveModel(),
    usage,
  };
}

/* ------------------------------------------------------------------ */
/* away notes — extract follow-up items from inbound during away mode  */
/* ------------------------------------------------------------------ */

const AWAY_NOTE_SYSTEM = `You are reviewing an inbound iMessage and deciding whether the user should personally follow up on it. The user reviews the resulting notes later — this is a triage queue.

Things that ARE worth a note:
- Meeting / hangout requests (specific or vague)
- A topic the sender wants to discuss with the user specifically
- Questions only the user can actually answer (technical, personal, decision-making)
- Time-sensitive coordination (date confirmations, deadlines, RSVPs)
- Event invitations
- Plans being made that the user is part of
- Bad news / important news requiring a real reply
- Money / business / legal items

Things that are NOT worth a note:
- Pleasantries, "lol", emoji-only replies, banter
- Generic small talk with no actionable content
- Stuff the user wouldn't recognize as actionable

Be conservative — false positives clutter the note pile and train the user to ignore it. Only flag substantive items.

CATEGORY (life domain — pick exactly one):
- "urgent"   — time-sensitive or critical, needs attention soon (today/tomorrow). Emergencies, hard deadlines, anything where delay has real cost.
- "business" — work, money, contracts, professional matters, vendors, clients, legal, anything career-related.
- "personal" — friends, family, romance, social plans, hobbies, life logistics.

Pick the dominant frame in THIS message. If genuinely ambiguous, default to "personal".

Output ONLY JSON:
{
  "should_note": boolean,
  "summary": "one short sentence in third person, e.g. 'Mallory wants to grab dinner Thursday' or 'Mike asked about the contract status'",
  "category": "urgent" | "business" | "personal",
  "reasoning": "one short sentence explaining why this needs follow-up"
}`;

export type AwayNoteCategoryAI = 'urgent' | 'business' | 'personal';

export interface AwayNoteExtract {
  shouldNote: boolean;
  summary: string;
  category: AwayNoteCategoryAI;
  reasoning: string;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export async function extractAwayNote(input: {
  sender: string;
  messageText: string;
}): Promise<AwayNoteExtract> {
  const client = getOpenAI();
  const resp = await client.chat.completions.create({
    model: effectiveModel(),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: AWAY_NOTE_SYSTEM },
      {
        role: 'user',
        content: `Sender: ${input.sender}\nMessage: "${input.messageText}"`,
      },
    ],
    max_tokens: 250,
    temperature: 0.2,
  });
  const raw = resp.choices[0]?.message?.content ?? '{}';
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const validCats: AwayNoteCategoryAI[] = ['urgent', 'business', 'personal'];
  const cat = (typeof parsed.category === 'string' && (validCats as string[]).includes(parsed.category))
    ? (parsed.category as AwayNoteCategoryAI)
    : 'personal';
  return {
    shouldNote: parsed.should_note === true,
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    category: cat,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    model: resp.model || effectiveModel(),
    usage: resp.usage
      ? {
          prompt_tokens: resp.usage.prompt_tokens,
          completion_tokens: resp.usage.completion_tokens,
          total_tokens: resp.usage.total_tokens,
        }
      : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* monitor rules — per-message AI evaluation against user prompts      */
/* ------------------------------------------------------------------ */

const MONITOR_EVAL_SYSTEM = `You are evaluating an incoming iMessage against a user-defined monitoring rule. Be conservative — only flag when the match is unambiguous. False positives are worse than missed flags.

You will be given:
- A rule (plain English description of what to flag)
- The sender's name or handle
- The message text

Decide: does this message clearly match the rule?

Output ONLY JSON of this exact shape:
{ "match": boolean, "confidence": number between 0 and 1, "reasoning": "one short sentence explaining" }`;

export interface RuleEvalInput {
  rulePrompt: string;
  sender: string;
  messageText: string;
}

export interface RuleEvalResult {
  match: boolean;
  confidence: number;
  reasoning: string;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export async function evaluateRuleAgainstMessage(input: RuleEvalInput): Promise<RuleEvalResult> {
  const client = getOpenAI();
  const resp = await client.chat.completions.create({
    model: effectiveModel(),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: MONITOR_EVAL_SYSTEM },
      {
        role: 'user',
        content: `Rule: "${input.rulePrompt}"\nSender: ${input.sender}\nMessage: "${input.messageText}"`,
      },
    ],
    max_tokens: 200,
    temperature: 0.2,
  });
  const raw = resp.choices[0]?.message?.content ?? '{}';
  let parsed: { match?: unknown; confidence?: unknown; reasoning?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  return {
    match: parsed.match === true,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    model: resp.model || effectiveModel(),
    usage: resp.usage
      ? {
          prompt_tokens: resp.usage.prompt_tokens,
          completion_tokens: resp.usage.completion_tokens,
          total_tokens: resp.usage.total_tokens,
        }
      : undefined,
  };
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

export const TEMPERAMENTS = [
  'normal',
  'warm',
  'casual',
  'professional',
  'enthusiastic',
  'apologetic',
  'snarky',
  'blunt',
  'angry',
  'sad',
  'aggressive',
] as const;
export type Temperament = (typeof TEMPERAMENTS)[number];

const TEMPERAMENT_GUIDANCE: Record<Temperament, string> = {
  normal: '',
  warm:
    'Lean noticeably warmer/more personable than the user\'s baseline — softer phrasing, a touch of care, but still in-voice.',
  casual:
    'Lean more casual than the user\'s baseline — looser, less polished, more conversational.',
  professional:
    'Lean more professional than the user\'s baseline — fewer abbreviations, cleaner punctuation, more measured. Still recognizably them.',
  enthusiastic:
    'Higher energy than baseline — more positive, more emoji or exclamations if the user ever uses them at all, but don\'t fake it if they never do.',
  apologetic:
    'Self-effacing and accommodating — own the inconvenience, but only as much as the user actually does. Don\'t over-apologize.',
  snarky:
    'Drier and more sardonic than baseline — light sarcasm, gentle ribbing, in the user\'s voice. Not mean.',
  blunt:
    'More direct and terser than baseline — no padding, no qualifiers, get to the point.',
  angry:
    'Visibly irritated. Terse, sharp, no warmth. Stop short of cruelty or insults — the user wants to express frustration, not blow up the relationship.',
  sad: 'Subdued, lower energy, somber tone. Less emoji and exclamations than baseline. Honest about feeling off if the thread invites it.',
  aggressive:
    'Confrontational — willing to push back hard, challenge the other person\'s premise, demand more. Still the user\'s voice; do not insult or threaten.',
};

export interface ThreadTurn {
  /** 'me' for user-sent, 'them' for incoming. */
  author: 'me' | 'them';
  text: string;
  /** Optional name attribution — used in group chats so the model knows who said what. */
  attribution?: string;
}

export interface DraftReplyInput {
  thread: ThreadTurn[];
  /** User's freeform hint for THIS draft (e.g. "tell them I'm running 15 min late"). */
  contextNote?: string;
  /** Distilled prose voice profile from generateVoiceProfile(). Empty / undefined = skip. */
  voiceProfile?: string;
  /** Per-contact memory notes (relationship intel for THIS recipient). Each is a separate note. */
  contactNotes?: string[];
  /** User-written long-form prose about this contact: identity, relationship,
   *  sensitivities, how to talk to them. Distinct from contactNotes (short
   *  bullets) — this is the "who you're talking to" identity block. */
  contactProfile?: string;
  /** AddressBook record for this contact, formatted (role, birthday, notes
   *  the user wrote in Contacts.app). Distinct from contactProfile — this is
   *  *latent* identity context the user already stored elsewhere, surfaced
   *  to the model so it doesn't need to ask "remind me what they do". */
  addressBookContext?: string;
  /** User's calendar context (events in a window around now), pre-formatted.
   *  Lets the model answer "are you free Thursday" etc. without inventing. */
  userAvailability?: string;
  /** Tone override for this draft. 'normal' = baseline. */
  temperament?: Temperament;
  /** How many variants to generate (1..5). Defaults to 1. */
  count?: number;
  /** When true, append a hard guardrail forbidding any commitment on the
   *  user's behalf. Use this for fully-autonomous auto-reply paths (away
   *  mode) where the draft is sent without the user's review. */
  awayMode?: boolean;
}

export interface DraftVariant {
  body: string;
  skipped: boolean;
}

export interface DraftReplyResult {
  variants: DraftVariant[];
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function buildSystemPrompt(
  voiceProfile: string | undefined,
  contactNotes: string[] | undefined,
  contactProfile: string | undefined,
  addressBookContext: string | undefined,
  userAvailability: string | undefined,
  temperament: Temperament,
  awayMode: boolean,
): string {
  const parts: string[] = [DRAFT_SYSTEM];
  if (voiceProfile && voiceProfile.trim()) {
    parts.push(
      `\nVOICE PROFILE — the user's general writing style, established from prior analysis. Apply throughout (the immediate thread can refine, but this is the baseline):\n"""\n${voiceProfile.trim()}\n"""`,
    );
  }
  if (contactProfile && contactProfile.trim()) {
    parts.push(
      `\nWHO YOU'RE TALKING TO — the user's own description of this contact: relationship, identity, sensitivities, and how they want you to interact with this person. This OVERRIDES generic defaults — match the tone and posture this profile implies, even when the voice profile would suggest otherwise:\n"""\n${contactProfile.trim()}\n"""`,
    );
  }
  if (addressBookContext && addressBookContext.trim()) {
    parts.push(
      `\nADDRESS BOOK CONTEXT — what the user has saved about this contact in macOS Contacts.app (role, birthday, free-form notes). This is latent context the user already wrote down. Use it to ground the reply, but don't volunteer these facts unprompted — they're for YOUR situational awareness, not facts to recite back:\n"""\n${addressBookContext.trim()}\n"""`,
    );
  }
  if (userAvailability && userAvailability.trim()) {
    parts.push(
      `\nUSER'S CALENDAR (from macOS Calendar.app — aggregates iCloud, Google, Exchange). Use ONLY when the thread asks about the user's availability or schedule (e.g. "are you free Thursday", "what time works"). Do NOT volunteer calendar contents; do NOT invent events not listed here. If the thread doesn't ask about scheduling, ignore this block:\n"""\n${userAvailability.trim()}\n"""`,
    );
  }
  if (contactNotes && contactNotes.length > 0) {
    const lines = contactNotes
      .map((n) => n.trim())
      .filter((n) => n.length > 0)
      .map((n) => `- ${n}`);
    if (lines.length > 0) {
      parts.push(
        `\nNOTES ABOUT THIS CONTACT (recent atomic facts — apply when drafting; the most recent notes near the bottom are most current):\n${lines.join('\n')}`,
      );
    }
  }
  const guidance = TEMPERAMENT_GUIDANCE[temperament];
  if (temperament !== 'normal' && guidance) {
    parts.push(`\nTEMPERAMENT FOR THIS DRAFT: ${temperament}\n${guidance}`);
  }
  if (awayMode) {
    parts.push(
      `\nAWAY-MODE GUARDRAIL — CRITICAL. This draft will be sent automatically without the user's review. The user has not authorized any specific response.

YOU MAY:
- State factual availability the user's calendar shows ("calendar's blocked at 9am", "calendar's open Thursday evening").
- Defer the decision back to the user ("he'll get back to you on that", "let me have him confirm when he's back", "I'll let him know").
- Acknowledge the message conversationally without committing to anything.

YOU MUST NOT:
- Accept proposals or commit to plans. NEVER write "yes that works", "sounds good", "sure", "see you then", "locked in", or any other commitment phrase.
- Decline definitively beyond a calendar fact. State "calendar's blocked" — do NOT say "no I can't" / "won't be able to" / "not gonna happen" — those are still commitments the user hasn't authorized.
- Propose specific times or alternatives. NEVER write "how about Thursday at 3?", "let's do Friday instead", or any concrete counter-offer.
- Confirm RSVPs, plans, prices, addresses, or decisions on the user's behalf.
- Invent facts about the user's day, location, mood, or whereabouts.

When the recipient asks you to commit to anything: state any factual availability you have, then defer to the user. The user reviews a notes queue later — anything you defer becomes their note to follow up on. That's the design.

When in doubt: defer.`,
    );
  }
  return parts.join('\n');
}

export async function draftReply(input: DraftReplyInput): Promise<DraftReplyResult> {
  const client = getOpenAI();
  const threadText = input.thread
    .map((m) => {
      const speaker = m.author === 'me' ? 'me' : m.attribution ? `them (${m.attribution})` : 'them';
      return `${speaker}: ${m.text}`;
    })
    .join('\n');
  const note = input.contextNote?.trim();
  const userContent = note
    ? `Thread (oldest → newest):\n${threadText}\n\nUser's guidance for this specific reply (factor this in while still matching their voice): ${note}`
    : `Thread (oldest → newest):\n${threadText}`;

  const temperament: Temperament =
    input.temperament && (TEMPERAMENTS as readonly string[]).includes(input.temperament)
      ? input.temperament
      : 'normal';
  const systemPrompt = buildSystemPrompt(
    input.voiceProfile,
    input.contactNotes,
    input.contactProfile,
    input.addressBookContext,
    input.userAvailability,
    temperament,
    input.awayMode === true,
  );
  const requestedCount = Math.max(1, Math.min(5, Math.floor(input.count ?? 1)));

  const resp = await client.chat.completions.create({
    model: effectiveModel(),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    max_tokens: 300,
    temperature: 0.7,
    n: requestedCount,
  });

  const variants: DraftVariant[] = (resp.choices ?? []).map((choice) => {
    const raw = (choice.message?.content ?? '').trim();
    if (raw === 'SKIP' || raw === '') return { body: '', skipped: true };
    const body = raw.replace(/^["']|["']$/g, '').trim();
    return { body, skipped: false };
  });
  // De-duplicate variants when the model returns identical strings.
  const seen = new Set<string>();
  const dedup = variants.filter((v) => {
    const key = v.skipped ? '__SKIP__' : v.body;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const usage = resp.usage
    ? {
        prompt_tokens: resp.usage.prompt_tokens,
        completion_tokens: resp.usage.completion_tokens,
        total_tokens: resp.usage.total_tokens,
      }
    : undefined;
  const model = resp.model || effectiveModel();

  return { variants: dedup.length ? dedup : variants, model, usage };
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
    // Capture WHO said this — name when AddressBook resolved it, else the
    // raw handle. Used by the prompt builder to label group-chat turns.
    const attribution =
      author === 'them' ? m.contact_name || m.handle || undefined : undefined;
    const last = turns[turns.length - 1];
    if (last && last.author === author && last.attribution === attribution) {
      last.text = `${last.text}\n${text}`;
    } else {
      turns.push({ author, text, attribution });
    }
  }
  // 1:1 chat shortcut: if there's only one distinct 'them' attribution, drop
  // the per-turn label — the system prompt's "talking to X" line carries it
  // and we'd otherwise spam `them (X):` on every line, wasting tokens and
  // making the prompt noisy.
  const uniqueThemAttrs = new Set(
    turns.filter((t) => t.author === 'them' && t.attribution).map((t) => t.attribution),
  );
  if (uniqueThemAttrs.size <= 1) {
    for (const t of turns) {
      if (t.author === 'them') t.attribution = undefined;
    }
  }
  return turns;
}
