import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { config } from '../config.js';
import { normalizeHandle } from './contacts.js';

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
                       CHECK (status IN ('pending', 'sent', 'discarded', 'edited', 'staged')),
      reasoning       TEXT,                 -- optional model rationale
      created_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      decided_at      INTEGER,
      staged_at       INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
    CREATE INDEX IF NOT EXISTS idx_drafts_chat   ON drafts(chat_id);

    CREATE TABLE IF NOT EXISTS contact_notes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      handle       TEXT NOT NULL,           -- chat.db handle (phone/email) — 1:1 chats only for now
      body         TEXT NOT NULL,
      created_at   INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_contact_notes_handle ON contact_notes(handle);

    -- AI-driven monitor rules. kind='flag' is the user-defined match-and-flag
    -- pipeline; kind='calendar' triggers auto-event extraction on matching messages.
    CREATE TABLE IF NOT EXISTS monitor_rules (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      kind          TEXT NOT NULL DEFAULT 'flag'
                     CHECK (kind IN ('flag', 'calendar')),
      scope_type    TEXT NOT NULL CHECK (scope_type IN ('contact', 'unknown', 'all')),
      scope_handle  TEXT,                    -- required when scope_type='contact'
      prompt        TEXT NOT NULL DEFAULT '',-- match criterion for flag-kind; ignored for calendar
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_monitor_rules_enabled ON monitor_rules(enabled);
    -- idx_monitor_rules_kind is created AFTER the defensive ALTER below.

    -- Radar: a per-contact memory bank built from extracted message signals.
    CREATE TABLE IF NOT EXISTS radar_contacts (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      handle              TEXT NOT NULL UNIQUE,
      label               TEXT,
      enabled             INTEGER NOT NULL DEFAULT 1,
      profile             TEXT NOT NULL DEFAULT '',
      profile_updated_at  INTEGER NOT NULL DEFAULT 0,
      created_at          INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_radar_contacts_enabled ON radar_contacts(enabled);

    -- Radar signals: discrete facts extracted from each incoming message.
    -- Idempotent on (handle, message_guid) so re-evaluating the same message
    -- doesn't double-extract.
    CREATE TABLE IF NOT EXISTS radar_signals (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      handle        TEXT NOT NULL,
      message_guid  TEXT NOT NULL,
      message_rowid INTEGER NOT NULL,
      chat_id       INTEGER NOT NULL,
      category      TEXT NOT NULL,
      content       TEXT NOT NULL,
      confidence    REAL,
      source_text   TEXT,
      extracted_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_radar_signals_handle ON radar_signals(handle);
    CREATE INDEX IF NOT EXISTS idx_radar_signals_handle_cat ON radar_signals(handle, category);
    CREATE INDEX IF NOT EXISTS idx_radar_signals_extracted_at ON radar_signals(extracted_at);

    -- Calendar proposals: extracted events awaiting user export/dismissal.
    CREATE TABLE IF NOT EXISTS calendar_proposals (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source_msg_guid TEXT NOT NULL UNIQUE,
      message_rowid   INTEGER NOT NULL,
      chat_id         INTEGER NOT NULL,
      handle          TEXT NOT NULL,
      title           TEXT NOT NULL,
      start_ms        INTEGER,
      end_ms          INTEGER,
      location        TEXT,
      participants    TEXT,
      notes           TEXT,
      confidence      REAL,
      reasoning       TEXT,
      status          TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'exported', 'dismissed')),
      source_rule_id  INTEGER,
      created_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      decided_at      INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_cal_proposals_status ON calendar_proposals(status);
    CREATE INDEX IF NOT EXISTS idx_cal_proposals_created ON calendar_proposals(created_at);

    CREATE TABLE IF NOT EXISTS flagged_messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id       INTEGER NOT NULL,
      message_guid  TEXT NOT NULL,
      message_rowid INTEGER NOT NULL,
      chat_id       INTEGER NOT NULL,
      handle        TEXT NOT NULL,
      text          TEXT,
      reasoning     TEXT,
      confidence    REAL,
      flagged_at    INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      reviewed_at   INTEGER,
      FOREIGN KEY (rule_id) REFERENCES monitor_rules(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_flagged_unique ON flagged_messages(rule_id, message_guid);
    CREATE INDEX IF NOT EXISTS idx_flagged_at ON flagged_messages(flagged_at);
    CREATE INDEX IF NOT EXISTS idx_flagged_unreviewed ON flagged_messages(reviewed_at);

    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      handle          TEXT NOT NULL,
      body            TEXT NOT NULL,
      send_at         INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
      service         TEXT NOT NULL DEFAULT 'iMessage',
      source_draft_id INTEGER,
      created_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      sent_at         INTEGER,
      error           TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_send_at ON scheduled_messages(send_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled_messages(status);

    -- Away mode: opt-in contacts the auto-responder is allowed to handle.
    CREATE TABLE IF NOT EXISTS away_contacts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      handle      TEXT NOT NULL UNIQUE,
      label       TEXT,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    );

    -- Away sessions: one per (contact, away-period). Status flow:
    --   greeting_sent → continuing → ended.
    CREATE TABLE IF NOT EXISTS away_sessions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      handle            TEXT NOT NULL,
      started_at        INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      last_ai_reply_at  INTEGER,
      ai_reply_count    INTEGER NOT NULL DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'greeting_sent'
                         CHECK (status IN ('greeting_sent', 'continuing', 'ended')),
      ended_at          INTEGER,
      ended_reason      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_away_sessions_handle_status ON away_sessions(handle, status);
    CREATE INDEX IF NOT EXISTS idx_away_sessions_started ON away_sessions(started_at);

    -- Away notes: substantive things from inbound messages during away mode
    -- that the user should personally follow up on when they're back.
    CREATE TABLE IF NOT EXISTS away_notes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      INTEGER,
      handle          TEXT NOT NULL,
      message_guid    TEXT NOT NULL,
      message_rowid   INTEGER,
      message_text    TEXT,
      summary         TEXT NOT NULL,
      category        TEXT NOT NULL
                       CHECK (category IN ('meet', 'discuss', 'request', 'urgent', 'other')),
      reasoning       TEXT,
      created_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      reviewed_at     INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_away_notes_unique ON away_notes(message_guid);
    CREATE INDEX IF NOT EXISTS idx_away_notes_handle ON away_notes(handle);
    CREATE INDEX IF NOT EXISTS idx_away_notes_unreviewed ON away_notes(reviewed_at);

    CREATE TABLE IF NOT EXISTS state (
      key          TEXT PRIMARY KEY,
      value        TEXT NOT NULL
    );
  `);

  // Defensive ALTERs for upgrades from prior schema.
  const draftCols = db.prepare('PRAGMA table_info(drafts)').all() as Array<{ name: string }>;
  if (!draftCols.some((c) => c.name === 'staged_at')) {
    db.exec('ALTER TABLE drafts ADD COLUMN staged_at INTEGER');
  }
  const monitorCols = db.prepare('PRAGMA table_info(monitor_rules)').all() as Array<{ name: string }>;
  if (!monitorCols.some((c) => c.name === 'kind')) {
    db.exec("ALTER TABLE monitor_rules ADD COLUMN kind TEXT NOT NULL DEFAULT 'flag'");
  }
  // Index on kind has to come AFTER the ALTER above.
  db.exec('CREATE INDEX IF NOT EXISTS idx_monitor_rules_kind ON monitor_rules(kind)');
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

/* ---------- settings (typed wrapper around state) ---------- */

export interface AppSettings {
  /** Number of recent messages to attach to AI prompts as context. */
  ai_context_count: number;
  /** Distilled prose describing how the user writes — fed into draft prompts. */
  voice_profile: string;
  /** How many recent sent messages to sample on regeneration. */
  voice_profile_sample_count: number;
  /** Optional user-supplied guidance, used at regeneration time. */
  voice_profile_user_context: string;
  /** Last regeneration timestamp (unix ms), 0 if never. */
  voice_profile_updated_at: number;
  /** Away mode: when on, opted-in contacts get auto-replies. 0/1 (treated as bool). */
  away_mode_enabled: number;
  /** The greeting sent on the FIRST incoming message in away mode. */
  away_message: string;
  /** Per-session AI reply cap (safety against runaway). */
  away_max_replies_per_session: number;
  /** Free-text personality / behavior guidance for the AI WHILE in away mode.
   *  Distinct from voice_profile (which captures how the user writes).
   *  This shapes how the AI BEHAVES while covering — banter level, deflection
   *  style, jokes, how to handle "are you really an AI?" etc. */
  away_persona: string;
  /** OpenAI API key. When set, takes precedence over the OPENAI_API_KEY env
   *  var. Stored locally in app.db so users can configure AI from the
   *  Settings UI instead of editing .env. NEVER returned by /api/settings —
   *  the route masks it. */
  openai_api_key: string;
  /** Model name. Defaults to env or 'gpt-4o-mini'. */
  openai_model: string;
}

const SETTING_DEFAULTS: AppSettings = {
  ai_context_count: 20,
  voice_profile: '',
  voice_profile_sample_count: 200,
  voice_profile_user_context: '',
  voice_profile_updated_at: 0,
  away_mode_enabled: 0,
  away_message:
    "I'm currently away. — this is Chazz's AI, designed to mimic him while he's not here. Feel free to keep chatting and I'll do my best to keep things going in his voice. He'll catch up when he's back.",
  away_max_replies_per_session: 50,
  away_persona: '',
  openai_api_key: '',
  openai_model: '',
};

export const SETTING_BOUNDS = {
  ai_context_count: { min: 1, max: 100 },
  voice_profile_sample_count: { min: 50, max: 2000 },
  away_max_replies_per_session: { min: 1, max: 200 },
} as const;

function parseIntOr(v: string | null, fallback: number): number {
  if (v === null) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function getSettings(): AppSettings {
  return {
    ai_context_count: parseIntOr(
      getState('ai_context_count'),
      SETTING_DEFAULTS.ai_context_count,
    ),
    voice_profile: getState('voice_profile') ?? SETTING_DEFAULTS.voice_profile,
    voice_profile_sample_count: parseIntOr(
      getState('voice_profile_sample_count'),
      SETTING_DEFAULTS.voice_profile_sample_count,
    ),
    voice_profile_user_context:
      getState('voice_profile_user_context') ?? SETTING_DEFAULTS.voice_profile_user_context,
    voice_profile_updated_at: parseIntOr(
      getState('voice_profile_updated_at'),
      SETTING_DEFAULTS.voice_profile_updated_at,
    ),
    away_mode_enabled: parseIntOr(
      getState('away_mode_enabled'),
      SETTING_DEFAULTS.away_mode_enabled,
    ),
    away_message: getState('away_message') ?? SETTING_DEFAULTS.away_message,
    away_max_replies_per_session: parseIntOr(
      getState('away_max_replies_per_session'),
      SETTING_DEFAULTS.away_max_replies_per_session,
    ),
    away_persona: getState('away_persona') ?? SETTING_DEFAULTS.away_persona,
    openai_api_key: getState('openai_api_key') ?? SETTING_DEFAULTS.openai_api_key,
    openai_model: getState('openai_model') ?? SETTING_DEFAULTS.openai_model,
  };
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  if (patch.ai_context_count !== undefined) {
    const { min, max } = SETTING_BOUNDS.ai_context_count;
    const n = Math.max(min, Math.min(max, Math.floor(Number(patch.ai_context_count))));
    if (!Number.isFinite(n)) throw new Error('ai_context_count must be an integer');
    setState('ai_context_count', String(n));
  }
  if (patch.voice_profile !== undefined) {
    setState('voice_profile', String(patch.voice_profile));
  }
  if (patch.voice_profile_sample_count !== undefined) {
    const { min, max } = SETTING_BOUNDS.voice_profile_sample_count;
    const n = Math.max(min, Math.min(max, Math.floor(Number(patch.voice_profile_sample_count))));
    if (!Number.isFinite(n)) throw new Error('voice_profile_sample_count must be an integer');
    setState('voice_profile_sample_count', String(n));
  }
  if (patch.voice_profile_user_context !== undefined) {
    setState('voice_profile_user_context', String(patch.voice_profile_user_context));
  }
  if (patch.voice_profile_updated_at !== undefined) {
    setState('voice_profile_updated_at', String(Math.floor(Number(patch.voice_profile_updated_at))));
  }
  if (patch.away_mode_enabled !== undefined) {
    setState('away_mode_enabled', String(patch.away_mode_enabled ? 1 : 0));
  }
  if (patch.away_message !== undefined) {
    setState('away_message', String(patch.away_message));
  }
  if (patch.away_max_replies_per_session !== undefined) {
    const { min, max } = SETTING_BOUNDS.away_max_replies_per_session;
    const n = Math.max(min, Math.min(max, Math.floor(Number(patch.away_max_replies_per_session))));
    if (!Number.isFinite(n)) throw new Error('away_max_replies_per_session must be an integer');
    setState('away_max_replies_per_session', String(n));
  }
  if (patch.away_persona !== undefined) {
    setState('away_persona', String(patch.away_persona));
  }
  if (patch.openai_api_key !== undefined) {
    // Trim whitespace; an empty string clears the key (falls back to env var).
    const k = String(patch.openai_api_key).trim();
    setState('openai_api_key', k);
  }
  if (patch.openai_model !== undefined) {
    setState('openai_model', String(patch.openai_model).trim());
  }
  return getSettings();
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
  status: 'pending' | 'sent' | 'discarded' | 'edited' | 'staged';
  reasoning: string | null;
  created_at: number;
  decided_at: number | null;
  staged_at: number | null;
}

export function listDrafts(status?: Draft['status']): Draft[] {
  const db = getAppDb();
  if (status) {
    return db
      .prepare(
        'SELECT id, source_msg_guid, chat_id, handle, body, status, reasoning, created_at, decided_at, staged_at FROM drafts WHERE status = ? ORDER BY id DESC',
      )
      .all(status) as Draft[];
  }
  return db
    .prepare(
      'SELECT id, source_msg_guid, chat_id, handle, body, status, reasoning, created_at, decided_at, staged_at FROM drafts ORDER BY id DESC',
    )
    .all() as Draft[];
}

export function getDraft(id: number): Draft | null {
  const db = getAppDb();
  const row = db
    .prepare(
      'SELECT id, source_msg_guid, chat_id, handle, body, status, reasoning, created_at, decided_at, staged_at FROM drafts WHERE id = ?',
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

/** Mark a draft as staged into Messages.app. Status stays 'pending' so it's
 *  still actionable; staged_at carries the "we did it" timestamp. */
export function stampDraftStaged(id: number): Draft | null {
  const db = getAppDb();
  db.prepare(
    "UPDATE drafts SET staged_at = strftime('%s','now')*1000 WHERE id = ?",
  ).run(id);
  return getDraft(id);
}

/* ---------- contact notes (per-handle, additive list) ---------- */

export interface ContactNote {
  id: number;
  handle: string;
  body: string;
  created_at: number;
}

export function listNotesForHandle(handle: string): ContactNote[] {
  const db = getAppDb();
  return db
    .prepare(
      'SELECT id, handle, body, created_at FROM contact_notes WHERE handle = ? ORDER BY created_at ASC',
    )
    .all(handle) as ContactNote[];
}

export function addNoteForHandle(handle: string, body: string): ContactNote {
  const db = getAppDb();
  const info = db
    .prepare('INSERT INTO contact_notes(handle, body) VALUES (?, ?)')
    .run(handle, body);
  return db
    .prepare('SELECT id, handle, body, created_at FROM contact_notes WHERE id = ?')
    .get(info.lastInsertRowid) as ContactNote;
}

export function removeNote(id: number): boolean {
  const db = getAppDb();
  return db.prepare('DELETE FROM contact_notes WHERE id = ?').run(id).changes > 0;
}

/* ---------- monitor rules (AI-evaluated incoming-message filters) ---------- */

export type MonitorScopeType = 'contact' | 'unknown' | 'all';
export type MonitorKind = 'flag' | 'calendar';

export interface MonitorRule {
  id: number;
  name: string;
  kind: MonitorKind;
  scope_type: MonitorScopeType;
  scope_handle: string | null;
  prompt: string;
  enabled: 0 | 1;
  created_at: number;
}

const MONITOR_RULE_COLS =
  'id, name, kind, scope_type, scope_handle, prompt, enabled, created_at';

export function listMonitorRules(): MonitorRule[] {
  const db = getAppDb();
  return db
    .prepare(`SELECT ${MONITOR_RULE_COLS} FROM monitor_rules ORDER BY id DESC`)
    .all() as MonitorRule[];
}

export function listEnabledMonitorRules(kind?: MonitorKind): MonitorRule[] {
  const db = getAppDb();
  if (kind) {
    return db
      .prepare(
        `SELECT ${MONITOR_RULE_COLS} FROM monitor_rules WHERE enabled = 1 AND kind = ? ORDER BY id ASC`,
      )
      .all(kind) as MonitorRule[];
  }
  return db
    .prepare(`SELECT ${MONITOR_RULE_COLS} FROM monitor_rules WHERE enabled = 1 ORDER BY id ASC`)
    .all() as MonitorRule[];
}

export function addMonitorRule(input: {
  name: string;
  kind?: MonitorKind;
  scope_type: MonitorScopeType;
  scope_handle: string | null;
  prompt?: string;
}): MonitorRule {
  if (input.scope_type === 'contact' && !input.scope_handle) {
    throw new Error('scope_handle required when scope_type = contact');
  }
  const kind: MonitorKind = input.kind ?? 'flag';
  if (kind === 'flag' && !(input.prompt ?? '').trim()) {
    throw new Error('prompt required when kind = flag');
  }
  const db = getAppDb();
  const info = db
    .prepare(
      'INSERT INTO monitor_rules(name, kind, scope_type, scope_handle, prompt) VALUES (?, ?, ?, ?, ?)',
    )
    .run(
      input.name,
      kind,
      input.scope_type,
      input.scope_handle ?? null,
      (input.prompt ?? '').trim(),
    );
  return db
    .prepare(`SELECT ${MONITOR_RULE_COLS} FROM monitor_rules WHERE id = ?`)
    .get(info.lastInsertRowid) as MonitorRule;
}

export function setMonitorRuleEnabled(id: number, enabled: boolean): boolean {
  const db = getAppDb();
  return (
    db
      .prepare('UPDATE monitor_rules SET enabled = ? WHERE id = ?')
      .run(enabled ? 1 : 0, id).changes > 0
  );
}

export function removeMonitorRule(id: number): boolean {
  const db = getAppDb();
  return db.prepare('DELETE FROM monitor_rules WHERE id = ?').run(id).changes > 0;
}

/* ---------- flagged messages (matches produced by monitor rules) ---------- */

export interface FlaggedMessageRow {
  id: number;
  rule_id: number;
  rule_name: string;
  message_guid: string;
  message_rowid: number;
  chat_id: number;
  handle: string;
  text: string | null;
  reasoning: string | null;
  confidence: number | null;
  flagged_at: number;
  reviewed_at: number | null;
}

export function listFlags(opts: { reviewed?: boolean; limit?: number; rule_id?: number } = {}): FlaggedMessageRow[] {
  const db = getAppDb();
  const conds: string[] = [];
  const params: Array<string | number> = [];
  if (opts.reviewed !== undefined) {
    conds.push(opts.reviewed ? 'f.reviewed_at IS NOT NULL' : 'f.reviewed_at IS NULL');
  }
  if (opts.rule_id !== undefined) {
    conds.push('f.rule_id = ?');
    params.push(opts.rule_id);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  params.push(limit);
  return db
    .prepare(
      `SELECT f.id, f.rule_id, r.name AS rule_name, f.message_guid, f.message_rowid,
              f.chat_id, f.handle, f.text, f.reasoning, f.confidence,
              f.flagged_at, f.reviewed_at
       FROM flagged_messages f
       LEFT JOIN monitor_rules r ON r.id = f.rule_id
       ${where}
       ORDER BY f.flagged_at DESC
       LIMIT ?`,
    )
    .all(...params) as FlaggedMessageRow[];
}

export function insertFlag(input: {
  rule_id: number;
  message_guid: string;
  message_rowid: number;
  chat_id: number;
  handle: string;
  text: string | null;
  reasoning: string | null;
  confidence: number | null;
}): FlaggedMessageRow | null {
  const db = getAppDb();
  // Idempotent on (rule_id, message_guid) — re-evaluating the same message doesn't double-flag.
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO flagged_messages
        (rule_id, message_guid, message_rowid, chat_id, handle, text, reasoning, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.rule_id,
      input.message_guid,
      input.message_rowid,
      input.chat_id,
      input.handle,
      input.text,
      input.reasoning,
      input.confidence,
    );
  if (info.changes === 0) return null;
  return db
    .prepare(
      `SELECT f.id, f.rule_id, r.name AS rule_name, f.message_guid, f.message_rowid,
              f.chat_id, f.handle, f.text, f.reasoning, f.confidence,
              f.flagged_at, f.reviewed_at
       FROM flagged_messages f
       LEFT JOIN monitor_rules r ON r.id = f.rule_id
       WHERE f.id = ?`,
    )
    .get(info.lastInsertRowid) as FlaggedMessageRow;
}

export function markFlagReviewed(id: number): FlaggedMessageRow | null {
  const db = getAppDb();
  db.prepare("UPDATE flagged_messages SET reviewed_at = strftime('%s','now')*1000 WHERE id = ?").run(id);
  return db
    .prepare(
      `SELECT f.id, f.rule_id, r.name AS rule_name, f.message_guid, f.message_rowid,
              f.chat_id, f.handle, f.text, f.reasoning, f.confidence,
              f.flagged_at, f.reviewed_at
       FROM flagged_messages f
       LEFT JOIN monitor_rules r ON r.id = f.rule_id
       WHERE f.id = ?`,
    )
    .get(id) as FlaggedMessageRow | null;
}

export function removeFlag(id: number): boolean {
  const db = getAppDb();
  return db.prepare('DELETE FROM flagged_messages WHERE id = ?').run(id).changes > 0;
}

export function countUnreviewedFlags(): number {
  const db = getAppDb();
  const row = db.prepare('SELECT COUNT(*) AS n FROM flagged_messages WHERE reviewed_at IS NULL').get() as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

/* ---------- scheduled messages (queued for later send) ---------- */

export type ScheduledStatus = 'pending' | 'sent' | 'failed' | 'cancelled';

export interface ScheduledMessage {
  id: number;
  handle: string;
  body: string;
  send_at: number;
  status: ScheduledStatus;
  service: string;
  source_draft_id: number | null;
  created_at: number;
  sent_at: number | null;
  error: string | null;
}

export function listScheduled(status?: ScheduledStatus): ScheduledMessage[] {
  const db = getAppDb();
  if (status) {
    return db
      .prepare(
        'SELECT id, handle, body, send_at, status, service, source_draft_id, created_at, sent_at, error FROM scheduled_messages WHERE status = ? ORDER BY send_at ASC',
      )
      .all(status) as ScheduledMessage[];
  }
  return db
    .prepare(
      'SELECT id, handle, body, send_at, status, service, source_draft_id, created_at, sent_at, error FROM scheduled_messages ORDER BY send_at ASC',
    )
    .all() as ScheduledMessage[];
}

export function getScheduled(id: number): ScheduledMessage | null {
  const db = getAppDb();
  const row = db
    .prepare(
      'SELECT id, handle, body, send_at, status, service, source_draft_id, created_at, sent_at, error FROM scheduled_messages WHERE id = ?',
    )
    .get(id) as ScheduledMessage | undefined;
  return row ?? null;
}

export function listDueScheduled(now: number = Date.now()): ScheduledMessage[] {
  const db = getAppDb();
  return db
    .prepare(
      "SELECT id, handle, body, send_at, status, service, source_draft_id, created_at, sent_at, error FROM scheduled_messages WHERE status = 'pending' AND send_at <= ? ORDER BY send_at ASC",
    )
    .all(now) as ScheduledMessage[];
}

export function createScheduled(input: {
  handle: string;
  body: string;
  send_at: number;
  service?: string;
  source_draft_id?: number | null;
}): ScheduledMessage {
  const db = getAppDb();
  const info = db
    .prepare(
      'INSERT INTO scheduled_messages(handle, body, send_at, service, source_draft_id) VALUES (?, ?, ?, ?, ?)',
    )
    .run(input.handle, input.body, input.send_at, input.service ?? 'iMessage', input.source_draft_id ?? null);
  return getScheduled(info.lastInsertRowid as number)!;
}

export function updateScheduledStatus(
  id: number,
  status: ScheduledStatus,
  error?: string | null,
): ScheduledMessage | null {
  const db = getAppDb();
  if (status === 'sent') {
    db.prepare(
      "UPDATE scheduled_messages SET status = 'sent', sent_at = strftime('%s','now')*1000, error = NULL WHERE id = ?",
    ).run(id);
  } else if (status === 'failed') {
    db.prepare(
      "UPDATE scheduled_messages SET status = 'failed', error = ? WHERE id = ?",
    ).run(error ?? null, id);
  } else if (status === 'cancelled') {
    db.prepare("UPDATE scheduled_messages SET status = 'cancelled' WHERE id = ?").run(id);
  } else {
    db.prepare("UPDATE scheduled_messages SET status = ? WHERE id = ?").run(status, id);
  }
  return getScheduled(id);
}

export function updateScheduled(id: number, patch: { send_at?: number; body?: string }): ScheduledMessage | null {
  const db = getAppDb();
  if (patch.send_at !== undefined) {
    db.prepare('UPDATE scheduled_messages SET send_at = ? WHERE id = ?').run(patch.send_at, id);
  }
  if (patch.body !== undefined) {
    db.prepare('UPDATE scheduled_messages SET body = ? WHERE id = ?').run(patch.body, id);
  }
  return getScheduled(id);
}

/* ---------- radar: per-contact memory bank ---------- */

export type RadarCategory =
  | 'likes'
  | 'dislikes'
  | 'wants'
  | 'obsessed'
  | 'schedule'
  | 'vacation'
  | 'gifts'
  | 'family'
  | 'health'
  | 'work'
  | 'other';

export const RADAR_CATEGORIES: readonly RadarCategory[] = [
  'likes',
  'dislikes',
  'wants',
  'obsessed',
  'schedule',
  'vacation',
  'gifts',
  'family',
  'health',
  'work',
  'other',
] as const;

export interface RadarContact {
  id: number;
  handle: string;
  label: string | null;
  enabled: 0 | 1;
  profile: string;
  profile_updated_at: number;
  created_at: number;
}

export function listRadarContacts(): RadarContact[] {
  const db = getAppDb();
  return db
    .prepare(
      'SELECT id, handle, label, enabled, profile, profile_updated_at, created_at FROM radar_contacts ORDER BY id DESC',
    )
    .all() as RadarContact[];
}

export function listEnabledRadarHandles(): Set<string> {
  const db = getAppDb();
  const rows = db
    .prepare('SELECT handle FROM radar_contacts WHERE enabled = 1')
    .all() as Array<{ handle: string }>;
  return new Set(rows.map((r) => normalizeHandle(r.handle)));
}

export function getRadarContact(handle: string): RadarContact | null {
  const db = getAppDb();
  const row = db
    .prepare(
      'SELECT id, handle, label, enabled, profile, profile_updated_at, created_at FROM radar_contacts WHERE handle = ?',
    )
    .get(handle) as RadarContact | undefined;
  return row ?? null;
}

export function addRadarContact(handle: string, label: string | null): RadarContact {
  const db = getAppDb();
  db
    .prepare('INSERT OR IGNORE INTO radar_contacts(handle, label) VALUES (?, ?)')
    .run(handle, label);
  // Update label if changed
  if (label !== null) {
    db.prepare('UPDATE radar_contacts SET label = ? WHERE handle = ? AND (label IS NULL OR label = \'\')').run(label, handle);
  }
  return getRadarContact(handle)!;
}

export function setRadarEnabled(id: number, enabled: boolean): boolean {
  const db = getAppDb();
  return (
    db.prepare('UPDATE radar_contacts SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
      .changes > 0
  );
}

export function removeRadarContact(id: number): boolean {
  const db = getAppDb();
  return db.prepare('DELETE FROM radar_contacts WHERE id = ?').run(id).changes > 0;
}

export function setRadarProfile(handle: string, profile: string): RadarContact | null {
  const db = getAppDb();
  db
    .prepare(
      "UPDATE radar_contacts SET profile = ?, profile_updated_at = strftime('%s','now')*1000 WHERE handle = ?",
    )
    .run(profile, handle);
  return getRadarContact(handle);
}

/* ---------- radar signals (extracted facts) ---------- */

export interface RadarSignal {
  id: number;
  handle: string;
  message_guid: string;
  message_rowid: number;
  chat_id: number;
  category: RadarCategory;
  content: string;
  confidence: number | null;
  source_text: string | null;
  extracted_at: number;
}

export function listRadarSignals(handle: string, limit = 200, category?: RadarCategory): RadarSignal[] {
  const db = getAppDb();
  if (category) {
    return db
      .prepare(
        `SELECT id, handle, message_guid, message_rowid, chat_id, category, content, confidence, source_text, extracted_at
         FROM radar_signals
         WHERE handle = ? AND category = ?
         ORDER BY extracted_at DESC
         LIMIT ?`,
      )
      .all(handle, category, limit) as RadarSignal[];
  }
  return db
    .prepare(
      `SELECT id, handle, message_guid, message_rowid, chat_id, category, content, confidence, source_text, extracted_at
       FROM radar_signals
       WHERE handle = ?
       ORDER BY extracted_at DESC
       LIMIT ?`,
    )
    .all(handle, limit) as RadarSignal[];
}

export function insertRadarSignals(
  signals: Array<{
    handle: string;
    message_guid: string;
    message_rowid: number;
    chat_id: number;
    category: RadarCategory;
    content: string;
    confidence: number | null;
    source_text: string | null;
  }>,
): number {
  if (signals.length === 0) return 0;
  const db = getAppDb();
  const stmt = db.prepare(
    `INSERT INTO radar_signals(handle, message_guid, message_rowid, chat_id, category, content, confidence, source_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let inserted = 0;
  const tx = db.transaction(() => {
    for (const s of signals) {
      stmt.run(
        s.handle,
        s.message_guid,
        s.message_rowid,
        s.chat_id,
        s.category,
        s.content,
        s.confidence,
        s.source_text,
      );
      inserted++;
    }
  });
  tx();
  return inserted;
}

export function radarSignalAlreadyProcessed(handle: string, messageGuid: string): boolean {
  const db = getAppDb();
  const row = db
    .prepare('SELECT 1 FROM radar_signals WHERE handle = ? AND message_guid = ? LIMIT 1')
    .get(handle, messageGuid);
  return !!row;
}

export function removeRadarSignal(id: number): boolean {
  const db = getAppDb();
  return db.prepare('DELETE FROM radar_signals WHERE id = ?').run(id).changes > 0;
}

export function countRadarSignalsByCategory(handle: string): Record<string, number> {
  const db = getAppDb();
  const rows = db
    .prepare('SELECT category, COUNT(*) as n FROM radar_signals WHERE handle = ? GROUP BY category')
    .all(handle) as Array<{ category: string; n: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.category] = r.n;
  return out;
}

/* ---------- calendar proposals (extracted events) ---------- */

export type CalendarProposalStatus = 'pending' | 'exported' | 'dismissed';

export interface CalendarProposal {
  id: number;
  source_msg_guid: string;
  message_rowid: number;
  chat_id: number;
  handle: string;
  title: string;
  start_ms: number | null;
  end_ms: number | null;
  location: string | null;
  participants: string | null;
  notes: string | null;
  confidence: number | null;
  reasoning: string | null;
  status: CalendarProposalStatus;
  source_rule_id: number | null;
  created_at: number;
  decided_at: number | null;
}

const CAL_COLS =
  'id, source_msg_guid, message_rowid, chat_id, handle, title, start_ms, end_ms, location, participants, notes, confidence, reasoning, status, source_rule_id, created_at, decided_at';

export function listCalendarProposals(opts: { status?: CalendarProposalStatus; limit?: number } = {}): CalendarProposal[] {
  const db = getAppDb();
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
  if (opts.status) {
    return db
      .prepare(
        `SELECT ${CAL_COLS} FROM calendar_proposals WHERE status = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(opts.status, limit) as CalendarProposal[];
  }
  return db
    .prepare(`SELECT ${CAL_COLS} FROM calendar_proposals ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as CalendarProposal[];
}

export function getCalendarProposal(id: number): CalendarProposal | null {
  const db = getAppDb();
  const row = db
    .prepare(`SELECT ${CAL_COLS} FROM calendar_proposals WHERE id = ?`)
    .get(id) as CalendarProposal | undefined;
  return row ?? null;
}

export function calendarProposalAlreadyExists(sourceMsgGuid: string): boolean {
  const db = getAppDb();
  return !!db
    .prepare('SELECT 1 FROM calendar_proposals WHERE source_msg_guid = ? LIMIT 1')
    .get(sourceMsgGuid);
}

export function insertCalendarProposal(input: {
  source_msg_guid: string;
  message_rowid: number;
  chat_id: number;
  handle: string;
  title: string;
  start_ms: number | null;
  end_ms: number | null;
  location: string | null;
  participants: string | null;
  notes: string | null;
  confidence: number | null;
  reasoning: string | null;
  source_rule_id: number | null;
}): CalendarProposal | null {
  const db = getAppDb();
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO calendar_proposals
        (source_msg_guid, message_rowid, chat_id, handle, title, start_ms, end_ms, location, participants, notes, confidence, reasoning, source_rule_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.source_msg_guid,
      input.message_rowid,
      input.chat_id,
      input.handle,
      input.title,
      input.start_ms,
      input.end_ms,
      input.location,
      input.participants,
      input.notes,
      input.confidence,
      input.reasoning,
      input.source_rule_id,
    );
  if (info.changes === 0) return null;
  return getCalendarProposal(info.lastInsertRowid as number);
}

export function updateCalendarProposalStatus(
  id: number,
  status: CalendarProposalStatus,
): CalendarProposal | null {
  const db = getAppDb();
  db.prepare(
    "UPDATE calendar_proposals SET status = ?, decided_at = strftime('%s','now')*1000 WHERE id = ?",
  ).run(status, id);
  return getCalendarProposal(id);
}

export function removeCalendarProposal(id: number): boolean {
  const db = getAppDb();
  return db.prepare('DELETE FROM calendar_proposals WHERE id = ?').run(id).changes > 0;
}

export function countPendingCalendarProposals(): number {
  const db = getAppDb();
  const row = db.prepare("SELECT COUNT(*) as n FROM calendar_proposals WHERE status = 'pending'").get() as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

/* ---------- away mode: opt-in contacts + sessions ---------- */

export interface AwayContact {
  id: number;
  handle: string;
  label: string | null;
  enabled: 0 | 1;
  created_at: number;
}

export type AwaySessionStatus = 'greeting_sent' | 'continuing' | 'ended';

export interface AwaySession {
  id: number;
  handle: string;
  started_at: number;
  last_ai_reply_at: number | null;
  ai_reply_count: number;
  status: AwaySessionStatus;
  ended_at: number | null;
  ended_reason: string | null;
}

export function listAwayContacts(): AwayContact[] {
  const db = getAppDb();
  return db
    .prepare(
      'SELECT id, handle, label, enabled, created_at FROM away_contacts ORDER BY id DESC',
    )
    .all() as AwayContact[];
}

export function listEnabledAwayHandles(): Set<string> {
  const db = getAppDb();
  const rows = db
    .prepare('SELECT handle FROM away_contacts WHERE enabled = 1')
    .all() as Array<{ handle: string }>;
  // Normalize on the way out so any rows that were stored before we tightened
  // ingest still match against chat.db's canonical handles.
  return new Set(rows.map((r) => normalizeHandle(r.handle)));
}

export function addAwayContact(handle: string, label: string | null): AwayContact {
  const db = getAppDb();
  db
    .prepare('INSERT OR IGNORE INTO away_contacts(handle, label) VALUES (?, ?)')
    .run(handle, label);
  if (label !== null) {
    db.prepare(
      "UPDATE away_contacts SET label = ? WHERE handle = ? AND (label IS NULL OR label = '')",
    ).run(label, handle);
  }
  return db
    .prepare('SELECT id, handle, label, enabled, created_at FROM away_contacts WHERE handle = ?')
    .get(handle) as AwayContact;
}

export function setAwayContactEnabled(id: number, enabled: boolean): boolean {
  const db = getAppDb();
  return (
    db
      .prepare('UPDATE away_contacts SET enabled = ? WHERE id = ?')
      .run(enabled ? 1 : 0, id).changes > 0
  );
}

export function removeAwayContact(id: number): boolean {
  const db = getAppDb();
  return db.prepare('DELETE FROM away_contacts WHERE id = ?').run(id).changes > 0;
}

const AWAY_SESSION_COLS =
  'id, handle, started_at, last_ai_reply_at, ai_reply_count, status, ended_at, ended_reason';

export function getActiveAwaySession(handle: string): AwaySession | null {
  const db = getAppDb();
  const row = db
    .prepare(
      `SELECT ${AWAY_SESSION_COLS}
       FROM away_sessions
       WHERE handle = ? AND status != 'ended'
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(handle) as AwaySession | undefined;
  return row ?? null;
}

export function createAwaySession(handle: string): AwaySession {
  const db = getAppDb();
  const info = db
    .prepare("INSERT INTO away_sessions(handle, status) VALUES (?, 'greeting_sent')")
    .run(handle);
  return db
    .prepare(`SELECT ${AWAY_SESSION_COLS} FROM away_sessions WHERE id = ?`)
    .get(info.lastInsertRowid) as AwaySession;
}

export function bumpAwaySession(id: number): AwaySession | null {
  const db = getAppDb();
  db.prepare(
    "UPDATE away_sessions SET ai_reply_count = ai_reply_count + 1, last_ai_reply_at = strftime('%s','now')*1000, status = 'continuing' WHERE id = ?",
  ).run(id);
  return db
    .prepare(`SELECT ${AWAY_SESSION_COLS} FROM away_sessions WHERE id = ?`)
    .get(id) as AwaySession | null;
}

export function endAwaySession(id: number, reason: string): AwaySession | null {
  const db = getAppDb();
  db.prepare(
    "UPDATE away_sessions SET status = 'ended', ended_at = strftime('%s','now')*1000, ended_reason = ? WHERE id = ?",
  ).run(reason, id);
  return db
    .prepare(`SELECT ${AWAY_SESSION_COLS} FROM away_sessions WHERE id = ?`)
    .get(id) as AwaySession | null;
}

export function endAllActiveAwaySessions(reason: string): number {
  const db = getAppDb();
  return db
    .prepare(
      "UPDATE away_sessions SET status = 'ended', ended_at = strftime('%s','now')*1000, ended_reason = ? WHERE status != 'ended'",
    )
    .run(reason).changes;
}

export function listAwaySessions(opts: { activeOnly?: boolean; limit?: number } = {}): AwaySession[] {
  const db = getAppDb();
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  if (opts.activeOnly) {
    return db
      .prepare(
        `SELECT ${AWAY_SESSION_COLS}
         FROM away_sessions
         WHERE status != 'ended'
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(limit) as AwaySession[];
  }
  return db
    .prepare(`SELECT ${AWAY_SESSION_COLS} FROM away_sessions ORDER BY started_at DESC LIMIT ?`)
    .all(limit) as AwaySession[];
}

export function countActiveAwaySessions(): number {
  const db = getAppDb();
  const row = db
    .prepare("SELECT COUNT(*) as n FROM away_sessions WHERE status != 'ended'")
    .get() as { n: number } | undefined;
  return row?.n ?? 0;
}

/* ---------- away notes (things to follow up on after coming back) ---------- */

export type AwayNoteCategory = 'meet' | 'discuss' | 'request' | 'urgent' | 'other';

export interface AwayNote {
  id: number;
  session_id: number | null;
  handle: string;
  message_guid: string;
  message_rowid: number | null;
  message_text: string | null;
  summary: string;
  category: AwayNoteCategory;
  reasoning: string | null;
  created_at: number;
  reviewed_at: number | null;
}

const AWAY_NOTE_COLS =
  'id, session_id, handle, message_guid, message_rowid, message_text, summary, category, reasoning, created_at, reviewed_at';

export function awayNoteAlreadyExists(messageGuid: string): boolean {
  const db = getAppDb();
  return !!db
    .prepare('SELECT 1 FROM away_notes WHERE message_guid = ? LIMIT 1')
    .get(messageGuid);
}

export function insertAwayNote(input: {
  session_id: number | null;
  handle: string;
  message_guid: string;
  message_rowid: number | null;
  message_text: string | null;
  summary: string;
  category: AwayNoteCategory;
  reasoning: string | null;
}): AwayNote | null {
  const db = getAppDb();
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO away_notes
        (session_id, handle, message_guid, message_rowid, message_text, summary, category, reasoning)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.session_id,
      input.handle,
      input.message_guid,
      input.message_rowid,
      input.message_text,
      input.summary,
      input.category,
      input.reasoning,
    );
  if (info.changes === 0) return null;
  return db
    .prepare(`SELECT ${AWAY_NOTE_COLS} FROM away_notes WHERE id = ?`)
    .get(info.lastInsertRowid) as AwayNote;
}

export function listAwayNotes(opts: { reviewed?: boolean; limit?: number } = {}): AwayNote[] {
  const db = getAppDb();
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
  if (opts.reviewed === false) {
    return db
      .prepare(
        `SELECT ${AWAY_NOTE_COLS} FROM away_notes WHERE reviewed_at IS NULL ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as AwayNote[];
  }
  if (opts.reviewed === true) {
    return db
      .prepare(
        `SELECT ${AWAY_NOTE_COLS} FROM away_notes WHERE reviewed_at IS NOT NULL ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as AwayNote[];
  }
  return db
    .prepare(`SELECT ${AWAY_NOTE_COLS} FROM away_notes ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as AwayNote[];
}

export function getAwayNote(id: number): AwayNote | null {
  const db = getAppDb();
  const row = db
    .prepare(`SELECT ${AWAY_NOTE_COLS} FROM away_notes WHERE id = ?`)
    .get(id) as AwayNote | undefined;
  return row ?? null;
}

export function markAwayNoteReviewed(id: number): AwayNote | null {
  const db = getAppDb();
  db.prepare(
    "UPDATE away_notes SET reviewed_at = strftime('%s','now')*1000 WHERE id = ?",
  ).run(id);
  return getAwayNote(id);
}

export function markAllAwayNotesReviewed(): number {
  const db = getAppDb();
  return db
    .prepare(
      "UPDATE away_notes SET reviewed_at = strftime('%s','now')*1000 WHERE reviewed_at IS NULL",
    )
    .run().changes;
}

export function removeAwayNote(id: number): boolean {
  const db = getAppDb();
  return db.prepare('DELETE FROM away_notes WHERE id = ?').run(id).changes > 0;
}

export function countUnreviewedAwayNotes(): number {
  const db = getAppDb();
  const row = db
    .prepare('SELECT COUNT(*) as n FROM away_notes WHERE reviewed_at IS NULL')
    .get() as { n: number } | undefined;
  return row?.n ?? 0;
}
