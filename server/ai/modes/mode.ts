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

/** A single stage in a mode's prompt assembly. The UI consumes a list
 *  of these to render an editable per-mode pipeline view; mode authors
 *  expose the list via PromptMode.stages().
 *
 *  Stages are descriptive — they document what the mode COULD inject
 *  in what order and which pieces the user can customize. The runtime
 *  source of truth is still buildSystemPrompt; stages() must mirror
 *  that order. Drift between the two is a bug. */
export interface ModeStage {
  /** Stable id for the UI (data-stage-id). Don't rename without
   *  thinking about cached UI state. */
  id: string;
  /** Human-readable name. */
  label: string;
  /** Optional one-line description shown under the label. */
  description?: string;
  /** When this stage actually fires, in plain English.
   *  Examples: "always" · "only when persona is set" ·
   *  "only in group chats" · "only on activation turns" */
  fires: string;
  /** Settings key the user can edit to customize this stage. Null when
   *  the stage is hardcoded (a guardrail constant). */
  settingsKey: string | null;
  /** What this stage WOULD currently inject — either the user's
   *  override (when settingsKey is set + non-empty) or the default. */
  text: string;
  /** Default text for the stage. Used by the UI to diff overrides
   *  and offer "reset to default". Same as `text` when there's no
   *  override in play. */
  defaultText: string;
  /** Suggested textarea row count for the editor. */
  rows?: number;
}

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

  /** Ordered descriptor of the mode's SYSTEM-PROMPT stages — what
   *  could be injected, in what order, which pieces the user can edit.
   *  The UI renders this as the per-turn pipeline; the runtime ignores
   *  it (buildSystemPrompt is authoritative). Mode authors must keep
   *  this in sync with buildSystemPrompt order.
   *
   *  IMPORTANT: greeting is NOT a stage. The greeting is a pre-AI
   *  literal send, not part of the system-prompt assembly. Modes
   *  expose it separately via greetingStage(). */
  abstract stages(): ModeStage[];

  /** Optional pre-AI greeting descriptor for the UI. Modes that don't
   *  greet return null. Modes that do return a single ModeStage shape
   *  (re-uses the same descriptor type so the UI renders it with the
   *  same card chrome — but it lives OUTSIDE the system-prompt
   *  pipeline. The greeting bypasses the model entirely and just
   *  appears in the thread context on subsequent turns). */
  greetingStage(): ModeStage | null { return null; }

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
