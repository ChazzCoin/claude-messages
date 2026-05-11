// AWAY mode — Galt covers for the user when they're out.
//
// Lifecycle:
//  - First inbound from a watched contact (or in a watched group)
//    during an away period:
//      → handler calls greeting(); sends the canned away_message verbatim.
//      → no AI call on this turn.
//  - Subsequent inbound from the same contact / group during the same
//    away session:
//      → handler calls draft(); we go through buildSystemPrompt + the
//        universal user content (formatted thread, latest last).
//
// Per-turn instruction is built privately. Users can override it by
// setting settings.prompt_away_system; that override REPLACES the
// built-in instruction text (everything else — voice, contact data,
// guardrails — keeps flowing).
//
// Tuning rationale (defended below in temperature / maxTokens):
//   - Away replies are AUTONOMOUS. Once aiAutoSend fires, the message
//     hits the recipient. Apple's edit/unsend window exists, but treat
//     each draft as one-shot in design terms.
//   - Therefore: cooler temperature than the framework default (0.55
//     vs 0.7), tighter maxTokens (240 vs 300). Both pull the model
//     toward shorter, safer replies that defer rather than improvise.

import { PromptMode, type ModeStage } from './mode.js';
import type { Context } from '../context.js';
import { applyTemplate } from '../../ai.js';
import { getSettings, SETTING_DEFAULTS } from '../../db/app.js';
import {
  IDENTITY_BASE,
  OUTPUT_FORMAT,
  SKIP_OPT_OUT,
  VARY_PHRASING,
  AWAY_GROUP_FRAMING,
  AWAY_NO_COMMIT,
} from '../guardrails.js';

/** Default per-turn instruction for Away mode. Exposed as a constant
 *  so stages() can show it as the editable default; buildContextNote
 *  substitutes {recipientName} / {userName} at runtime. */
const AWAY_DEFAULT_CONTEXT_NOTE = `AWAY MODE — the user is OUT and you are standing in for them on this thread. The recipient ({recipientName}) was told on first contact that they're chatting with the user's AI; the runtime prefixes every message you send with "Galt: " so identity stays unambiguous. You are covering, not deciding — your job is to keep the thread alive long enough for the user to pick it up later, NOT to resolve anything on their behalf.

Talking to: {recipientName}. Use their name only when it adds warmth or clarity — most casual replies skip it. Don't shoehorn it in.

Match the contact's energy: playful with playful, terse with terse, serious with serious. Acknowledge what they said. If a question is purely about something already established in the thread, just answer it. If it's anything else — anything requiring the user's call — acknowledge and defer.

Defer phrasings — vary them, don't repeat the same one: "I'll flag this for him", "let me have him weigh in when he's back", "above my pay grade — he'll need to confirm", "I'll let him know you asked", "no idea, I'll loop him in". Anything you defer becomes a note in the user's follow-up queue. That's the whole design — defer LIBERALLY rather than guess.`;

/** Persona block format. Body is the user's away_persona text. */
const AWAY_PERSONA_WRAPPER = `\nUSER'S COVER-MODE NOTES — explicit guidance from the user for how Galt should behave while covering for them. Apply on top of Galt's voice profile (these tune banter level, deflection style, joke posture for this user's preferred cover feel). When this conflicts with a generic default, this wins:\n"""\n{body}\n"""`;

export interface AwayInput {
  /** Cover-mode persona text (settings.away_persona). Empty string
   *  if not set — the persona block is then skipped. */
  persona: string;
}

/** Greeting placeholder context — what the canned away_message can use.
 *
 *  {recipientName} / {userName} are the long-standing pair. The two
 *  time-of-day placeholders are useful enough for human-feeling
 *  greetings ("good morning, ...", "Friday afternoon and Chazz is
 *  in meetings...") to be worth supporting; both are computed from
 *  local clock at greeting-time. Anything more elaborate
 *  (expected-return, date, location) is left out — without first-class
 *  data behind it, those placeholders would silently render empty and
 *  confuse the user. */
function buildGreetingPlaceholders(ctx: Context): Record<string, string> {
  const now = new Date();
  const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' });
  const hour = now.getHours();
  const timeOfDay =
    hour < 5  ? 'night' :
    hour < 12 ? 'morning' :
    hour < 17 ? 'afternoon' :
    hour < 21 ? 'evening' :
                'night';
  return {
    recipientName: ctx.recipientName || 'them',
    userName:      ctx.userName      || 'the user',
    dayOfWeek,
    timeOfDay,
  };
}

/** AWAY mode prompt assembly.
 *
 *  Order Away wants in the system prompt (rationale by section):
 *    1. Identity                     — universal Galt framing
 *    2. Voice profile                — Galt's baseline tone
 *    3. Contact profile              — who you're talking to (overrides
 *                                       defaults — high-priority context)
 *    4. Address book                 — latent contact context
 *    5. Calendar                     — only when scheduling-relevant
 *                                       (wrapper text gates use)
 *    6. Contact notes                — recent atomic facts
 *    7. Cover-mode persona           — user's hint for cover behavior
 *    8. Per-turn instruction         — you're standing in; defer back
 *                                       (data is now grounded; here's
 *                                        what to DO with it)
 *    9. Group framing                — only when isGroup is true
 *   10. Output format                — rhythm + plain text only
 *   11. SKIP opt-out                 — silence is a valid outcome here
 *   12. Vary phrasing                — don't repeat your own openers
 *   13. AWAY_NO_COMMIT guardrail     — LAST. Recency-bias attention
 *                                       means the no-commit rule is
 *                                       the freshest thing in the
 *                                       model's head when it generates. */
export class AwayMode extends PromptMode<AwayInput> {
  readonly name = 'away';

  /** Away is autonomous — bias toward conservative output. The
   *  framework default is 0.7 (used by Summon); 0.55 keeps phrasing
   *  varied across multi-turn sessions but tames the model's instinct
   *  to improvise, embellish, or commit. */
  protected temperature(): number { return 0.55; }

  /** Tighter than the 300-token default. iMessage-shaped replies
   *  fit comfortably in 240 — and capping shorter is itself a
   *  guardrail against the model wandering into customer-service
   *  paragraphs. */
  protected maxTokens(): number { return 240; }

  /** First-touch literal send for an away period. Sourced from
   *  settings.away_message with placeholder substitution. Returns
   *  null if the user hasn't set an away message.
   *
   *  Supported placeholders (see buildGreetingPlaceholders):
   *    {recipientName}  who Galt is greeting
   *    {userName}       who Galt is covering for
   *    {dayOfWeek}      "Monday", "Tuesday", ...
   *    {timeOfDay}      "morning" | "afternoon" | "evening" | "night" */
  greeting(ctx: Context, _input: AwayInput): string | null {
    const template = (getSettings().away_message || '').trim();
    if (!template) return null;
    return applyTemplate(template, buildGreetingPlaceholders(ctx));
  }

  buildSystemPrompt(ctx: Context, input: AwayInput): string {
    const parts: string[] = [];

    // 1. Universal identity
    parts.push(IDENTITY_BASE);

    // 2-6. Data sections (each fires only when its data is present)
    const voice = ctx.voiceSection();
    if (voice) parts.push(voice);

    const contactProfile = ctx.contactProfileSection();
    if (contactProfile) parts.push(contactProfile);

    const addressBook = ctx.addressBookSection();
    if (addressBook) parts.push(addressBook);

    const calendar = ctx.calendarSection();
    if (calendar) parts.push(calendar);

    const contactNotes = ctx.contactNotesSection();
    if (contactNotes) parts.push(contactNotes);

    // 7. Cover-mode persona (only when set)
    const persona = (input.persona || '').trim();
    if (persona) {
      parts.push(applyTemplate(AWAY_PERSONA_WRAPPER, { body: persona }));
    }

    // 8. Per-turn instruction (mode-specific framing). Placed AFTER
    //    the data so the data is grounded by the time the model reads
    //    its job description.
    parts.push(this.buildContextNote(ctx));

    // 9. Group framing — only when relevant. Pulled out of the
    //    per-turn note so 1:1 prompts stay clean.
    if (ctx.isGroup) parts.push(AWAY_GROUP_FRAMING);

    // 10-12. Output / SKIP / variation
    parts.push(OUTPUT_FORMAT);
    parts.push(SKIP_OPT_OUT);
    parts.push(VARY_PHRASING);

    // 13. Hard guardrail LAST — freshest in the model's attention.
    //     This is the load-bearing piece for an autonomous-send mode.
    parts.push(AWAY_NO_COMMIT);

    return parts.join('\n');
  }

  /** Per-turn instruction for Away. User override via
   *  settings.prompt_away_system fully replaces this text.
   *
   *  Tightened from the legacy 6-paragraph block: dropped duplicates
   *  of guidance that already lives in IDENTITY_BASE (don't impersonate
   *  the user), OUTPUT_FORMAT (no customer-service phrasings), and
   *  AWAY_NO_COMMIT (no fabricated commitments). What's left is the
   *  unique-to-Away orientation: the user is OUT, your job is to keep
   *  things alive without resolving anything, defer back so it lands
   *  in the user's notes queue. */
  private buildContextNote(ctx: Context): string {
    const override = getSettings().prompt_away_system?.trim();
    const template = override || AWAY_DEFAULT_CONTEXT_NOTE;
    return applyTemplate(template, {
      recipientName: ctx.recipientName || 'them',
      userName: ctx.userName || 'the user',
    });
  }

  /** Pipeline view for the UI. Mirrors buildSystemPrompt order; the
   *  greeting is included as the first stage even though it's pre-AI
   *  (the UI shows the full mode flow, not just the AI assembly). */
  stages(): ModeStage[] {
    const s = getSettings();
    const out: ModeStage[] = [];

    // 0. Greeting (pre-AI literal send)
    out.push({
      id: 'greeting',
      label: 'Greeting',
      description: 'Canned message sent verbatim on first contact in an away period. Bypasses the AI.',
      fires: 'first contact in an away period',
      settingsKey: 'away_message',
      defaultText: SETTING_DEFAULTS.away_message,
      text: s.away_message || SETTING_DEFAULTS.away_message,
      rows: 4,
    });

    // 1. Identity
    out.push({
      id: 'identity',
      label: 'Identity',
      description: 'Universal Galt framing. Hardcoded.',
      fires: 'always',
      settingsKey: null,
      defaultText: IDENTITY_BASE,
      text: IDENTITY_BASE,
    });

    // 2. Voice
    out.push({
      id: 'voice',
      label: "Galt's voice",
      description: "Galt's voice profile (system-wide AI voice — used in every mode).",
      fires: 'when galt_voice_profile is set',
      settingsKey: 'galt_voice_profile',
      defaultText: '',
      text: s.galt_voice_profile || '',
      rows: 5,
    });

    // 3-6. Per-contact / system data sections (not user-editable here;
    //      they're per-contact data managed elsewhere)
    out.push({
      id: 'contact_profile',
      label: 'Contact profile',
      description: "User's prose description of the contact (relationship, sensitivities, how to talk to them). Edited from the contact's workbench, not here.",
      fires: 'when the contact has a profile set',
      settingsKey: null,
      defaultText: '(per-contact, set on the contact)',
      text: '(per-contact, set on the contact)',
    });
    out.push({
      id: 'address_book',
      label: 'Address book',
      description: 'macOS Contacts.app data for this contact (role, birthday, freeform notes). Read-only — pulled live from your AddressBook.',
      fires: 'when contact has a macOS Contacts entry',
      settingsKey: null,
      defaultText: '(read from macOS Contacts.app)',
      text: '(read from macOS Contacts.app)',
    });
    out.push({
      id: 'calendar',
      label: 'Calendar',
      description: 'macOS Calendar.app availability — only used when the thread asks about scheduling.',
      fires: 'when calendar events fall in the window AND thread is scheduling-related',
      settingsKey: null,
      defaultText: '(read from macOS Calendar.app)',
      text: '(read from macOS Calendar.app)',
    });
    out.push({
      id: 'contact_notes',
      label: 'Contact notes',
      description: 'Per-contact short-fact bullets. Edited from the contact\'s workbench, not here.',
      fires: 'when the contact has notes',
      settingsKey: null,
      defaultText: '(per-contact, set on the contact)',
      text: '(per-contact, set on the contact)',
    });

    // 7. Cover-mode persona
    out.push({
      id: 'persona',
      label: 'Cover-mode persona',
      description: 'Tunes Galt\'s posture while covering — banter level, deflection style, joke calibration. Layered on top of voice.',
      fires: 'when set',
      settingsKey: 'away_persona',
      defaultText: '',
      text: s.away_persona || '',
      rows: 4,
    });

    // 8. Per-turn instruction
    out.push({
      id: 'context_note',
      label: 'Per-turn instruction',
      description: 'Tells the model its job for THIS draft — covering, deferring, not deciding. Override fully replaces the default. Supports {recipientName} / {userName}.',
      fires: 'always',
      settingsKey: 'prompt_away_system',
      defaultText: AWAY_DEFAULT_CONTEXT_NOTE,
      text: s.prompt_away_system?.trim() || AWAY_DEFAULT_CONTEXT_NOTE,
      rows: 12,
    });

    // 9. Group framing (conditional)
    out.push({
      id: 'group_framing',
      label: 'Group framing',
      description: 'Tells the model to be quieter in groups — only weigh in when the latest turn is plausibly aimed at the user.',
      fires: 'only in group chats',
      settingsKey: null,
      defaultText: AWAY_GROUP_FRAMING,
      text: AWAY_GROUP_FRAMING,
    });

    // 10-12. Output / SKIP / variation
    out.push({
      id: 'output_format',
      label: 'Output format',
      description: 'Plain text only, iMessage rhythm, no preamble or sign-offs. Hardcoded.',
      fires: 'always',
      settingsKey: null,
      defaultText: OUTPUT_FORMAT,
      text: OUTPUT_FORMAT,
    });
    out.push({
      id: 'skip_opt_out',
      label: 'SKIP opt-out',
      description: 'Lets the model bow out with literal SKIP when no good reply exists. Silence is a valid Away outcome.',
      fires: 'always',
      settingsKey: null,
      defaultText: SKIP_OPT_OUT,
      text: SKIP_OPT_OUT,
    });
    out.push({
      id: 'vary_phrasing',
      label: 'Vary phrasing',
      description: 'Tells the model to read its own previous Galt: lines and not repeat openings/hedges.',
      fires: 'always',
      settingsKey: null,
      defaultText: VARY_PHRASING,
      text: VARY_PHRASING,
    });

    // 13. AWAY_NO_COMMIT — the load-bearing piece. LAST so it's freshest.
    out.push({
      id: 'no_commit_guardrail',
      label: 'No-commit guardrail',
      description: 'CRITICAL — forbids any commitment-style language since the user hasn\'t authorized one. Pinned LAST so it\'s the freshest thing the model reads before generating.',
      fires: 'always',
      settingsKey: null,
      defaultText: AWAY_NO_COMMIT,
      text: AWAY_NO_COMMIT,
    });

    return out;
  }
}

/** Singleton — one instance per process. Stateless, safe to share. */
export const awayMode = new AwayMode();
