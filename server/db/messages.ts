import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { config } from '../config.js';
import { resolveMessageText } from '../attributedbody.js';
import { getContactNameForHandle } from './contacts.js';

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
  /** Resolved from macOS Contacts AddressBook, when available. */
  contact_name: string | null;
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
    SELECT cmj.chat_id AS chat_id, MAX(m2.ROWID) AS max_msg_id
    FROM chat_message_join cmj
    JOIN message m2 ON m2.ROWID = cmj.message_id
    WHERE (m2.associated_message_type IS NULL OR m2.associated_message_type = 0)
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
    contact_name: getContactNameForHandle(r.identifier),
    last_text: resolveMessageText(r.last_text, r.last_attributedBody),
    last_date_ms: appleDateToUnixMs(r.last_date),
    last_is_from_me: (r.last_is_from_me ?? null) as 0 | 1 | null,
    last_message_rowid: r.last_message_rowid,
  }));
}

/** Tapback / reaction codes from chat.db's `message.associated_message_type`. */
const REACTION_NAME: Record<number, string> = {
  2000: 'loved',
  2001: 'liked',
  2002: 'disliked',
  2003: 'laughed',
  2004: 'emphasized',
  2005: 'questioned',
};
const REACTION_EMOJI: Record<number, string> = {
  2000: '❤️',
  2001: '👍',
  2002: '👎',
  2003: '😂',
  2004: '‼️',
  2005: '❓',
};

function isReaction(t: number | null | undefined): boolean {
  return t !== null && t !== undefined && t >= 2000 && t <= 3999;
}

function isActiveReaction(t: number): boolean {
  return t >= 2000 && t < 3000;
}

export interface Reaction {
  type: number;
  type_name: string;
  emoji: string;
  sender_handle: string | null;
  sender_contact_name: string | null;
  is_from_me: 0 | 1;
  date_ms: number | null;
}

export interface AttachmentInfo {
  rowid: number;
  filename: string;
  mime_type: string | null;
  transfer_name: string | null;
  total_bytes: number | null;
  is_image: boolean;
}

export interface MessageRow {
  id: number;
  guid: string;
  text: string | null;
  handle_id: number | null;
  handle: string | null;
  /** Resolved sender name (only populated for incoming messages with a known contact). */
  contact_name: string | null;
  date_ms: number | null;
  is_from_me: 0 | 1;
  service: string | null;
  chat_id: number | null;
  /** When the recipient's device confirmed delivery. Apple-epoch nanoseconds → unix ms. */
  date_delivered_ms: number | null;
  /** When the recipient marked the message as read (only populated when they have read receipts on). */
  date_read_ms: number | null;
  /** Reactions / tapbacks attached to this message (active only — removed reactions filtered out). */
  reactions: Reaction[];
  /** Attachments referenced by this message (images, gifs, files). */
  attachments: AttachmentInfo[];
  /** Threaded-reply target — the GUID of the message this is an inline reply to. */
  thread_originator_guid: string | null;
  /** The "part" of the originating message being replied to (Apple uses 0 for the whole message). */
  thread_originator_part: string | null;
  /** iOS 16+ message edits / unsends. Apple keeps the current text and stamps the moment of mutation. */
  date_edited_ms: number | null;
  date_retracted_ms: number | null;
  /** Expressive send style — Apple bundle id (e.g. `com.apple.MobileSMS.expressivesend.gentle`). */
  expressive_send_style_id: string | null;
  /** SMS subject-line (carrier preserves on email-to-SMS bridges). Usually null on iMessage. */
  subject: string | null;
  /** iMessage Apps payload identifier (Apple Pay, polls, games, stickers). */
  balloon_bundle_id: string | null;
  is_audio_message: 0 | 1;
  /** True when Apple's Data Detectors (dates/addresses/phones/flights) found something in this message. */
  has_dd_results: 0 | 1;
  /** System messages: 0/null = normal; non-zero = group-membership change (added, removed, renamed, …). */
  group_action_type: number | null;
  /** Which iMessage account sent it (multi-account users). */
  account_guid: string | null;
  account: string | null;
  /** Send-error code (0 = ok). Surfaces failed sends. */
  error: number | null;
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
  assoc_guid: string | null;
  assoc_type: number | null;
  date_delivered: number | bigint | null;
  date_read: number | bigint | null;
  thread_originator_guid: string | null;
  thread_originator_part: string | null;
  date_edited: number | bigint | null;
  date_retracted: number | bigint | null;
  expressive_send_style_id: string | null;
  subject: string | null;
  balloon_bundle_id: string | null;
  is_audio_message: number | null;
  has_dd_results: number | null;
  group_action_type: number | null;
  account_guid: string | null;
  account: string | null;
  error: number | null;
}

interface RawAttachmentRow {
  message_id: number;
  rowid: number;
  filename: string | null;
  mime_type: string | null;
  transfer_name: string | null;
  total_bytes: number | null;
}

// Apple's `message` table columns we lift here:
//  - ROWID, guid, text, attributedBody, date, is_from_me, service: bedrock
//  - associated_message_guid/type: tapbacks (folded into reactions[])
//  - date_delivered, date_read: receipt timestamps
//  - thread_originator_guid/part: Apple's inline-reply ("threaded reply")
//  - date_edited, date_retracted: iOS 16+ edit / unsend timestamps
//  - expressive_send_style_id: send effects ("slam", "fireworks", etc.)
//  - subject: SMS-with-subject (rare; non-null on email-to-SMS bridges)
//  - balloon_bundle_id: iMessage Apps payload (Apple Pay, polls, games)
//  - is_audio_message, has_dd_results: bool flags
//  - group_action_type: 0/null = normal; non-zero = group-membership system msg
//  - account, account_guid: which iMessage account sent it
//  - error: send-error code (0 = ok)
// All columns exist on every modern macOS chat.db (iOS 16+ era schema).
const MESSAGE_COLUMNS_SQL = `
  m.ROWID                       AS id,
  m.guid                        AS guid,
  m.text                        AS text,
  m.attributedBody              AS attributedBody,
  m.handle_id                   AS handle_id,
  h.id                          AS handle,
  m.date                        AS date,
  m.is_from_me                  AS is_from_me,
  m.service                     AS service,
  m.associated_message_guid     AS assoc_guid,
  m.associated_message_type     AS assoc_type,
  m.date_delivered              AS date_delivered,
  m.date_read                   AS date_read,
  m.thread_originator_guid      AS thread_originator_guid,
  m.thread_originator_part      AS thread_originator_part,
  m.date_edited                 AS date_edited,
  m.date_retracted              AS date_retracted,
  m.expressive_send_style_id    AS expressive_send_style_id,
  m.subject                     AS subject,
  m.balloon_bundle_id           AS balloon_bundle_id,
  m.is_audio_message            AS is_audio_message,
  m.has_dd_results              AS has_dd_results,
  m.group_action_type           AS group_action_type,
  m.account_guid                AS account_guid,
  m.account                     AS account,
  m.error                       AS error
`;

const MESSAGES_FOR_CHAT_SQL = `
  SELECT
    ${MESSAGE_COLUMNS_SQL},
    cmj.chat_id                 AS chat_id
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  WHERE cmj.chat_id = ?
    AND m.ROWID > ?
  ORDER BY m.date DESC
  LIMIT ?;
`;

const ATTACHMENTS_FOR_MESSAGES_SQL = `
  SELECT
    maj.message_id    AS message_id,
    a.ROWID           AS rowid,
    a.filename        AS filename,
    a.mime_type       AS mime_type,
    a.transfer_name   AS transfer_name,
    a.total_bytes     AS total_bytes
  FROM message_attachment_join maj
  JOIN attachment a ON a.ROWID = maj.attachment_id
  WHERE maj.message_id IN (__IDS__);
`;

function loadAttachmentsForMessageIds(ids: number[]): Map<number, AttachmentInfo[]> {
  const out = new Map<number, AttachmentInfo[]>();
  if (ids.length === 0) return out;
  const db = getChatDb();
  // SQLite doesn't bind list params; build an inline parameterized list.
  const placeholders = ids.map(() => '?').join(',');
  const sql = ATTACHMENTS_FOR_MESSAGES_SQL.replace('__IDS__', placeholders);
  const rows = db.prepare(sql).all(...ids) as RawAttachmentRow[];
  for (const r of rows) {
    if (!r.filename) continue;
    const mime = r.mime_type ?? '';
    const info: AttachmentInfo = {
      rowid: r.rowid,
      filename: r.filename,
      mime_type: r.mime_type,
      transfer_name: r.transfer_name,
      total_bytes: r.total_bytes,
      is_image: mime.startsWith('image/'),
    };
    const list = out.get(r.message_id);
    if (list) list.push(info);
    else out.set(r.message_id, [info]);
  }
  return out;
}

/**
 * Process a chronologically-DESC raw row list:
 * - Split real messages from reaction (tapback) rows.
 * - Group reactions by (sender, target_guid), keep latest per pair.
 * - Attach active reactions to their target messages.
 * - Pull attachments per message_id and attach.
 * Returns ONLY real messages (tapbacks are not surfaced as bubbles).
 */
function processRawMessages(rowsDesc: RawMessageRow[]): MessageRow[] {
  const real: MessageRow[] = [];
  const realByGuid = new Map<string, MessageRow>();
  for (const r of rowsDesc) {
    if (isReaction(r.assoc_type)) continue;
    const m = toMessageRow(r);
    real.push(m);
    realByGuid.set(m.guid, m);
  }

  // Reactions in chronological order so "latest per sender+target" wins.
  const reactionsAsc = rowsDesc.filter((r) => isReaction(r.assoc_type)).reverse();
  const latest = new Map<string, RawMessageRow>();
  for (const r of reactionsAsc) {
    if (!r.assoc_guid) continue;
    const senderKey = r.is_from_me ? '__me__' : r.handle ?? '__null__';
    latest.set(`${senderKey}::${r.assoc_guid}`, r);
  }
  for (const r of latest.values()) {
    if (!isActiveReaction(r.assoc_type!)) continue;
    const target = realByGuid.get(r.assoc_guid!);
    if (!target) continue;
    target.reactions.push({
      type: r.assoc_type!,
      type_name: REACTION_NAME[r.assoc_type!] || 'unknown',
      emoji: REACTION_EMOJI[r.assoc_type!] || '·',
      sender_handle: r.handle,
      sender_contact_name: r.is_from_me ? null : getContactNameForHandle(r.handle),
      is_from_me: (r.is_from_me ? 1 : 0) as 0 | 1,
      date_ms: appleDateToUnixMs(r.date),
    });
  }

  // Attachments for the surviving real messages.
  const ids = real.map((m) => m.id);
  const byMsg = loadAttachmentsForMessageIds(ids);
  for (const m of real) {
    const atts = byMsg.get(m.id);
    if (atts && atts.length) m.attachments = atts;
  }

  return real;
}

export function listMessagesForChat(chatId: number, sinceRowid = 0, limit = 200): MessageRow[] {
  const db = getChatDb();
  const rows = db.prepare(MESSAGES_FOR_CHAT_SQL).all(chatId, sinceRowid, limit) as RawMessageRow[];
  return processRawMessages(rows);
}

const RECENT_MESSAGES_SQL = `
  SELECT
    ${MESSAGE_COLUMNS_SQL},
    cmj.chat_id                 AS chat_id
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
  return processRawMessages(rows);
}

function toMessageRow(r: RawMessageRow): MessageRow {
  const isFromMe = (r.is_from_me ? 1 : 0) as 0 | 1;
  return {
    id: r.id,
    guid: r.guid,
    text: resolveMessageText(r.text, r.attributedBody),
    handle_id: r.handle_id,
    handle: r.handle,
    contact_name: isFromMe ? null : getContactNameForHandle(r.handle),
    date_ms: appleDateToUnixMs(r.date),
    is_from_me: isFromMe,
    service: r.service,
    chat_id: r.chat_id,
    date_delivered_ms: appleDateToUnixMs(r.date_delivered),
    date_read_ms: appleDateToUnixMs(r.date_read),
    reactions: [],
    attachments: [],
    thread_originator_guid: r.thread_originator_guid,
    thread_originator_part: r.thread_originator_part,
    date_edited_ms: appleDateToUnixMs(r.date_edited),
    date_retracted_ms: appleDateToUnixMs(r.date_retracted),
    expressive_send_style_id: r.expressive_send_style_id,
    subject: r.subject,
    balloon_bundle_id: r.balloon_bundle_id,
    is_audio_message: (r.is_audio_message ? 1 : 0) as 0 | 1,
    has_dd_results: (r.has_dd_results ? 1 : 0) as 0 | 1,
    group_action_type: r.group_action_type,
    account_guid: r.account_guid,
    account: r.account,
    error: r.error,
  };
}

export function getMaxMessageRowid(): number {
  const db = getChatDb();
  const row = db.prepare('SELECT MAX(ROWID) AS max_rowid FROM message').get() as
    | { max_rowid: number | null }
    | undefined;
  return row?.max_rowid ?? 0;
}

const SENT_MESSAGES_SQL = `
  SELECT
    ${MESSAGE_COLUMNS_SQL},
    cmj.chat_id                 AS chat_id
  FROM message m
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  WHERE m.is_from_me = 1
    AND (m.associated_message_type IS NULL OR m.associated_message_type = 0)
  ORDER BY m.date DESC
  LIMIT ?;
`;

/**
 * Pull the most recent N messages the user themselves sent. Used by the
 * voice-profile generator to learn the user's style across the corpus,
 * not just within a single thread. Reactions/tapbacks excluded.
 */
export function listSentMessages(limit = 200): MessageRow[] {
  const db = getChatDb();
  const rows = db.prepare(SENT_MESSAGES_SQL).all(limit) as RawMessageRow[];
  return rows.map(toMessageRow).filter((r) => r.text !== null);
}

/**
 * Resolve which Messages.app service to use when sending to `handle`.
 * Reads the most recent message exchanged with this handle and returns the
 * service Apple actually used. AppleScript's Messages dialect only knows
 * `iMessage` and `SMS` service types — RCS chats ride the SMS slot, so
 * anything that isn't `iMessage` collapses to `SMS`.
 *
 * Returns null when the handle has no message history in chat.db; callers
 * should fall back to a sensible default (iMessage for unknown).
 */
export function getServiceForHandle(handle: string): 'iMessage' | 'SMS' | null {
  if (!handle) return null;
  const db = getChatDb();
  const row = db.prepare(`
    SELECT m.service AS service
    FROM message m
    JOIN handle h ON h.ROWID = m.handle_id
    WHERE h.id = ?
    ORDER BY m.date DESC
    LIMIT 1
  `).get(handle) as { service: string | null } | undefined;
  if (!row || !row.service) return null;
  return row.service === 'iMessage' ? 'iMessage' : 'SMS';
}

/* ============================================================
   Chat-aware send target resolution
   ============================================================
   Apple identifies a 1:1 chat by the recipient handle (a phone or
   email) and a group chat by `chat.guid` (e.g. `iMessage;+;chat<id>`).
   AppleScript's Messages dialect uses different syntax for each:

     1:1   →  send X to buddy "+15551234567" of <service>
     group →  send X to chat id "iMessage;+;chat123456789"

   `getChatTarget(chatId)` is the single source of truth for which
   form to use when sending — read once, dispatch in send.ts. */
export interface ChatTarget {
  /** chat.db chat.ROWID */
  chatId: number;
  /** chat.db chat.guid — the AppleScript-addressable form for groups. */
  chatGuid: string;
  /** chat.db chat.chat_identifier — the handle (1:1) or `chat<id>` (groups). */
  chatIdentifier: string;
  /** Number of distinct participants per chat_handle_join. 1 = 1:1, >1 = group. */
  participantCount: number;
  /** True when the chat has more than one participant (a group). */
  isGroup: boolean;
  /** For 1:1 chats, the recipient handle. Null for groups. */
  handle: string | null;
  /** Apple's service id (`iMessage`, `SMS`, sometimes others); collapsed to
   *  the two AppleScript actually accepts elsewhere. */
  serviceName: string | null;
  /** Group display name (`chat.display_name`), if the chat has been named. */
  groupTitle: string | null;
}

export function getChatTarget(chatId: number): ChatTarget | null {
  const db = getChatDb();
  const chatRow = db.prepare(`
    SELECT
      c.ROWID            AS id,
      c.guid             AS guid,
      c.chat_identifier  AS identifier,
      c.service_name     AS service_name,
      c.display_name     AS display_name
    FROM chat c
    WHERE c.ROWID = ?
  `).get(chatId) as
    | {
        id: number;
        guid: string;
        identifier: string;
        service_name: string | null;
        display_name: string | null;
      }
    | undefined;
  if (!chatRow) return null;

  const participantsRow = db.prepare(`
    SELECT COUNT(DISTINCT chj.handle_id) AS n
    FROM chat_handle_join chj
    WHERE chj.chat_id = ?
  `).get(chatId) as { n: number } | undefined;
  const participantCount = participantsRow?.n ?? 0;

  // A 1:1 chat has exactly one *other* participant (the user themselves
  // is not in chat_handle_join). Groups have 2+. Apple sometimes records
  // an empty group as 0 — treat as 1:1 fallback to be safe.
  const isGroup = participantCount > 1;

  // For 1:1, prefer the handle from chat_handle_join (canonical) and fall
  // back to chat_identifier if the join is empty.
  let handle: string | null = null;
  if (!isGroup) {
    const handleRow = db.prepare(`
      SELECT h.id AS handle
      FROM chat_handle_join chj
      JOIN handle h ON h.ROWID = chj.handle_id
      WHERE chj.chat_id = ?
      LIMIT 1
    `).get(chatId) as { handle: string | null } | undefined;
    handle = handleRow?.handle ?? chatRow.identifier;
  }

  return {
    chatId: chatRow.id,
    chatGuid: chatRow.guid,
    chatIdentifier: chatRow.identifier,
    participantCount,
    isGroup,
    handle,
    serviceName: chatRow.service_name,
    groupTitle: chatRow.display_name,
  };
}
