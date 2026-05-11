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

import { PromptMode } from './mode.js';
import type { Context } from '../context.js';
import { applyTemplate } from '../../ai.js';
import { getSettings } from '../../db/app.js';
import {
  IDENTITY_BASE,
  OUTPUT_FORMAT,
  SKIP_OPT_OUT,
  VARY_PHRASING,
  AWAY_NO_COMMIT,
} from '../guardrails.js';

export interface AwayInput {
  /** Cover-mode persona text (settings.away_persona). Empty string
   *  if not set — the persona block is then skipped. */
  persona: string;
}

/** AWAY mode prompt assembly.
 *
 *  Order Away wants in the system prompt:
 *    1. Identity                     (universal Galt framing)
 *    2. Voice profile                (Galt's voice)
 *    3. Contact profile              (who you're talking to)
 *    4. Address book                 (latent contact context)
 *    5. Calendar                     (only when scheduling-relevant)
 *    6. Contact notes                (recent atomic facts)
 *    7. Cover-mode persona           (if user set one)
 *    8. Per-turn instruction         (you're covering, defer to user)
 *    9. Output format                (rhythm + format constraints)
 *   10. SKIP opt-out                 (away can stay quiet on bad turns)
 *   11. Vary phrasing                (don't repeat your own openers)
 *   12. AWAY_NO_COMMIT guardrail     (LAST — freshest in attention) */
export class AwayMode extends PromptMode<AwayInput> {
  readonly name = 'away';

  /** First-touch literal send for an away period. Sourced from
   *  settings.away_message with {recipientName} / {userName}
   *  placeholder substitution. Returns null if the user hasn't set
   *  an away message. */
  greeting(ctx: Context, _input: AwayInput): string | null {
    const template = (getSettings().away_message || '').trim();
    if (!template) return null;
    return applyTemplate(template, {
      recipientName: ctx.recipientName || 'them',
      userName: ctx.userName || 'the user',
    });
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
      parts.push(
        `\nCOVER-MODE BEHAVIOR HINTS — explicit guidance from the user for how Galt should behave while covering (apply on top of Galt's voice profile — these tune banter level, deflection style, jokes for this user's preferred cover-mode feel):\n"""\n${persona}\n"""`,
      );
    }

    // 8. Per-turn instruction (mode-specific framing)
    parts.push(this.buildContextNote(ctx));

    // 9-11. Output / SKIP / variation
    parts.push(OUTPUT_FORMAT);
    parts.push(SKIP_OPT_OUT);
    parts.push(VARY_PHRASING);

    // 12. Hard guardrail LAST — freshest in the model's attention
    parts.push(AWAY_NO_COMMIT);

    return parts.join('\n');
  }

  /** Per-turn instruction for Away. User override via
   *  settings.prompt_away_system fully replaces this text. */
  private buildContextNote(ctx: Context): string {
    const override = getSettings().prompt_away_system?.trim();
    if (override) {
      return applyTemplate(override, {
        recipientName: ctx.recipientName || 'them',
        userName: ctx.userName || 'the user',
      });
    }
    const recipientName = ctx.recipientName || 'them';
    return [
      `You are GALT, the user's AI assistant. The user is currently away. You are covering for them in this iMessage conversation — handling routine back-and-forth so the user can catch up later. The recipient (${recipientName}) was told earlier in this thread that they're chatting with the user's AI; the runtime prefixes every message you send with "Galt: " so identity stays explicit. You speak as Galt, in Galt's voice (see voice profile above) — NOT as the user.`,
      `You are responding to: ${recipientName}. Use their name naturally when it actually fits — but don't shoehorn it. A casual reply usually has no name in it; reserve it for moments where calling someone by name adds warmth or clarity.`,
      "Behave like a friend's AI who's covering, not like customer service. Keep the conversation natural, varied, and alive. The recipient knows you're the AI — they don't need you to act human, but you also shouldn't make a thing of it every turn.",
      "Match the energy of the most recent incoming message: if they're playful, be playful; if they're terse, be terse; if they ask a real question and the thread already gives you the answer, just answer.",
      'When you genuinely cannot know something (specific times/places/money/promises the user has not confirmed in the thread, personal details about the user\'s day, anything only the real user can decide): defer back to the user. Examples — "no idea, I\'ll have him reach out about that" / "let me flag this so he can confirm when he\'s back" / "above my pay grade — he\'ll have to weigh in". Vary your phrasing.',
      "What you should NOT do: pretend you ARE the user; use customer-service phrasings (\"apologies for the inconvenience\", \"thank you for reaching out\", \"how can I help\"); make up commitments; sound robotic.",
    ].join('\n\n');
  }
}

/** Singleton — one instance per process. Stateless, safe to share. */
export const awayMode = new AwayMode();
