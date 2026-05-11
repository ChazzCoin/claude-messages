// Google Chat API integration — REST client using ADC (Application Default
// Credentials). Requires the ADC file to include chat scopes:
//
//   gcloud auth application-default login \
//     --scopes=https://www.googleapis.com/auth/cloud-platform,\
//   https://www.googleapis.com/auth/chat.messages,\
//   https://www.googleapis.com/auth/chat.spaces,\
//   https://www.googleapis.com/auth/chat.messages.create
//
// Uses google-auth-library (already installed for Firebase) + Node native
// fetch. No extra dependencies.
//
// API reference: https://developers.google.com/workspace/chat/api/reference/rest

import { GoogleAuth, type AuthClient } from 'google-auth-library';

/* ------------------------------------------------------------------ */
/* auth                                                                */
/* ------------------------------------------------------------------ */

const CHAT_SCOPES = [
  'https://www.googleapis.com/auth/chat.messages',
  'https://www.googleapis.com/auth/chat.spaces',
  'https://www.googleapis.com/auth/chat.messages.create',
];

let _auth: GoogleAuth | null = null;
let _client: AuthClient | null = null;

function getAuth(): GoogleAuth {
  if (!_auth) _auth = new GoogleAuth({ scopes: CHAT_SCOPES });
  return _auth;
}

async function authHeaders(): Promise<Record<string, string>> {
  if (!_client) _client = await getAuth().getClient();
  const token = await _client.getAccessToken();
  if (!token.token) throw new Error('[gchat] failed to obtain access token');
  return { Authorization: `Bearer ${token.token}` };
}

/** Quick auth check — returns true if we can get a token. */
export async function checkAuth(): Promise<{ ok: boolean; error?: string }> {
  try {
    await authHeaders();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */

export interface GChatSpace {
  /** Full resource name: "spaces/XXXXXXX" */
  name: string;
  displayName: string;
  /** SPACE | GROUP_CHAT | DIRECT_MESSAGE */
  spaceType: string;
}

export interface GChatMessage {
  /** Full resource name: "spaces/XXX/messages/YYY" */
  name: string;
  spaceName: string;
  senderName: string;
  /** HUMAN | BOT */
  senderType: 'HUMAN' | 'BOT';
  text: string;
  createTime: string;   // ISO-8601
  threadName: string | null;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function parseSpace(raw: unknown): GChatSpace {
  const r = raw as Record<string, unknown>;
  return {
    name: String(r.name ?? ''),
    displayName: String(r.displayName ?? r.name ?? ''),
    spaceType: String(r.spaceType ?? 'SPACE'),
  };
}

function parseMessage(raw: unknown): GChatMessage {
  const r = raw as Record<string, unknown>;
  const sender = r.sender as Record<string, unknown> | undefined;
  // name = "spaces/XXX/messages/YYY" — space is the first two segments
  const name = String(r.name ?? '');
  const spaceName = name.split('/').slice(0, 2).join('/');
  return {
    name,
    spaceName,
    senderName: String(sender?.displayName ?? sender?.name ?? 'Unknown'),
    senderType: sender?.type === 'BOT' ? 'BOT' : 'HUMAN',
    text: String(r.text ?? r.formattedText ?? ''),
    createTime: String(r.createTime ?? ''),
    threadName: r.thread ? String((r.thread as Record<string, unknown>).name ?? '') || null : null,
  };
}

async function chatFetch(path: string, init?: RequestInit): Promise<unknown> {
  const headers = {
    ...await authHeaders(),
    'Content-Type': 'application/json',
    ...(init?.headers ?? {}),
  };
  const res = await fetch(`https://chat.googleapis.com/v1/${path}`, {
    ...init,
    headers,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`[gchat] ${init?.method ?? 'GET'} /${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

/* ------------------------------------------------------------------ */
/* public API                                                          */
/* ------------------------------------------------------------------ */

/** List all Chat spaces the authenticated user is a member of. */
export async function listSpaces(): Promise<GChatSpace[]> {
  const spaces: GChatSpace[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ pageSize: '100' });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await chatFetch(`spaces?${params}`) as Record<string, unknown>;
    const page = (data.spaces ?? []) as unknown[];
    spaces.push(...page.map(parseSpace));
    pageToken = data.nextPageToken as string | undefined;
  } while (pageToken);
  return spaces;
}

/** Get a single space by name. */
export async function getSpace(spaceName: string): Promise<GChatSpace> {
  const data = await chatFetch(spaceName);
  return parseSpace(data);
}

/**
 * List messages in a space, optionally since a given ISO timestamp.
 * Uses the `createTime > "..."` filter for efficient polling.
 * Handles pagination automatically — returns all new messages at once.
 */
export async function listMessages(
  spaceName: string,
  since?: string,
): Promise<GChatMessage[]> {
  const messages: GChatMessage[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      pageSize: '200',
      orderBy: 'createTime ASC',
    });
    if (since) params.set('filter', `createTime > "${since}"`);
    if (pageToken) params.set('pageToken', pageToken);
    const data = await chatFetch(`${spaceName}/messages?${params}`) as Record<string, unknown>;
    const page = (data.messages ?? []) as unknown[];
    messages.push(...page.map(parseMessage));
    pageToken = data.nextPageToken as string | undefined;
  } while (pageToken);
  return messages;
}

/** Send a plain-text message to a space. Returns the created message. */
export async function sendMessage(
  spaceName: string,
  text: string,
): Promise<GChatMessage> {
  const data = await chatFetch(`${spaceName}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
  return parseMessage(data);
}

/** Singleton convenience export — stateless, safe to share. */
export const googleChat = {
  checkAuth,
  listSpaces,
  getSpace,
  listMessages,
  sendMessage,
};
