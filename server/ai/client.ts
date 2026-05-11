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
