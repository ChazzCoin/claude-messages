// AI client + chat-call wrapper.
//
// Single source of truth for talking to OpenAI. Everything that runs an
// inference goes through `chat()` here so:
//   - usage logging is automatic (purpose label → ai_usage_log → /state.ai)
//   - cost is computed at write-time from the per-model price table
//   - SDK details (which model, response shape) stay in one place
//
// Modes (server/ai/modes/*) call `chat()` via PromptMode.draft(). Feature
// AI calls (classify / summarize / extractAutoNote / etc.) can also use
// it — they're not mode-bound, just one-shot completions.
//
// The OpenAI client itself is cached per-API-key; settings can rotate the
// key without a service restart.

import OpenAI from 'openai';
import { config } from '../config.js';
import { getSettings, insertAiUsage } from '../db/app.js';

/* ------------------------------------------------------------------ */
/* model / price table                                                 */
/* ------------------------------------------------------------------ */

/** Per-1M-token list prices (USD) for the OpenAI models we expect.
 *  Hardcoded so the UI can show $$ without a network call. New models
 *  default to a conservative gpt-4o-mini fallback so a model we
 *  forgot to price never blows up the recorder.
 *  Source: openai.com/pricing — keep in sync. */
const MODEL_PRICES_PER_MILLION_USD: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini':   { input: 0.15,  output: 0.60 },
  'gpt-4o':        { input: 2.50,  output: 10.00 },
  'gpt-4-turbo':   { input: 10.00, output: 30.00 },
  'gpt-4':         { input: 30.00, output: 60.00 },
  'gpt-3.5-turbo': { input: 0.50,  output: 1.50 },
};
const FALLBACK_PRICE = MODEL_PRICES_PER_MILLION_USD['gpt-4o-mini']!;

function priceUsage(model: string, promptTokens: number, completionTokens: number): number {
  const base = model.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-preview.*$/, '');
  const p = MODEL_PRICES_PER_MILLION_USD[base] ?? MODEL_PRICES_PER_MILLION_USD[model] ?? FALLBACK_PRICE;
  return (promptTokens / 1_000_000) * p.input + (completionTokens / 1_000_000) * p.output;
}

/* ------------------------------------------------------------------ */
/* key + model resolution                                              */
/* ------------------------------------------------------------------ */

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

export function apiKeySource(): 'settings' | 'env' | 'none' {
  if (getSettings().openai_api_key?.trim()) return 'settings';
  if (config.openai.apiKey) return 'env';
  return 'none';
}

export function isAIConfigured(): boolean {
  return !!effectiveApiKey();
}

/* ------------------------------------------------------------------ */
/* OpenAI client (cached per key)                                      */
/* ------------------------------------------------------------------ */

let _client: OpenAI | null = null;
let _clientForKey: string | null = null;

export function getOpenAIClient(): OpenAI {
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
/* usage logging                                                       */
/* ------------------------------------------------------------------ */

interface UsageObj {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** Fire-and-forget log of one OpenAI completion's usage. Safe to call
 *  with `usage = undefined` (e.g. when the SDK didn't return one) — it
 *  no-ops. */
export function recordAiUsage(opts: { purpose: string; model: string; usage: UsageObj | undefined }): void {
  if (!opts.usage) return;
  try {
    insertAiUsage({
      provider: 'openai',
      model: opts.model,
      purpose: opts.purpose,
      prompt_tokens: opts.usage.prompt_tokens ?? 0,
      completion_tokens: opts.usage.completion_tokens ?? 0,
      total_tokens: opts.usage.total_tokens ?? 0,
      cost_usd: priceUsage(opts.model, opts.usage.prompt_tokens ?? 0, opts.usage.completion_tokens ?? 0),
    });
  } catch (err) {
    console.error('[ai] recordAiUsage failed:', (err as Error).message);
  }
}

/* ------------------------------------------------------------------ */
/* chat completion wrapper                                             */
/* ------------------------------------------------------------------ */

export interface ChatCallOpts {
  /** Goes in the `system` role. */
  systemPrompt: string;
  /** Goes in the `user` role. By framework convention this is the
   *  formatted thread (latest message last) — see PromptMode.draft. */
  userContent: string;
  /** Audit/billing label. Counts under this purpose in the AI usage panel. */
  purpose: string;
  /** Number of completion variants to request (OpenAI `n` parameter).
   *  Defaults to 1, capped at 5. */
  count?: number;
  /** Defaults to 0.7. */
  temperature?: number;
  /** Defaults to 300. */
  maxTokens?: number;
}

export interface ChatVariant {
  /** Trimmed reply text. Empty string when SKIP. */
  body: string;
  /** True when the model returned literal "SKIP" or empty. Callers
   *  decide whether to respect or override (e.g. summon-on-trigger
   *  forces a non-skip via the prompt itself). */
  skipped: boolean;
}

export interface ChatCallResult {
  variants: ChatVariant[];
  /** Model id the API actually responded with (may be more specific
   *  than effectiveModel(), e.g. dated suffix). */
  model: string;
  usage?: UsageObj;
}

/** Send one chat completion. Records usage. Returns deduplicated
 *  variants. Modes call this via PromptMode.draft; non-mode features
 *  (classifier, etc.) can also call directly. */
export async function chat(opts: ChatCallOpts): Promise<ChatCallResult> {
  const client = getOpenAIClient();
  const count = Math.max(1, Math.min(5, Math.floor(opts.count ?? 1)));
  const resp = await client.chat.completions.create({
    model: effectiveModel(),
    messages: [
      { role: 'system', content: opts.systemPrompt },
      { role: 'user', content: opts.userContent },
    ],
    max_tokens: opts.maxTokens ?? 300,
    temperature: opts.temperature ?? 0.7,
    n: count,
  });
  const model = resp.model || effectiveModel();
  recordAiUsage({ purpose: opts.purpose, model, usage: resp.usage });

  const variants: ChatVariant[] = (resp.choices ?? []).map((choice) => {
    const raw = (choice.message?.content ?? '').trim();
    if (raw === 'SKIP' || raw === '') return { body: '', skipped: true };
    const body = raw.replace(/^["']|["']$/g, '').trim();
    return { body, skipped: false };
  });
  // Dedup identical variants — OpenAI sometimes returns the same string
  // multiple times when temperature is low; the caller only needs unique
  // options to pick from.
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
  return { variants: dedup.length ? dedup : variants, model, usage };
}

/* ------------------------------------------------------------------ */
/* tool-calling: multi-round chat completion with function calls       */
/* ------------------------------------------------------------------ */

/** OpenAI tool definition. Matches the SDK's `tools` parameter shape
 *  but expressed here so the tool registry can stay independent of
 *  the openai SDK types. */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for arguments. */
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

/** One executed tool call — preserved so the UI can render what the
 *  model called and what came back. */
export interface ToolCallRecord {
  name: string;
  arguments: Record<string, unknown>;
  /** Stringified result that the model saw. Truncated on display. */
  result: string;
  /** When the tool threw — error message goes back to the model too. */
  error?: string;
  ms: number;
}

export interface ChatWithToolsOpts {
  systemPrompt: string;
  /** Conversation messages (role: 'user' | 'assistant'). The system
   *  prompt is added separately. */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Tools available for this turn. The model may ignore them entirely. */
  tools: ToolDefinition[];
  purpose: string;
  temperature?: number;
  maxTokens?: number;
  /** Hard cap on tool-call rounds so a misbehaving model can't burn
   *  through tokens / API calls. Defaults to 6 — typically the model
   *  needs 1-3 rounds, but multi-step questions can chain more. */
  maxRounds?: number;
  /** Force the model to call this specific tool on the FIRST round.
   *  Subsequent rounds revert to 'auto' so the model can synthesize
   *  its natural-language reply normally. Used by upstream callers
   *  (e.g. galt-chat) when a pre-classifier is confident the user
   *  wants this specific action — bypasses the model's flaky default
   *  behavior of replying in prose without actually calling the
   *  tool. Set to the tool's `name`. */
  forceTool?: string;
}

export interface ChatWithToolsResult {
  /** The model's final natural-language reply. */
  reply: string;
  /** Every tool call executed during the turn, in order. Empty if
   *  the model answered directly. */
  toolCalls: ToolCallRecord[];
  model: string;
  /** Combined usage across all rounds. */
  usage?: UsageObj;
  /** Number of rounds actually executed. Useful for diagnostics. */
  rounds: number;
}

/** Run a tool-calling chat turn. Loops until the model returns a
 *  non-tool message or maxRounds is hit. Records usage on every
 *  round under the same purpose label. */
export async function chatWithTools(opts: ChatWithToolsOpts): Promise<ChatWithToolsResult> {
  const client = getOpenAIClient();
  const maxRounds = Math.max(1, Math.min(20, opts.maxRounds ?? 6));
  const model = effectiveModel();

  // Build the running message array. We mutate this between rounds —
  // append the assistant's tool_calls message, then tool result
  // messages, then go again.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const running: any[] = [
    { role: 'system', content: opts.systemPrompt },
    ...opts.messages,
  ];

  const toolByName = new Map(opts.tools.map((t) => [t.name, t]));
  const oaTools = opts.tools.map((t) => ({
    type: 'tool',
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
  // The SDK shape for chat.completions tools is wrapped in
  // { type: 'function', function: { ... } }. Map there.
  const sdkTools = oaTools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const toolCalls: ToolCallRecord[] = [];
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalTokens = 0;
  let finalModel = model;
  let finalReply = '';
  let rounds = 0;

  for (let i = 0; i < maxRounds; i++) {
    rounds = i + 1;
    // Only force the tool on the FIRST round. After it fires, the
    // model needs to be back on 'auto' so it can read the tool's
    // result and produce a natural-language reply.
    const toolChoice: 'auto' | { type: 'function'; function: { name: string } } =
      i === 0 && opts.forceTool && sdkTools.some((t) => t.function.name === opts.forceTool)
        ? { type: 'function', function: { name: opts.forceTool } }
        : 'auto';
    const resp = await client.chat.completions.create({
      model,
      messages: running,
      tools: sdkTools.length > 0 ? sdkTools : undefined,
      tool_choice: sdkTools.length > 0 ? toolChoice : undefined,
      max_tokens: opts.maxTokens ?? 800,
      temperature: opts.temperature ?? 0.7,
    });
    finalModel = resp.model || model;
    if (resp.usage) {
      totalPrompt     += resp.usage.prompt_tokens     ?? 0;
      totalCompletion += resp.usage.completion_tokens ?? 0;
      totalTokens     += resp.usage.total_tokens      ?? 0;
      recordAiUsage({ purpose: opts.purpose, model: finalModel, usage: resp.usage });
    }

    const choice = resp.choices?.[0];
    const msg = choice?.message;
    if (!msg) {
      finalReply = '';
      break;
    }

    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      // No tool calls — the model has finished.
      finalReply = (msg.content ?? '').trim();
      break;
    }

    // Push the assistant turn (with tool_calls) into the running history.
    running.push({
      role: 'assistant',
      content: msg.content ?? null,
      tool_calls: calls,
    });

    // Execute each call and append a tool-result message.
    for (const call of calls) {
      if (call.type !== 'function') continue;
      const fn = call.function;
      const name = fn?.name ?? '';
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = fn?.arguments ? JSON.parse(fn.arguments) : {};
      } catch {
        parsedArgs = {};
      }
      const tool = toolByName.get(name);
      const t0 = Date.now();
      let resultStr = '';
      let errMsg: string | undefined;
      if (!tool) {
        errMsg = `unknown tool: ${name}`;
        resultStr = JSON.stringify({ error: errMsg });
      } else {
        try {
          const out = await tool.execute(parsedArgs);
          resultStr = typeof out === 'string' ? out : JSON.stringify(out);
        } catch (err) {
          errMsg = (err as Error).message;
          resultStr = JSON.stringify({ error: errMsg });
        }
      }
      toolCalls.push({
        name,
        arguments: parsedArgs,
        result: resultStr,
        error: errMsg,
        ms: Date.now() - t0,
      });
      running.push({
        role: 'tool',
        tool_call_id: call.id,
        content: resultStr,
      });
    }
    // Loop continues; the model gets to see the tool results and
    // either keeps calling or returns a natural-language answer.
  }

  return {
    reply: finalReply,
    toolCalls,
    model: finalModel,
    usage: totalTokens
      ? { prompt_tokens: totalPrompt, completion_tokens: totalCompletion, total_tokens: totalTokens }
      : undefined,
    rounds,
  };
}
