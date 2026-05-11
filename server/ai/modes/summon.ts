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

import { PromptMode } from './mode.js';
import type { Context } from '../context.js';
import { applyTemplate } from '../../ai.js';
import { getSettings } from '../../db/app.js';
import {
  IDENTITY_BASE,
  OUTPUT_FORMAT,
  SKIP_OPT_OUT,
  VARY_PHRASING,
  NO_SKIP_THIS_TURN,
  NEVER_ASK_HELP_DESK,
} from '../guardrails.js';

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
 *  Order Summon wants in the system prompt:
 *    1. Identity                     (universal Galt framing)
 *    2. Voice profile                (Galt's voice)
 *    3. Contact profile              (who you're talking to)
 *    4. Address book                 (latent contact context)
 *    5. Calendar                     (scheduling context)
 *    6. Contact notes                (recent atomic facts)
 *    7. Per-turn instruction         (you're a third voice; the user
 *                                     is right there; handle the
 *                                     latest turn appropriately)
 *    8. Output format                (rhythm + format constraints)
 *    9. NO_SKIP_THIS_TURN  (activation only — forces a reply)
 *       SKIP_OPT_OUT       (continuation turns — silence is OK)
 *   10. NEVER_ASK_HELP_DESK         (the most common LLM failure mode)
 *   11. Vary phrasing
 *
 *  Note: no equivalent of AWAY_NO_COMMIT. The user is right there in
 *  the conversation — if Galt makes a commitment, the user can edit
 *  or unsend before it matters. The "defer back to the user" framing
 *  doesn't apply (the user IS here). */
export class SummonMode extends PromptMode<SummonInput> {
  readonly name = 'summon';

  /** Acknowledgment send. Only fires for bare-summon activations.
   *  Sourced from settings.summon_acknowledgment (default: "yes..."). */
  greeting(_ctx: Context, input: SummonInput): string | null {
    if (!input.isBareSummon) return null;
    const ack = (getSettings().summon_acknowledgment || '').trim();
    return ack || 'yes...';
  }

  buildSystemPrompt(ctx: Context, input: SummonInput): string {
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

    // 7. Per-turn instruction (mode-specific framing)
    parts.push(this.buildContextNote(ctx, input));

    // 8. Output format
    parts.push(OUTPUT_FORMAT);

    // 9. SKIP policy depends on whether this is the activation turn
    if (input.isActivation) {
      parts.push(NO_SKIP_THIS_TURN);
    } else {
      parts.push(SKIP_OPT_OUT);
    }

    // 10-11. The two failure-mode guardrails Summon needs most
    parts.push(NEVER_ASK_HELP_DESK);
    parts.push(VARY_PHRASING);

    return parts.join('\n');
  }

  /** Per-turn instruction for Summon. User override via
   *  settings.summon_system_prompt fully replaces this text. */
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
    const lastSpeaker = input.triggerFromUser ? userName : recipientName;
    const sections: string[] = [];

    sections.push(
      `You are GALT, the user's AI assistant — the user has SUMMONED you into this live conversation. The user is PRESENT and engaged; you are joining as a third voice, NOT covering for the user. The user is right there in the conversation alongside you.`,
    );

    sections.push(
      `You are talking to ${recipientName}. The user (${userName}) is also in the conversation${ctx.isGroup ? ' (group chat)' : ''}.`,
    );

    sections.push(
      `THE LATEST TURN is from **${lastSpeaker}** (${input.triggerFromUser ? 'the user' : 'the contact'}). Read what it ACTUALLY is and respond accordingly:\n` +
        (input.triggerFromUser
          ? `- QUESTION OR DIRECTIVE from ${userName} ("what is X?", "explain Y", "help me with Z", "look up A", "do B", "should I C?"): ANSWER OR DO IT directly. No preamble, no "great question" — just the answer or the requested action. The trigger phrase is NOT required for this — ANY question or directive ${userName} types mid-session is for you. This is the most common case and the easiest to get wrong by treating it as casual chatter.\n` +
            `- BARE SUMMON from ${userName} (trigger phrase alone, or naming you with no specific topic): one short on-topic line picking up wherever the thread is. Don't ask what they want.\n` +
            `- CONVERSATION between ${userName} and ${recipientName} that doesn't need you (${userName} is talking to the contact, not to you): stay light or stay out — a comment from you would just be noise.`
          : `Read the conversation, understand what's being discussed RIGHT NOW, and weigh in if you have something useful to add. The user can dismiss you anytime; you don't need to wait for an explicit invitation on every turn.`),
    );

    return sections.join('\n\n');
  }
}

/** Singleton. Stateless — safe to share across requests. */
export const summonMode = new SummonMode();
