// SUMMON mode — Galt joins a live conversation when the user invokes
// the trigger phrase. Distinct from Away in that the user is PRESENT
// and explicitly invoking; Galt should engage like a friend who walked
// in, not stand in for the user.
//
// Greeting policy (the activation flow):
//   - BARE summon ("GALT!!" alone, no actual ask):
//       greeting() returns the acknowledgment ("yes...");
//       the handler sends it verbatim. No AI call this turn — the
//       user can follow up with their actual ask, which then goes
//       through draft() like any continuation turn.
//   - ASK summon ("GALT!! help me with X"):
//       greeting() returns null;
//       the handler skips the literal ack and goes straight to
//       draft() — the AI answers the ask directly.
//   - Continuation turns (session already open, no trigger this turn):
//       greeting() returns null;
//       handler calls draft() per usual.

import { PromptMode, type ModeStage } from './mode.js';
import type { Context } from '../context.js';
import { applyTemplate } from '../../ai.js';
import { getSettings, SETTING_DEFAULTS } from '../../db/app.js';
import {
  IDENTITY_BASE,
  OUTPUT_FORMAT,
  SKIP_OPT_OUT,
  VARY_PHRASING,
  NO_SKIP_THIS_TURN,
  NEVER_ASK_HELP_DESK,
  KEEP_IT_SHORT,
} from '../guardrails.js';

/** Default per-turn instruction for Summon. Exposed as a constant so
 *  stages() can show it as the editable default; buildContextNote
 *  branches on triggerFromUser at runtime — the default shown in the
 *  UI is the user-trigger branch (the most common case). */
const SUMMON_DEFAULT_CONTEXT_NOTE = `SUMMON MODE — the user has invoked you into this LIVE conversation. The user ({userName}) is PRESENT and engaged in this thread; you (Galt) are joining as a third voice. You are NOT covering for the user — they are right here. The other person in the conversation is {recipientName}.

THE LATEST MESSAGE is from {userName} (the user) — directed at YOU. Handle it as one of these three cases:
- ASK or DIRECTIVE ("what is X", "explain Y", "look up Z", "should I A"): just answer or do it. No preamble.
- BARE SUMMON (trigger phrase alone, or naming you with no specific topic): one short on-topic line picking up where the thread is. Don't ask what they want.
- META / between-{userName}-and-{recipientName} chatter that doesn't actually need you: SKIP (or stay light).
Note: {userName}'s typed messages mid-session are for YOU even WITHOUT the trigger phrase. The trigger only opens the session; once open, treat any directive from {userName} as Galt's to answer.`;

export interface SummonInput {
  /** True when the LATEST message in the thread is the user's own
   *  (typically the trigger phrase). False when an in-group contact
   *  spoke. Affects per-turn framing. */
  triggerFromUser: boolean;
  /** True when this turn is the activation turn (trigger phrase
   *  detected, session opened). Forces a non-SKIP reply via
   *  NO_SKIP_THIS_TURN. */
  isActivation: boolean;
  /** True when the activation message is JUST the trigger phrase
   *  with no actual ask. Drives greeting():
   *    bare-summon → send acknowledgment greeting only (no AI)
   *    ask-summon  → skip greeting, generate AI answer directly */
  isBareSummon: boolean;
}

/** SUMMON mode prompt assembly.
 *
 *  Reasoning behind the order — Summon's failure mode is "model slips
 *  into customer-service helpfulness". Defense-in-depth: identity then
 *  IMMEDIATELY the per-turn instruction (you're a third voice, user
 *  is here, the latest line is X) so the model knows what kind of
 *  reply we want before it ever sees data sections. Data flows after.
 *  Then the constraints, with NEVER_ASK_HELP_DESK LAST so it's the
 *  freshest thing in attention before generation — same trick Away
 *  uses for AWAY_NO_COMMIT.
 *
 *    1. Identity                     (universal Galt framing)
 *    2. Per-turn instruction         (third voice, user is HERE, what
 *                                     the latest turn is, how to act)
 *    3. Voice profile                (Galt's voice)
 *    4. Contact profile              (who you're talking to)
 *    5. Address book                 (latent contact context)
 *    6. Calendar                     (scheduling context)
 *    7. Contact notes                (recent atomic facts)
 *    8. Output format                (rhythm + format constraints)
 *    9. KEEP_IT_SHORT                (Summon replies are SHORT)
 *   10. NO_SKIP_THIS_TURN  (activation only — forces a reply)
 *       SKIP_OPT_OUT       (continuation turns — silence is OK)
 *   11. VARY_PHRASING               (don't repeat your own openers)
 *   12. NEVER_ASK_HELP_DESK         (LAST — freshest in attention)
 *
 *  No AWAY_NO_COMMIT equivalent: the user is right there. If Galt
 *  over-commits, the user can correct or unsend before it matters. */
export class SummonMode extends PromptMode<SummonInput> {
  readonly name = 'summon';

  /** Acknowledgment send. Only fires for bare-summon activations.
   *  Sourced from settings.summon_acknowledgment (default: "yes...").
   *
   *  Default kept literal/predictable rather than randomized: when the
   *  user fires the trigger, they need to KNOW Galt arrived. A varied
   *  ack ("yo", "what's up") would be ambiguous — did Galt actually
   *  open the session, or did some other auto-reply just happen?
   *  "yes..." has personality (slightly bemused "I heard you, what")
   *  AND is unmistakably the ack. Users who want a different default
   *  override settings.summon_acknowledgment. */
  greeting(_ctx: Context, input: SummonInput): string | null {
    if (!input.isBareSummon) return null;
    const ack = (getSettings().summon_acknowledgment || '').trim();
    return ack || 'yes...';
  }

  /** Hotter than Away (0.8 vs 0.7). Summon should feel spontaneous —
   *  a friend dropping in mid-conversation, not a measured response
   *  drafted on someone's behalf. Slight extra randomness fights the
   *  generic-LLM customer-service register. */
  protected temperature(): number { return 0.8; }

  /** Tighter than Away (180 vs 300). Summon replies should land like
   *  one or two iMessage lines, not a paragraph. The ceiling backstops
   *  KEEP_IT_SHORT — even if the model wants to ramble, it can't.
   *  Earned-length cases (real explanation, list of steps) still fit
   *  comfortably under 180 tokens. */
  protected maxTokens(): number { return 180; }

  buildSystemPrompt(ctx: Context, input: SummonInput): string {
    const parts: string[] = [];

    // 1. Universal identity
    parts.push(IDENTITY_BASE);

    // 2. Per-turn instruction EARLY — Summon's whole identity ("you're
    //    a third voice, user is HERE") needs to be set before the model
    //    starts pattern-matching against contact data and slipping into
    //    "I am an assistant, how can I help" generic mode.
    parts.push(this.buildContextNote(ctx, input));

    // 3-7. Data sections (each fires only when its data is present)
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

    // 8. Output format
    parts.push(OUTPUT_FORMAT);

    // 9. Brevity bias — Summon should be SHORT.
    parts.push(KEEP_IT_SHORT);

    // 10. SKIP policy — activation forces a reply, continuation may stay quiet.
    if (input.isActivation) {
      parts.push(NO_SKIP_THIS_TURN);
    } else {
      parts.push(SKIP_OPT_OUT);
    }

    // 11. Don't repeat your own previous openers.
    parts.push(VARY_PHRASING);

    // 12. LAST — freshest in attention. The single biggest failure
    //     mode for Summon is the model defaulting to "what can I help
    //     with?" — make that the final thing it reads.
    parts.push(NEVER_ASK_HELP_DESK);

    return parts.join('\n');
  }

  /** Per-turn instruction for Summon. User override via
   *  settings.summon_system_prompt fully replaces this text.
   *
   *  Tightened from the legacy port. Three things to convey:
   *    (a) you're a third voice, the user is right here
   *    (b) who's in the room
   *    (c) what the latest turn IS (user / contact) and how to handle it
   *  Anything beyond that is noise — guardrails carry the rest. */
  private buildContextNote(ctx: Context, input: SummonInput): string {
    const override = getSettings().summon_system_prompt?.trim();
    if (override) {
      return applyTemplate(override, {
        recipientName: ctx.recipientName || 'them',
        userName: ctx.userName || 'the user',
      });
    }
    const recipientName = ctx.recipientName || 'them';
    const userName = ctx.userName || 'the user';
    const groupTag = ctx.isGroup ? ' (group chat)' : '';

    const sections: string[] = [];

    // (a) + (b) — what Summon mode IS, who's in the room. One block,
    //             no padding. The "third voice, NOT covering" framing
    //             is the load-bearing distinction vs Away.
    sections.push(
      `SUMMON MODE — the user has invoked you into this LIVE conversation. The user (${userName}) is PRESENT and engaged in this thread${groupTag}; you (Galt) are joining as a third voice. You are NOT covering for the user — they are right here. The other person in the conversation is ${recipientName}.`,
    );

    // (c) — what the latest turn is and how to handle it. Branch on
    //       triggerFromUser. Keep each branch short and concrete.
    if (input.triggerFromUser) {
      sections.push(
        `THE LATEST MESSAGE is from ${userName} (the user) — directed at YOU. Handle it as one of these three cases:\n` +
          `- ASK or DIRECTIVE ("what is X", "explain Y", "look up Z", "should I A"): just answer or do it. No preamble.\n` +
          `- BARE SUMMON (trigger phrase alone, or naming you with no specific topic): one short on-topic line picking up where the thread is. Don't ask what they want.\n` +
          `- META / between-${userName}-and-${recipientName} chatter that doesn't actually need you: SKIP (or stay light).\n` +
          `Note: ${userName}'s typed messages mid-session are for YOU even WITHOUT the trigger phrase. The trigger only opens the session; once open, treat any directive from ${userName} as Galt's to answer.`,
      );
    } else {
      sections.push(
        `THE LATEST MESSAGE is from ${recipientName} (not from ${userName}). The session is already open, so you may weigh in if you have something concretely useful to add. If you don't — SKIP. ${userName} is in the conversation; nothing forces you to speak every turn.`,
      );
    }

    return sections.join('\n\n');
  }

  /** Pre-AI acknowledgment — sent verbatim when the user opens a
   *  session with a bare trigger ("GALT!!" alone). Bypasses the AI.
   *  Ask-summons skip the greeting and go straight to the AI. */
  greetingStage(): ModeStage {
    const s = getSettings();
    return {
      id: 'greeting',
      label: 'Acknowledgment',
      description: "Short literal send when the user fires the trigger with no actual ask attached. Bypasses the AI. Ask-summons (trigger + ask in the same message) skip this and go straight to the AI. The model sees this on subsequent turns through the thread context — no separate injection needed.",
      fires: 'on bare-summon activation only',
      settingsKey: 'summon_acknowledgment',
      defaultText: SETTING_DEFAULTS.summon_acknowledgment,
      text: s.summon_acknowledgment || SETTING_DEFAULTS.summon_acknowledgment,
      rows: 2,
    };
  }

  /** Pipeline view for the UI — SYSTEM-PROMPT assembly only. Mirrors
   *  buildSystemPrompt order. Greeting is NOT here (it's pre-AI; see
   *  greetingStage() above). */
  stages(): ModeStage[] {
    const s = getSettings();
    const out: ModeStage[] = [];

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

    // 2. Per-turn instruction — moved EARLY in Summon (right after
    //    identity) so the third-voice / user-is-here framing is set
    //    before the model sees data and slips into help-desk mode.
    out.push({
      id: 'context_note',
      label: 'Per-turn instruction',
      description: 'Tells the model its job for THIS turn — third voice, user is present, what the latest message IS. Override fully replaces the default. Supports {recipientName} / {userName}.',
      fires: 'always',
      settingsKey: 'summon_system_prompt',
      defaultText: SUMMON_DEFAULT_CONTEXT_NOTE,
      text: s.summon_system_prompt?.trim() || SUMMON_DEFAULT_CONTEXT_NOTE,
      rows: 12,
    });

    // 3. Voice
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

    // 4-7. Per-contact / system data sections (read from the contact
    //      and macOS apps; not user-editable here)
    out.push({
      id: 'contact_profile',
      label: 'Contact profile',
      description: "User's prose description of the contact. Edited from the contact's workbench, not here.",
      fires: 'when the contact has a profile set',
      settingsKey: null,
      defaultText: '(per-contact, set on the contact)',
      text: '(per-contact, set on the contact)',
    });
    out.push({
      id: 'address_book',
      label: 'Address book',
      description: 'macOS Contacts.app data for this contact. Read-only.',
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

    // 8. Output format
    out.push({
      id: 'output_format',
      label: 'Output format',
      description: 'Plain text only, iMessage rhythm, no preamble or sign-offs. Hardcoded.',
      fires: 'always',
      settingsKey: null,
      defaultText: OUTPUT_FORMAT,
      text: OUTPUT_FORMAT,
    });

    // 9. KEEP_IT_SHORT — Summon-specific brevity bias
    out.push({
      id: 'keep_it_short',
      label: 'Brevity bias',
      description: 'Pushes Summon replies to one or two iMessage lines, not paragraphs.',
      fires: 'always',
      settingsKey: null,
      defaultText: KEEP_IT_SHORT,
      text: KEEP_IT_SHORT,
    });

    // 10. SKIP policy — depends on whether this is the activation turn
    out.push({
      id: 'skip_policy',
      label: 'SKIP policy',
      description: 'Activation turns force a non-SKIP reply (NO_SKIP_THIS_TURN). Continuation turns allow SKIP (silence is OK if Galt has nothing useful).',
      fires: 'NO_SKIP_THIS_TURN on activation; SKIP_OPT_OUT on continuation',
      settingsKey: null,
      defaultText: `${NO_SKIP_THIS_TURN}\n\n— OR —\n\n${SKIP_OPT_OUT}`,
      text: `${NO_SKIP_THIS_TURN}\n\n— OR —\n\n${SKIP_OPT_OUT}`,
    });

    // 11. Vary phrasing
    out.push({
      id: 'vary_phrasing',
      label: 'Vary phrasing',
      description: 'Tells the model to read its own previous Galt: lines and not repeat openings/hedges.',
      fires: 'always',
      settingsKey: null,
      defaultText: VARY_PHRASING,
      text: VARY_PHRASING,
    });

    // 12. NEVER_ASK_HELP_DESK — LAST so it's freshest in attention.
    //     Summon's biggest failure mode is the model defaulting to
    //     "what can I help with?" — the position matters.
    out.push({
      id: 'never_ask_help_desk',
      label: 'No help-desk phrasing',
      description: 'CRITICAL — forbids "how can I help?" / "what would you like?" customer-service mode. Pinned LAST so it\'s the freshest thing the model reads.',
      fires: 'always',
      settingsKey: null,
      defaultText: NEVER_ASK_HELP_DESK,
      text: NEVER_ASK_HELP_DESK,
    });

    return out;
  }
}

/** Singleton. Stateless — safe to share across requests. */
export const summonMode = new SummonMode();
