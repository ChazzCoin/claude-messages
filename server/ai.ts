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

/* generateVoiceProfile and the user-voice-distillation feature were
   retired when Galt became the system-wide AI voice. The Galt voice is
   now user-written prose (galt_voice_profile setting) — no AI
   distillation. Old voice_profile data still on disk in app.db; see
   CLAUDE.md and server/db/app.ts. */

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
/* auto notes — extract follow-up items from every inbound message     */
/* (24/7, mode-agnostic; previously coupled to away mode)              */
/* ------------------------------------------------------------------ */

const AUTO_NOTE_SYSTEM = `You are reviewing an inbound iMessage and deciding whether the user should personally follow up on it. The user reviews the resulting notes later — this is a triage queue.

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

export type AutoNoteCategoryAI = 'urgent' | 'business' | 'personal';

export interface AutoNoteExtract {
  shouldNote: boolean;
  summary: string;
  category: AutoNoteCategoryAI;
  reasoning: string;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export async function extractAutoNote(input: {
  sender: string;
  messageText: string;
}): Promise<AutoNoteExtract> {
  const client = getOpenAI();
  const resp = await client.chat.completions.create({
    model: effectiveModel(),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: AUTO_NOTE_SYSTEM },
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
  const validCats: AutoNoteCategoryAI[] = ['urgent', 'business', 'personal'];
  const cat = (typeof parsed.category === 'string' && (validCats as string[]).includes(parsed.category))
    ? (parsed.category as AutoNoteCategoryAI)
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

/* ------------------------------------------------------------------ */
/* prompt defaults — every hardcoded prompt fragment is named here so  */
/* the user can see and override each via Settings → Galt → Prompts.   */
/* These are the FALLBACK values used when the matching settings field */
/* is empty. Setting names follow the pattern prompt_* (full system    */
/* prompts) and wrapper_* (templates around data-injection blocks).    */
/* ------------------------------------------------------------------ */

export const DEFAULT_DRAFT_SYSTEM = `You are GALT — an AI assistant acting on behalf of the user in this iMessage thread. The runtime auto-prefixes everything you say with "Galt: " before sending, so the recipient knows when they're hearing from the AI vs. from the user directly. Speak in Galt's voice (see voice profile below); do NOT impersonate the user.

The user typed messages in this thread are labeled "me:" — those are the user, in their own voice. Lines that look like "me: Galt: ..." are YOUR previous turns in this thread (the runtime prefixed them on send). Use them to track what you've already said.

Constraints:
- Plain text only — no quoting, no JSON, no commentary.
- Match the rhythm of an iMessage chat — usually short, occasionally longer when the topic earns it. Don't lecture, don't pad.
- Don't open with "Hi [name]" or close with sign-offs. iMessage doesn't work like email.
- Don't fabricate specific facts (times, addresses, numbers, names) the thread doesn't establish. When you don't know, say so plainly and offer to follow up — "I'll check with him" / "let me get back to you on that."
- Don't sound like customer service. No "happy to help", no "thank you for reaching out", no "apologies for the inconvenience".
- Match the contact's energy: playful with playful, direct with direct, terse with terse.

If you genuinely cannot draft an appropriate reply (sensitive topic, missing personal info, recipient asked for something only the user can decide), respond with literally: SKIP

Output ONLY the reply text — no "Galt: " prefix (the runtime adds it), no preamble, no quotes, no explanation.`;

export const DEFAULT_WRAPPER_VOICE_PROFILE = `\nGALT'S VOICE — how Galt sounds when speaking. Apply throughout. This is the baseline tone; the immediate thread can adjust register (more casual with friends, more measured in serious moments) but the voice underneath stays Galt:\n"""\n{body}\n"""`;

export const DEFAULT_WRAPPER_CONTACT_PROFILE = `\nWHO YOU'RE TALKING TO — the user's own description of this contact: relationship, identity, sensitivities, and how they want you to interact with this person. This OVERRIDES generic defaults — match the tone and posture this profile implies, even when the voice profile would suggest otherwise:\n"""\n{body}\n"""`;

export const DEFAULT_WRAPPER_ADDRESS_BOOK = `\nADDRESS BOOK CONTEXT — what the user has saved about this contact in macOS Contacts.app (role, birthday, free-form notes). This is latent context the user already wrote down. Use it to ground the reply, but don't volunteer these facts unprompted — they're for YOUR situational awareness, not facts to recite back:\n"""\n{body}\n"""`;

export const DEFAULT_WRAPPER_CALENDAR = `\nUSER'S CALENDAR (from macOS Calendar.app — aggregates iCloud, Google, Exchange). Use ONLY when the thread asks about the user's availability or schedule (e.g. "are you free Thursday", "what time works"). Do NOT volunteer calendar contents; do NOT invent events not listed here. If the thread doesn't ask about scheduling, ignore this block:\n"""\n{body}\n"""`;

export const DEFAULT_WRAPPER_CONTACT_NOTES = `\nNOTES ABOUT THIS CONTACT (recent atomic facts — apply when drafting; the most recent notes near the bottom are most current):\n{body}`;

export const DEFAULT_WRAPPER_TEMPERAMENT = `\nTEMPERAMENT FOR THIS DRAFT: {temperament}\n{guidance}`;

export const DEFAULT_WRAPPER_AWAY_PERSONA = `\nCOVER-MODE BEHAVIOR HINTS — explicit guidance from the user for how Galt should behave while covering (apply on top of Galt's voice profile — these tune banter level, deflection style, jokes for this user's preferred cover-mode feel):\n"""\n{body}\n"""`;

export const DEFAULT_AWAY_GUARDRAIL = `\nAWAY-MODE GUARDRAIL — CRITICAL. This draft will be sent automatically without the user's review. The user has not authorized any specific response.

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

When in doubt: defer.`;

/** Substitute {key} placeholders in a template. Unmatched keys stay as-is.
 *  Used both inside the AI layer (data-injection wrappers) and exported for
 *  callers that need to render user-overridable prompts (e.g. away/summon
 *  full-prompt overrides with {recipientName}, {persona} placeholders). */
export function applyTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.split(`{${key}}`).join(value);
  }
  return result;
}

/** Canonical list of every placeholder available in user-editable prompt
 *  templates. Single source of truth for both the AI layer and the UI's
 *  "Available placeholders" reference panel. */
export const PLACEHOLDER_KEYS = [
  'messages',
  'userName',
  'recipientName',
  'persona',
  'voice_profile',
  'contact_profile',
  'address_book',
  'calendar',
  'contact_notes',
  'temperament',
  'guidance',
  'body',
] as const;

/** Build the universal placeholder context applied to every editable
 *  prompt template. Empty strings for absent data — the model just sees
 *  the placeholder collapse to nothing. `body` is overridden per-wrapper. */
export function buildPlaceholderContext(opts: {
  messages?: string;
  userName?: string;
  recipientName?: string;
  persona?: string;
  voiceProfile?: string;
  contactProfile?: string;
  addressBookContext?: string;
  userAvailability?: string;
  contactNotes?: string[];
  temperament?: string;
  guidance?: string;
}): Record<string, string> {
  const notesText = (opts.contactNotes ?? [])
    .map((n) => n.trim())
    .filter((n) => n.length > 0)
    .map((n) => `- ${n}`)
    .join('\n');
  return {
    messages: opts.messages ?? '',
    userName: opts.userName ?? '',
    recipientName: opts.recipientName ?? '',
    persona: opts.persona ?? '',
    voice_profile: (opts.voiceProfile ?? '').trim(),
    contact_profile: (opts.contactProfile ?? '').trim(),
    address_book: (opts.addressBookContext ?? '').trim(),
    calendar: (opts.userAvailability ?? '').trim(),
    contact_notes: notesText,
    temperament: opts.temperament ?? 'normal',
    guidance: opts.guidance ?? '',
    body: '',
  };
}

/** Map of every prompt/wrapper default — used by /api/settings to expose
 *  the current default text to the UI alongside the editable settings. */
export const PROMPT_DEFAULTS = {
  prompt_draft_system: DEFAULT_DRAFT_SYSTEM,
  prompt_away_guardrail: DEFAULT_AWAY_GUARDRAIL,
  wrapper_voice_profile: DEFAULT_WRAPPER_VOICE_PROFILE,
  wrapper_contact_profile: DEFAULT_WRAPPER_CONTACT_PROFILE,
  wrapper_address_book: DEFAULT_WRAPPER_ADDRESS_BOOK,
  wrapper_calendar: DEFAULT_WRAPPER_CALENDAR,
  wrapper_contact_notes: DEFAULT_WRAPPER_CONTACT_NOTES,
  wrapper_temperament: DEFAULT_WRAPPER_TEMPERAMENT,
  wrapper_away_persona: DEFAULT_WRAPPER_AWAY_PERSONA,
} as const;

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
  /** Galt's voice profile (galt_voice_profile setting) — user-written prose
   *  describing how Galt sounds. Used by every AI call (away · summon ·
   *  manual). Empty / undefined = skip the wrapper. */
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
  /** User-controlled prompt/wrapper overrides. Pass the relevant fields
   *  from getSettings(); each falls back to the matching DEFAULT_* code
   *  constant when empty. Omit the whole object to use defaults for
   *  everything (older callers that haven't been migrated). */
  promptOverrides?: PromptOverrides;
  /** Variables substituted into every editable prompt template alongside
   *  the data inputs (voiceProfile, contactProfile, etc.). Caller passes
   *  raw templates — substitution happens once, here. Map keys match the
   *  exposed placeholder names (userName, recipientName, persona). */
  templateVars?: {
    userName?: string;
    recipientName?: string;
    persona?: string;
  };
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

/** Subset of AppSettings the AI layer reads for prompt customization.
 *  Each field is optional/empty to fall back to the matching DEFAULT_* code
 *  constant. Decoupled from the full AppSettings to keep this module's
 *  contract narrow. */
export interface PromptOverrides {
  prompt_draft_system?: string;
  prompt_away_guardrail?: string;
  wrapper_voice_profile?: string;
  wrapper_contact_profile?: string;
  wrapper_address_book?: string;
  wrapper_calendar?: string;
  wrapper_contact_notes?: string;
  wrapper_temperament?: string;
  wrapper_away_persona?: string;
}

/** Pick the override if non-empty, else the code default. Trims so a
 *  whitespace-only setting still falls back. */
function pickPrompt(override: string | undefined, fallback: string): string {
  return override && override.trim() ? override : fallback;
}

/** Resolve the templates that will actually be used (override-or-default)
 *  for each slot — same logic everywhere we need to enumerate "what goes
 *  into the system prompt for this call." Used both during assembly and
 *  for {messages}-placeholder detection. */
function resolveTemplates(overrides: PromptOverrides) {
  return {
    draft_system:       pickPrompt(overrides.prompt_draft_system,       DEFAULT_DRAFT_SYSTEM),
    away_guardrail:     pickPrompt(overrides.prompt_away_guardrail,     DEFAULT_AWAY_GUARDRAIL),
    voice_profile:      pickPrompt(overrides.wrapper_voice_profile,     DEFAULT_WRAPPER_VOICE_PROFILE),
    contact_profile:    pickPrompt(overrides.wrapper_contact_profile,   DEFAULT_WRAPPER_CONTACT_PROFILE),
    address_book:       pickPrompt(overrides.wrapper_address_book,      DEFAULT_WRAPPER_ADDRESS_BOOK),
    calendar:           pickPrompt(overrides.wrapper_calendar,          DEFAULT_WRAPPER_CALENDAR),
    contact_notes:      pickPrompt(overrides.wrapper_contact_notes,     DEFAULT_WRAPPER_CONTACT_NOTES),
    temperament:        pickPrompt(overrides.wrapper_temperament,       DEFAULT_WRAPPER_TEMPERAMENT),
    away_persona:       pickPrompt(overrides.wrapper_away_persona,      DEFAULT_WRAPPER_AWAY_PERSONA),
  };
}

/** Lane for a pipeline node in the runtime + visualization.
 *   - 'pre':       pre-AI literal send (Greeting). Editable but never injected.
 *   - 'universal': always runs in the AI pipeline.
 *   - 'away':      only when awayMode === true.
 *   - 'summon':    only when awayMode === false (i.e. summon mode).
 *   - 'shared':    runs in both modes (the data wrappers).
 *   - 'guardrail': runs LAST in the AI pipeline (away-only by default).
 */
export type PipelineLane = 'pre' | 'universal' | 'away' | 'summon' | 'shared' | 'guardrail';

/** Visual "shape" of a pipeline node — drives card shape + icon on the Galt
 *  page. Types map to runtime semantics imperfectly: 'persona' / 'voice'
 *  nodes can be either editable data inputs (no runtime block) OR wrappers
 *  with a `runtime` block. */
export type PipelineNodeType =
  | 'greeting'   // pre-AI literal first send (no runtime)
  | 'prompt'     // base system-prompt fragment (e.g. universal draft_system)
  | 'context'    // mode-specific contextNote (per-turn instruction)
  | 'persona'    // persona-related (data input OR wrapper)
  | 'voice'      // voice-related data input
  | 'wrapper'    // generic data-injection wrapper template
  | 'guardrail'; // hard-rule guardrail (runs last)

/** Runtime semantics for a pipeline node. Present only on nodes that
 *  contribute to the assembled system prompt. Absent on pre-AI nodes
 *  (Greeting) and pure data-input nodes (Galt voice, away_persona) — those
 *  flow into the runtime via other channels (literal send / draftReply
 *  parameters / placeholder substitution). */
export interface PipelineRuntime {
  /** Which slot in resolveTemplates() yields this stage's template. The
   *  magic string 'context_note' means "use the contextNoteRaw passed by
   *  the caller of buildSystemPrompt" instead of a settings template. */
  templateKey: string;
  /** ctx field whose value becomes `body` for {body} substitution in the
   *  wrapper template. Set on body-wrapper stages; null on stages that
   *  apply the template directly to ctx. */
  bodyField?: string;
  /** ctx field whose presence gates this stage. When set and the field is
   *  empty, the stage skips. Empty / unset = unconditional. */
  conditionField?: string;
  /** Stage only fires when awayMode === true. */
  awayOnly?: boolean;
  /** Stage only fires when awayMode === false (i.e. summon mode). */
  summonOnly?: boolean;
  /** Skip this stage if the contextNote (passed by caller) already includes
   *  this placeholder string. Used by the persona wrapper to avoid
   *  double-injection when the user's custom contextNote uses {persona}. */
  skipIfContextNoteContains?: string;
}

/** Single declaration that drives BOTH the runtime AND the visualization.
 *  Each entry describes:
 *    - identity (id, lane, type, label, desc)
 *    - editable settings (settingsKey, rows, mono, placeholder, showsDefault, isAdvanced)
 *    - runtime semantics (the optional `runtime` block)
 *
 *  Adding a new pipeline stage = add one entry to PIPELINE_STAGES below.
 *  The runtime loop in buildSystemPrompt picks it up automatically; the
 *  Galt page visualization picks it up via /api/settings.pipeline_stages.
 *
 *  The order of entries IS the runtime injection order (for entries with
 *  a `runtime` block). Reorder = rearrange this array. */
export interface PipelineStage {
  /** Stable id — usually matches the settings column name. */
  id: string;
  lane: PipelineLane;
  type: PipelineNodeType;
  /** Short label for the visualization card. */
  label: string;
  /** One-sentence description shown on the card and in tooltips. */
  desc: string;

  /* ---- editable settings (the textarea card on the Galt page) ---- */
  /** Settings key this stage exposes for edit. Optional — a stage might
   *  exist for visualization only with no editable surface, though all
   *  current entries have one. */
  settingsKey?: string;
  /** Textarea height. Default 4. */
  rows?: number;
  /** Render the textarea in monospace. */
  mono?: boolean;
  /** Placeholder text. */
  placeholder?: string;
  /** PROMPT_DEFAULTS key whose text appears in the "view built-in default"
   *  reveal. */
  showsDefault?: string;
  /** Hide this card under an "advanced" expand inside its lane. Used for
   *  things most users won't touch (wrapper templates around data). */
  isAdvanced?: boolean;

  /* ---- runtime: how this stage contributes to system prompt assembly ---- */
  /** Optional. When absent, this node is editable but does NOT participate
   *  in buildSystemPrompt. Used for pre-AI literal sends (Greeting) and
   *  pure data-input nodes (Galt voice, away_persona) — those flow into
   *  runtime through other channels. */
  runtime?: PipelineRuntime;
}

/** ────────────────────────────────────────────────────────────────────
 *  PIPELINE_STAGES — the ONE source of truth.
 *  ────────────────────────────────────────────────────────────────────
 *  Order matters: stages with a `runtime` block are iterated in this
 *  order during system prompt assembly. The visualization on the Galt
 *  page renders all entries (including pre-AI and data-input nodes)
 *  grouped by `lane`.
 *
 *  To add a new prompt fragment to the AI pipeline:
 *    1. Add the column in db/app.ts (interface, default, getter, setter)
 *    2. Add a DEFAULT_* constant + entry in PROMPT_DEFAULTS, resolveTemplates
 *    3. Add an entry here with the right runtime block
 *  That's it. buildSystemPrompt + the Galt page visualization both pick
 *  it up automatically.
 *  ────────────────────────────────────────────────────────────────────
 */
export const PIPELINE_STAGES: readonly PipelineStage[] = [
  /* ── PRE-AI ────────────────────────────────────────────────────────
     Greeting is a literal first-contact send — never reaches the model
     directly. But it's still part of the thread context the AI reads
     on every subsequent reply (as a `me: Galt: …` line in the thread). */
  {
    id: 'away_message',
    lane: 'pre',
    type: 'greeting',
    label: 'Greeting',
    desc:
      "First reply to an opted-in contact when away mode is on. Sent verbatim — NOT AI-generated. " +
      "On every subsequent reply the AI sees this greeting in the thread context (as a 'me: Galt: …' line) " +
      "so it knows what's already been said and won't repeat itself. Supports {recipientName} and {userName} substitution.",
    settingsKey: 'away_message',
    rows: 3,
  },

  /* ── UNIVERSAL ─────────────────────────────────────────────────────
     Always-on identity layer. */
  {
    id: 'prompt_draft_system',
    lane: 'universal',
    type: 'prompt',
    label: 'Base system prompt',
    desc: 'Universal "you are Galt, an AI assistant for the user" guidance injected on every AI call.',
    settingsKey: 'prompt_draft_system',
    rows: 12,
    mono: true,
    showsDefault: 'prompt_draft_system',
    runtime: { templateKey: 'draft_system' },
  },
  {
    id: 'galt_voice_profile',
    lane: 'universal',
    type: 'voice',
    label: "Galt's voice",
    desc:
      "Prose describing how Galt sounds — tone, register, quirks. THE voice used in every AI reply " +
      "(away, summon). Feeds the shared voice-profile wrapper below as the {body} of wrapper_voice_profile.",
    settingsKey: 'galt_voice_profile',
    rows: 4,
    placeholder:
      "e.g. 'direct, no hedging. iMessage-short — usually one line. light dry humor when it fits.'",
    // No runtime — this is a pure data input. Its text flows into the AI
    // call via draftReply's `voiceProfile` parameter, which becomes
    // ctx.voice_profile, which is wrapped by wrapper_voice_profile below.
  },

  /* ── AWAY LANE ─────────────────────────────────────────────────────
     Stages that fire only when awayMode === true. Order within the lane
     is preserved by the runtime loop. */
  {
    id: 'prompt_away_system',
    lane: 'away',
    type: 'context',
    label: 'Away contextNote',
    desc:
      'Per-turn instruction for Galt while covering. When non-empty, replaces the built-in default contextNote ' +
      '(which buildAwayContextNote in server/index.ts assembles).',
    settingsKey: 'prompt_away_system',
    rows: 12,
    mono: true,
    placeholder: '(empty — built-in is running)',
    showsDefault: 'prompt_away_system',
    runtime: { templateKey: 'context_note', awayOnly: true },
  },
  {
    id: 'away_persona',
    lane: 'away',
    type: 'persona',
    label: 'Cover-mode persona',
    desc:
      "How Galt should behave specifically while covering — banter level, deflection style, jokes, " +
      "how to handle 'are you really the AI?'. Layered on top of Galt's voice. Wrapped by the persona-wrapper " +
      "template (advanced) and injected as its own stage.",
    settingsKey: 'away_persona',
    rows: 5,
    placeholder:
      "e.g. 'be casual and a little snarky — lean into the AI thing if anyone asks. crack small jokes.'",
    // No runtime — data input that becomes ctx.persona, which is wrapped
    // by wrapper_away_persona below.
  },
  {
    id: 'wrapper_away_persona',
    lane: 'away',
    type: 'wrapper',
    label: 'Persona wrapper template',
    desc: 'Wraps the persona body in a system-prompt section. {body} = the persona text.',
    settingsKey: 'wrapper_away_persona',
    rows: 4,
    mono: true,
    showsDefault: 'wrapper_away_persona',
    isAdvanced: true,
    runtime: {
      templateKey: 'away_persona',
      bodyField: 'persona',
      conditionField: 'persona',
      awayOnly: true,
      // Backward compat: if the user's custom away contextNote already
      // substitutes {persona}, persona injects via that path — skip the
      // wrapper to avoid double-injecting.
      skipIfContextNoteContains: '{persona}',
    },
  },

  /* ── SUMMON LANE ───────────────────────────────────────────────────
     Stages that fire only when in summon mode (awayMode === false). */
  {
    id: 'summon_system_prompt',
    lane: 'summon',
    type: 'context',
    label: 'Summon contextNote',
    desc:
      'Per-turn instruction for Galt joining the conversation. When non-empty, replaces the built-in default ' +
      '(which buildSummonContextNote in server/index.ts assembles).',
    settingsKey: 'summon_system_prompt',
    rows: 12,
    mono: true,
    placeholder: '(empty — built-in is running)',
    showsDefault: 'prompt_summon_system',
    runtime: { templateKey: 'context_note', summonOnly: true },
  },

  /* ── SHARED WRAPPERS ───────────────────────────────────────────────
     Data-injection templates that frame each placeholder. Each fires in
     both modes when its conditioning data is present. */
  {
    id: 'wrapper_voice_profile',
    lane: 'shared',
    type: 'wrapper',
    label: "Galt's voice",
    desc: "Wraps Galt's voice profile. Fires on every AI call regardless of mode.",
    settingsKey: 'wrapper_voice_profile',
    rows: 4,
    mono: true,
    showsDefault: 'wrapper_voice_profile',
    runtime: {
      templateKey: 'voice_profile',
      bodyField: 'voice_profile',
      conditionField: 'voice_profile',
    },
  },
  {
    id: 'wrapper_contact_profile',
    lane: 'shared',
    type: 'wrapper',
    label: 'Contact profile',
    desc: 'Wraps the per-contact prose profile.',
    settingsKey: 'wrapper_contact_profile',
    rows: 4,
    mono: true,
    showsDefault: 'wrapper_contact_profile',
    runtime: {
      templateKey: 'contact_profile',
      bodyField: 'contact_profile',
      conditionField: 'contact_profile',
    },
  },
  {
    id: 'wrapper_address_book',
    lane: 'shared',
    type: 'wrapper',
    label: 'Address book',
    desc: 'Wraps the macOS Contacts.app block.',
    settingsKey: 'wrapper_address_book',
    rows: 4,
    mono: true,
    showsDefault: 'wrapper_address_book',
    runtime: {
      templateKey: 'address_book',
      bodyField: 'address_book',
      conditionField: 'address_book',
    },
  },
  {
    id: 'wrapper_calendar',
    lane: 'shared',
    type: 'wrapper',
    label: 'Calendar',
    desc: 'Wraps macOS Calendar availability.',
    settingsKey: 'wrapper_calendar',
    rows: 4,
    mono: true,
    showsDefault: 'wrapper_calendar',
    runtime: {
      templateKey: 'calendar',
      bodyField: 'calendar',
      conditionField: 'calendar',
    },
  },
  {
    id: 'wrapper_contact_notes',
    lane: 'shared',
    type: 'wrapper',
    label: 'Contact notes',
    desc: 'Wraps per-contact note bullets.',
    settingsKey: 'wrapper_contact_notes',
    rows: 4,
    mono: true,
    showsDefault: 'wrapper_contact_notes',
    runtime: {
      templateKey: 'contact_notes',
      bodyField: 'contact_notes',
      conditionField: 'contact_notes',
    },
  },
  {
    id: 'wrapper_temperament',
    lane: 'shared',
    type: 'wrapper',
    label: 'Temperament',
    desc: 'Wraps temperament guidance. Only injects when temperament ≠ normal.',
    settingsKey: 'wrapper_temperament',
    rows: 4,
    mono: true,
    showsDefault: 'wrapper_temperament',
    runtime: {
      templateKey: 'temperament',
      // guidance is empty when temperament === 'normal' — single condition suffices.
      conditionField: 'guidance',
    },
  },

  /* ── GUARDRAIL ─────────────────────────────────────────────────────
     LAST in runtime so it's the freshest thing the model reads before
     generating. Away-only by default. */
  {
    id: 'prompt_away_guardrail',
    lane: 'guardrail',
    type: 'guardrail',
    label: 'Away guardrail',
    desc:
      "Hard rule forbidding commitments on the user's behalf. Only injected when awayMode is on. " +
      "Runs LAST so it's freshest in the model's reading.",
    settingsKey: 'prompt_away_guardrail',
    rows: 12,
    mono: true,
    placeholder: '(empty — built-in is running)',
    showsDefault: 'prompt_away_guardrail',
    runtime: { templateKey: 'away_guardrail', awayOnly: true },
  },
];

/** Resolve the template a runtime stage will emit, given the per-call
 *  context. Returns null when the stage should skip (mode mismatch, missing
 *  data, contextNote already covers it, etc.).
 *
 *  Pure function: same inputs → same output. No side effects. Used by both
 *  buildSystemPrompt (assembly) and {messages}-placeholder detection. */
function resolveStageTemplate(
  stage: PipelineStage,
  templates: ReturnType<typeof resolveTemplates>,
  ctx: Record<string, string>,
  awayMode: boolean,
  contextNoteRaw: string,
): string | null {
  const r = stage.runtime;
  if (!r) return null;

  if (r.awayOnly && !awayMode) return null;
  if (r.summonOnly && awayMode) return null;
  if (r.skipIfContextNoteContains && contextNoteRaw.includes(r.skipIfContextNoteContains)) return null;
  if (r.conditionField && !ctx[r.conditionField]) return null;

  let template: string;
  if (r.templateKey === 'context_note') {
    template = contextNoteRaw;
    if (!template || !template.trim()) return null;
  } else {
    const lookup = (templates as Record<string, string | undefined>)[r.templateKey];
    if (lookup === undefined) {
      console.warn(`[pipeline] stage ${stage.id} unknown templateKey: ${r.templateKey}`);
      return null;
    }
    template = lookup;
  }
  return template;
}

/** Build the system prompt for one AI call. Iterates PIPELINE_STAGES in
 *  declaration order. Each stage's metadata fully describes its runtime
 *  semantics (mode gating, data conditions, body field, contextNote
 *  guard). Adding a new stage requires no change here — just add an
 *  entry to PIPELINE_STAGES.
 *
 *  contextNoteRaw is the per-turn instruction passed by the caller —
 *  either the user's prompt_away_system / summon_system_prompt override,
 *  or the built-in default produced by buildAwayContextNote /
 *  buildSummonContextNote in server/index.ts. */
function buildSystemPrompt(
  overrides: PromptOverrides,
  ctx: Record<string, string>,
  awayMode: boolean,
  contextNoteRaw: string,
): string {
  const t = resolveTemplates(overrides);
  const parts: string[] = [];

  for (const stage of PIPELINE_STAGES) {
    const template = resolveStageTemplate(stage, t, ctx, awayMode, contextNoteRaw);
    if (template === null) continue;

    const r = stage.runtime!;
    const body = r.bodyField ? ctx[r.bodyField] ?? '' : '';
    const fragmentCtx = body ? { ...ctx, body } : ctx;
    parts.push(applyTemplate(template, fragmentCtx));
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
  const noteRaw = input.contextNote?.trim() ?? '';
  const overrides = input.promptOverrides ?? {};
  const awayMode = input.awayMode === true;

  const temperament: Temperament =
    input.temperament && (TEMPERAMENTS as readonly string[]).includes(input.temperament)
      ? input.temperament
      : 'normal';

  // Detect {messages} placeholder use across every template that COULD
  // fire in this call. Iterates PIPELINE_STAGES with the same gating logic
  // buildSystemPrompt uses, but skipping data-condition checks (we want
  // to know if {messages} appears in any template that mode-gating would
  // permit, regardless of whether the data conditions happen to fire it
  // on this particular call).
  const t = resolveTemplates(overrides);
  const candidateTemplates: string[] = [];
  for (const stage of PIPELINE_STAGES) {
    const r = stage.runtime;
    if (!r) continue;
    if (r.awayOnly && !awayMode) continue;
    if (r.summonOnly && awayMode) continue;
    let template: string | undefined;
    if (r.templateKey === 'context_note') {
      template = noteRaw;
    } else {
      template = (t as Record<string, string | undefined>)[r.templateKey];
    }
    if (template) candidateTemplates.push(template);
  }
  const usesMessagesPlaceholder = candidateTemplates.some((s) => s.includes('{messages}'));

  // Build the universal substitution context. messages is empty when the
  // user didn't ask for it (so {messages} would just render as nothing
  // anywhere it's mistakenly present in a default).
  const ctx = buildPlaceholderContext({
    messages: usesMessagesPlaceholder ? threadText : '',
    userName: input.templateVars?.userName,
    recipientName: input.templateVars?.recipientName,
    persona: input.templateVars?.persona,
    voiceProfile: input.voiceProfile,
    contactProfile: input.contactProfile,
    addressBookContext: input.addressBookContext,
    userAvailability: input.userAvailability,
    contactNotes: input.contactNotes,
    temperament,
    guidance: TEMPERAMENT_GUIDANCE[temperament],
  });

  // Single-pass system prompt assembly — order is now the canonical pipeline:
  //   1. universal base prompt
  //   2. mode contextNote (per-turn instruction)
  //   3. wrapper_away_persona (away only, when persona present)
  //   4. shared data wrappers (each conditional on its data being present)
  //   5. away_guardrail (away only, last so it's freshest)
  // PIPELINE_STAGES exports this same order for the visualization to read.
  const systemPrompt = buildSystemPrompt(overrides, ctx, awayMode, noteRaw);
  const userContent = usesMessagesPlaceholder
    ? 'Reply now.'
    : `Thread (oldest → newest):\n${threadText}`;
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
