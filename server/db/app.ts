import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { config } from '../config.js';

let _db: DB | null = null;

export function getAppDb(): DB {
  if (_db) return _db;
  _db = new Database(config.appDbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  migrate(_db);
  return _db;
}

export function closeAppDb() {
  _db?.close();
  _db = null;
}

function migrate(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS watched_contacts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      handle       TEXT NOT NULL UNIQUE,    -- phone or email as it appears in chat.db handle.id
      label        TEXT,
      created_at   INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS rules (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      pattern      TEXT NOT NULL,           -- regex string for fast-layer match
      flags        TEXT NOT NULL DEFAULT 'i',
      enabled      INTEGER NOT NULL DEFAULT 1,
      created_at   INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS drafts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source_msg_guid TEXT NOT NULL,        -- chat.db message.guid that triggered this draft
      chat_id         INTEGER NOT NULL,     -- chat.db chat.ROWID
      handle          TEXT NOT NULL,        -- recipient handle (phone/email)
      body            TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'sent', 'discarded', 'edited')),
      reasoning       TEXT,                 -- optional model rationale
      created_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      decided_at      INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
    CREATE INDEX IF NOT EXISTS idx_drafts_chat   ON drafts(chat_id);

    CREATE TABLE IF NOT EXISTS state (
      key          TEXT PRIMARY KEY,
      value        TEXT NOT NULL
    );
  `);
}

/* ---------- state helpers ---------- */

export function getState(key: string): string | null {
  const db = getAppDb();
  const row = db.prepare('SELECT value FROM state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setState(key: string, value: string): void {
  const db = getAppDb();
  db.prepare(
    'INSERT INTO state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  ).run(key, value);
}

/* ---------- watched contacts ---------- */

export interface WatchedContact {
  id: number;
  handle: string;
  label: string | null;
  created_at: number;
}

export function listWatched(): WatchedContact[] {
  const db = getAppDb();
  return db
    .prepare('SELECT id, handle, label, created_at FROM watched_contacts ORDER BY id DESC')
    .all() as WatchedContact[];
}

export function addWatched(handle: string, label: string | null): WatchedContact {
  const db = getAppDb();
  const info = db
    .prepare('INSERT OR IGNORE INTO watched_contacts(handle, label) VALUES (?, ?)')
    .run(handle, label);
  const id =
    info.changes > 0
      ? (info.lastInsertRowid as number)
      : (db.prepare('SELECT id FROM watched_contacts WHERE handle = ?').get(handle) as { id: number })
          .id;
  return db
    .prepare('SELECT id, handle, label, created_at FROM watched_contacts WHERE id = ?')
    .get(id) as WatchedContact;
}

export function removeWatched(id: number): boolean {
  const db = getAppDb();
  return db.prepare('DELETE FROM watched_contacts WHERE id = ?').run(id).changes > 0;
}

/* ---------- rules ---------- */

export interface Rule {
  id: number;
  name: string;
  pattern: string;
  flags: string;
  enabled: 0 | 1;
  created_at: number;
}

export function listRules(): Rule[] {
  const db = getAppDb();
  return db
    .prepare('SELECT id, name, pattern, flags, enabled, created_at FROM rules ORDER BY id DESC')
    .all() as Rule[];
}

export function addRule(name: string, pattern: string, flags = 'i'): Rule {
  // Validate regex up-front so a bad pattern doesn't poison the watcher loop.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _check = new RegExp(pattern, flags);
  const db = getAppDb();
  const info = db
    .prepare('INSERT INTO rules(name, pattern, flags) VALUES (?, ?, ?)')
    .run(name, pattern, flags);
  return db
    .prepare('SELECT id, name, pattern, flags, enabled, created_at FROM rules WHERE id = ?')
    .get(info.lastInsertRowid) as Rule;
}

export function setRuleEnabled(id: number, enabled: boolean): boolean {
  const db = getAppDb();
  return (
    db.prepare('UPDATE rules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id).changes > 0
  );
}

export function removeRule(id: number): boolean {
  const db = getAppDb();
  return db.prepare('DELETE FROM rules WHERE id = ?').run(id).changes > 0;
}

/* ---------- drafts ---------- */

export interface Draft {
  id: number;
  source_msg_guid: string;
  chat_id: number;
  handle: string;
  body: string;
  status: 'pending' | 'sent' | 'discarded' | 'edited';
  reasoning: string | null;
  created_at: number;
  decided_at: number | null;
}

export function listDrafts(status?: Draft['status']): Draft[] {
  const db = getAppDb();
  if (status) {
    return db
      .prepare(
        'SELECT id, source_msg_guid, chat_id, handle, body, status, reasoning, created_at, decided_at FROM drafts WHERE status = ? ORDER BY id DESC',
      )
      .all(status) as Draft[];
  }
  return db
    .prepare(
      'SELECT id, source_msg_guid, chat_id, handle, body, status, reasoning, created_at, decided_at FROM drafts ORDER BY id DESC',
    )
    .all() as Draft[];
}

export function getDraft(id: number): Draft | null {
  const db = getAppDb();
  const row = db
    .prepare(
      'SELECT id, source_msg_guid, chat_id, handle, body, status, reasoning, created_at, decided_at FROM drafts WHERE id = ?',
    )
    .get(id) as Draft | undefined;
  return row ?? null;
}

export function createDraft(
  input: Pick<Draft, 'source_msg_guid' | 'chat_id' | 'handle' | 'body'> & {
    reasoning?: string | null;
  },
): Draft {
  const db = getAppDb();
  const info = db
    .prepare(
      'INSERT INTO drafts(source_msg_guid, chat_id, handle, body, reasoning) VALUES (?, ?, ?, ?, ?)',
    )
    .run(input.source_msg_guid, input.chat_id, input.handle, input.body, input.reasoning ?? null);
  return getDraft(info.lastInsertRowid as number)!;
}

export function updateDraftStatus(
  id: number,
  status: Draft['status'],
  bodyOverride?: string,
): Draft | null {
  const db = getAppDb();
  if (bodyOverride !== undefined) {
    db.prepare(
      "UPDATE drafts SET body = ?, status = ?, decided_at = strftime('%s','now')*1000 WHERE id = ?",
    ).run(bodyOverride, status, id);
  } else {
    db.prepare(
      "UPDATE drafts SET status = ?, decided_at = strftime('%s','now')*1000 WHERE id = ?",
    ).run(status, id);
  }
  return getDraft(id);
}
