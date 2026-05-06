import OpenAI from 'openai';
import { config } from './config.js';

let _client: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (!config.openai.apiKey) {
    throw new Error(
      'OPENAI_API_KEY is not set. Add it to .env to enable AI features (V1 step 3+).',
    );
  }
  if (!_client) _client = new OpenAI({ apiKey: config.openai.apiKey });
  return _client;
}

/**
 * V1 step 3+ entrypoints. Stubbed for the foundation — wire them up
 * when classification + draft generation come online.
 */

export interface ClassificationResult {
  shouldRespond: boolean;
  category: 'question' | 'scheduling' | 'urgent' | 'casual' | 'other';
  confidence: number;
  reasoning?: string;
}

export async function classifyIncoming(_text: string): Promise<ClassificationResult> {
  throw new Error('classifyIncoming() is a V1 step 3 stub — not yet implemented');
}

export async function draftReply(_input: {
  thread: { author: 'me' | 'them'; text: string }[];
  contextNote?: string;
}): Promise<{ body: string; reasoning?: string }> {
  throw new Error('draftReply() is a V1 step 5 stub — not yet implemented');
}
