// Abstract base class for AI prompt modes.
//
// A PromptMode owns its full prompt assembly for one role Galt can play
// (covering for the user / joining mid-conversation / whatever future
// modes do). The base class fixes two contracts and lets each mode do
// whatever it wants beneath them:
//
// 1. The user role is ALWAYS the formatted thread, latest message
//    last. Modes do NOT override draft() — the rule is enforced here.
//    Recency-bias attention means whatever's at the end of the user
//    role gets the model's strongest focus; we want that to be the
//    most recent message, every time.
//
// 2. Modes own the system prompt entirely (buildSystemPrompt) —
//    identity, personality, context data, guardrails, in whatever
//    order they prefer. No PIPELINE_STAGES-style prescribed ordering;
//    each mode picks what to include and where.
//
// Optional: modes can declare a pre-AI literal greeting send (Away's
// canned message, Summon's "yes..." acknowledgment). Returning null
// means no greeting on this turn (or this mode doesn't greet at all).

import { chat, type ChatCallResult } from '../client.js';
import type { Context } from '../context.js';

export abstract class PromptMode<TInput = void> {
  /** Identifier for logging and the AI usage panel (counts under
   *  this purpose). Concrete classes set 'away' / 'summon' / etc. */
  abstract readonly name: string;

  /** Optional pre-AI literal send when the mode activates. Bypasses
   *  the model — sent verbatim. Returns null if this mode doesn't
   *  greet (or doesn't greet on this particular turn).
   *
   *  Examples:
   *    AwayMode    → settings.away_message (long-form canned message)
   *    SummonMode  → settings.summon_acknowledgment (short ack;
   *                  only on bare-trigger activation) */
  abstract greeting(ctx: Context, input: TInput): string | null;

  /** Build the system prompt for the per-turn AI call. The recent
   *  thread MUST NOT be included here — by framework convention the
   *  thread is the user role, sent latest-last. */
  abstract buildSystemPrompt(ctx: Context, input: TInput): string;

  /** Per-call temperature. Override for hotter/cooler modes. */
  protected temperature(): number { return 0.7; }
  /** Reply max-token cap. Override for longer-form modes. */
  protected maxTokens(): number { return 300; }
  /** Variant count for this turn. Override for fan-out (multi-draft) modes. */
  protected variantCount(_input: TInput): number { return 1; }

  /** Sealed. Builds + sends. Modes do NOT override.
   *
   *  - System role  = buildSystemPrompt(ctx, input)
   *  - User role    = ctx.formatThread()  ← latest message ALWAYS last
   *  - Usage logged under purpose=this.name. */
  async draft(ctx: Context, input: TInput): Promise<ChatCallResult> {
    const systemPrompt = this.buildSystemPrompt(ctx, input);
    const userContent = ctx.formatThread();
    return chat({
      systemPrompt,
      userContent,
      purpose: this.name,
      count: this.variantCount(input),
      temperature: this.temperature(),
      maxTokens: this.maxTokens(),
    });
  }

  /** Same prompt assembly without the OpenAI call. For debugging and
   *  the upcoming UI work — preview exactly what would be sent. */
  preview(ctx: Context, input: TInput): { systemPrompt: string; userContent: string } {
    return {
      systemPrompt: this.buildSystemPrompt(ctx, input),
      userContent: ctx.formatThread(),
    };
  }
}
