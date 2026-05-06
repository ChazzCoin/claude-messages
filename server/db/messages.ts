import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { config } from '../config.js';
import { resolveMessageText } from '../attributedbody.js';

/**
 * Apple stores `message.date` as nanoseconds since 2001-01-01 UTC on
 * modern macOS (iOS 15+ era schema). Older schemas use seconds.
 * The threshold cleanly separates them: a value > 10^14 is nanoseconds.
 */
const APPLE_EPOCH_OFFSET_MS = 978307200_000;

export function appleDateToUnixMs(raw: number | bigint | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'bigint' ? Number(raw) : raw;
  if (!Number.isFinite(n)) return null;
  if (n === 0) return null;
  if (n > 1e14) {
    return Math.floor(n / 1_000_000) + APPLE_EPOCH_OFFSET_MS;
  }
  return n * 1000 + APPLE_EPOCH_OFFSET_MS;
}

let _db: DB | null = null;

export function getChatDb(): DB {
  if (_db) return _db;
  _db = new Database(config.chatDbPath, { readonly: true, fileMustExist: true });
  // SQLite WAL files next to chat.db; readonly mode tolerates them.
  _db.pragma('journal_mode'); // no-op read; keeps better-sqlite3 happy on readonly
  return _db;
}

export function closeChatDb() {
  _db?.close();
  _db = null;
}

export interface ChatSummary {
  id: number;
  guid: string;
  identifier: string;
  display_name: string | null;
  service_name: string | null;
  last_text: string | null;
  last_date_ms: number | null;
  last_is_from_me: 0 | 1 | null;
  last_message_rowid: number | null;
}

interface ChatSummaryRow {
  id: number;
  guid: string;
  identifier: string;
  display_name: string | null;
  service_name: string | null;
  last_text: string | null;
  last_attributedBody: Buffer | null;
  last_date: number | bigint | null;
  last_is_from_me: number | null;
  last_message_rowid: number | null;
}

const CHAT_SUMMARIES_SQL = `
  SELECT
    c.ROWID            AS id,
    c.guid             AS guid,
    c.chat_identifier  AS identifier,
    c.display_name     AS display_name,
    c.service_name     AS service_name,
    m.text             AS last_text,
    m.attributedBody   AS last_attributedBody,
    m.date             AS last_date,
    m.is_from_me       AS last_is_from_me,
    m.ROWID            AS last_message_rowid
  FROM chat c
  JOIN (
    SELECT cmj.chat_id AS chat_id, MAX(cmj.message_id) AS max_msg_id
    FROM chat_message_join cmj
    GROUP BY cmj.chat_id
  ) latest ON latest.chat_id = c.ROWID
  JOIN message m ON m.ROWID = latest.max_msg_id
  ORDER BY m.date DESC
  LIMIT ?;
`;

export function listChats(limit = 100): ChatSummary[] {
  const db = getChatDb();
  const rows = db.prepare(CHAT_SUMMARIES_SQL).all(limit) as ChatSummaryRow[];
  return rows.map((r) => ({
    id: r.id,
    guid: r.guid,
    identifier: r.identifier,
    display_name: r.display_name,
    service_name: r.service_name,
    last_text: resolveMessageText(r.last_text, r.last_attributedBody),
    last_date_ms: appleDateToUnixMs(r.last_date),
    last_is_from_me: (r.last_is_from_me ?? null) as 0 | 1 | null,
    last_message_rowid: r.last_message_rowid,
  }));
}

export interface MessageRow {
  id: number;
  guid: string;
  text: string | null;
  handle_id: number | null;
  handle: string | null;
  date_ms: number | null;
  is_from_me: 0 | 1;
  service: string | null;
  chat_id: number | null;
}

interface RawMessageRow {
  id: number;
  guid: string;
  text: string | null;
  attributedBody: Buffer | null;
  handle_id: number | null;
  handle: string | null;
  date: number | bigint | null;
  is_from_me: number;
  service: string | null;
  chat_id: number | null;
}

const MESSAGES_FOR_CHAT_SQL = `
  SELECT
    m.ROWID          AS id,
    m.guid           AS guid,
    m.text           AS text,
    m.attributedBody AS attributedBody,
    m.handle_id      AS handle_id,
    h.id             AS handle,
    m.date           AS date,
    m.is_from_me     AS is_from_me,
    m.service        AS service,
    cmj.chat_id      AS chat_id
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  WHERE cmj.chat_id = ?
    AND m.ROWID > ?
  ORDER BY m.date DESC
  LIMIT ?;
`;

export function listMessagesForChat(chatId: number, sinceRowid = 0, limit = 200): MessageRow[] {
  const db = getChatDb();
  const rows = db.prepare(MESSAGES_FOR_CHAT_SQL).all(chatId, sinceRowid, limit) as RawMessageRow[];
  return rows.map(toMessageRow);
}

const RECENT_MESSAGES_SQL = `
  SELECT
    m.ROWID          AS id,
    m.guid           AS guid,
    m.text           AS text,
    m.attributedBody AS attributedBody,
    m.handle_id      AS handle_id,
    h.id             AS handle,
    m.date           AS date,
    m.is_from_me     AS is_from_me,
    m.service        AS service,
    cmj.chat_id      AS chat_id
  FROM message m
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  WHERE m.ROWID > ?
  ORDER BY m.date DESC
  LIMIT ?;
`;

export function listRecentMessages(sinceRowid = 0, limit = 100): MessageRow[] {
  const db = getChatDb();
  const rows = db.prepare(RECENT_MESSAGES_SQL).all(sinceRowid, limit) as RawMessageRow[];
  return rows.map(toMessageRow);
}

function toMessageRow(r: RawMessageRow): MessageRow {
  return {
    id: r.id,
    guid: r.guid,
    text: resolveMessageText(r.text, r.attributedBody),
    handle_id: r.handle_id,
    handle: r.handle,
    date_ms: appleDateToUnixMs(r.date),
    is_from_me: (r.is_from_me ? 1 : 0) as 0 | 1,
    service: r.service,
    chat_id: r.chat_id,
  };
}

export function getMaxMessageRowid(): number {
  const db = getChatDb();
  const row = db.prepare('SELECT MAX(ROWID) AS max_rowid FROM message').get() as
    | { max_rowid: number | null }
    | undefined;
  return row?.max_rowid ?? 0;
}
