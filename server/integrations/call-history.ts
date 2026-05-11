// Call history reader — read-only access to macOS's CallHistoryDB.
//
// Apple stores phone + FaceTime call records at
//   ~/Library/Application Support/CallHistoryDB/CallHistory.storedata
// as a Core Data sqlite. Same Full Disk Access grant the chat.db
// reader uses — no extra permission prompts.
//
// Schema (Apple's, may shift across macOS versions — current as of
// macOS 14):
//   table ZCALLRECORD
//     Z_PK             integer pk
//     ZDATE            real, Mac epoch (seconds since 2001-01-01)
//     ZDURATION        real, seconds
//     ZADDRESS         blob, the other party's phone/email
//     ZNAME            text, from contacts at the time of call
//     ZORIGINATED      integer, 1 = outgoing, 0 = incoming
//     ZANSWERED        integer, 1 = answered, 0 = missed
//     ZCALLTYPE        integer, 1 = phone, 8 = facetime audio,
//                      16 = facetime video (varies by macOS)
//     ZSERVICE_PROVIDER text — 'TINCanService' (FaceTime), etc.
//
// We open the db read-only, fail fast on permission errors (so the
// caller can surface a useful message back to Galt), and convert the
// Mac epoch into Unix ms before returning.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import Database, { type Database as DB } from 'better-sqlite3';

const CALL_HISTORY_DB_PATH = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'CallHistoryDB',
  'CallHistory.storedata',
);

let _db: DB | null = null;

function appleSecondsToUnixMs(raw: number | null | undefined): number | null {
  if (raw == null) return null;
  // Mac epoch is 2001-01-01 00:00:00 UTC.
  // Unix epoch is 1970-01-01 00:00:00 UTC.
  // Diff = 978307200 seconds.
  return Math.round((raw + 978307200) * 1000);
}

function getDb(): DB {
  if (_db) return _db;
  if (!fs.existsSync(CALL_HISTORY_DB_PATH)) {
    throw new Error(`CallHistory.storedata not found at ${CALL_HISTORY_DB_PATH}`);
  }
  _db = new Database(CALL_HISTORY_DB_PATH, { readonly: true, fileMustExist: true });
  return _db;
}

export function closeCallHistoryDb(): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
  }
}

export interface CallRecord {
  /** Unix ms when the call started. */
  date_ms: number | null;
  /** Duration in seconds. */
  duration_s: number;
  /** Phone or email of the other party. */
  address: string;
  /** Display name from the system address book at the time of call.
   *  Null if unknown. */
  name: string | null;
  /** 'outgoing' | 'incoming'. */
  direction: 'outgoing' | 'incoming';
  /** Whether the call was answered. Missed = answered === false. */
  answered: boolean;
  /** Best-effort label. 'phone' | 'facetime_audio' | 'facetime_video' | 'unknown'. */
  kind: 'phone' | 'facetime_audio' | 'facetime_video' | 'unknown';
  /** Service provider string from the row, for debugging. */
  service: string | null;
}

export interface ListCallsOptions {
  /** Max rows to return. Capped at 500. */
  limit?: number;
  /** If set, only calls newer than this Unix ms. */
  sinceMs?: number;
  /** Optional substring match against address or name (case-insensitive). */
  match?: string;
}

function kindForCallType(callType: number | null): CallRecord['kind'] {
  // Apple has shipped at least three numbering schemes across macOS
  // versions. These are the most common observed values:
  if (callType === 1) return 'phone';
  if (callType === 8) return 'facetime_audio';
  if (callType === 16) return 'facetime_video';
  return 'unknown';
}

/** List the most recent N calls, optionally filtered. */
export function listRecentCalls(opts: ListCallsOptions = {}): CallRecord[] {
  const db = getDb();
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (opts.sinceMs && opts.sinceMs > 0) {
    // Convert back to Mac epoch.
    const macSec = (opts.sinceMs / 1000) - 978307200;
    conditions.push('ZDATE >= ?');
    params.push(macSec);
  }
  if (opts.match && opts.match.trim()) {
    const like = `%${opts.match.replace(/[%_]/g, (m) => '\\' + m).trim()}%`;
    conditions.push('(ZADDRESS LIKE ? OR ZNAME LIKE ?)');
    params.push(like, like);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit);

  const rows = db.prepare(`
    SELECT
      ZDATE              AS date,
      ZDURATION          AS duration,
      ZADDRESS           AS address,
      ZNAME              AS name,
      ZORIGINATED        AS originated,
      ZANSWERED          AS answered,
      ZCALLTYPE          AS call_type,
      ZSERVICE_PROVIDER  AS service
    FROM ZCALLRECORD
    ${where}
    ORDER BY ZDATE DESC
    LIMIT ?
  `).all(...params) as Array<{
    date: number | null;
    duration: number | null;
    address: Buffer | string | null;
    name: string | null;
    originated: number | null;
    answered: number | null;
    call_type: number | null;
    service: string | null;
  }>;

  return rows.map((r) => {
    const addr =
      Buffer.isBuffer(r.address) ? r.address.toString('utf8').replace(/\0+$/, '')
      : typeof r.address === 'string' ? r.address
      : '';
    return {
      date_ms: appleSecondsToUnixMs(r.date),
      duration_s: r.duration ? Math.round(r.duration) : 0,
      address: addr,
      name: r.name || null,
      direction: r.originated ? 'outgoing' : 'incoming',
      answered: !!r.answered,
      kind: kindForCallType(r.call_type),
      service: r.service || null,
    } as CallRecord;
  });
}

/** Returns true if the CallHistory db is readable. */
export function isCallHistoryReadable(): boolean {
  try {
    const db = getDb();
    db.prepare('SELECT 1 FROM ZCALLRECORD LIMIT 1').get();
    return true;
  } catch {
    return false;
  }
}
