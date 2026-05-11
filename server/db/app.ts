import { randomUUID } from 'node:crypto';
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

    -- Per-contact prose profile. User-written, long-form context about the
    -- contact: relationship, identity, sensitivities, how to talk to them.
    -- Distinct from contact_notes (short atomic facts) and radar profile
    -- (auto-distilled from signals). Injected into every AI reply (regular
    -- draft AND away-mode auto-reply) as a "WHO YOU'RE TALKING TO" section.
    CREATE TABLE IF NOT EXISTS contact_profiles (
      handle       TEXT PRIMARY KEY,
      profile      TEXT NOT NULL DEFAULT '',
      updated_at   INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    );

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
      chat_id         INTEGER,                    -- Stage 4 of group support: when set, scheduler routes via sendToChat (group-aware) instead of buddy form
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

    -- Away mode for GROUP CHATS: opt-in chats (by chat.db chat.ROWID).
    -- Distinct from away_contacts because group chats don't have a single
    -- handle. Galt only auto-replies in groups that are explicitly listed
    -- here — adding a single contact to away_contacts does NOT auto-opt
    -- every group that contact is in.
    CREATE TABLE IF NOT EXISTS away_chats (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id     INTEGER NOT NULL UNIQUE,
      label       TEXT,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_away_chats_enabled ON away_chats(enabled);

    -- Away sessions: one per (chat, away-period). Status flow:
    --   greeting_sent → continuing → ended.
    -- For 1:1 chats the session is keyed by handle (the contact); for group
    -- chats, by chat_id (the conversation, not any single member). The
    -- chat_id column is the canonical key going forward; handle is kept
    -- for display + back-compat with existing 1:1 lookups.
    CREATE TABLE IF NOT EXISTS away_sessions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      handle            TEXT NOT NULL,
      chat_id           INTEGER,
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
    -- idx_away_sessions_chat_status is created AFTER the defensive ALTER
    -- below — on existing installs the chat_id column doesn't exist yet,
    -- so an inline CREATE INDEX referencing it throws and aborts the
    -- whole migration block.

    -- Auto notes: substantive things extracted from inbound messages that the
    -- user should personally follow up on. Runs 24/7 on every inbound message
    -- regardless of mode (was previously coupled to away mode, hence the
    -- former 'away_notes' name; the runtime behavior was already mode-
    -- agnostic, the data model just hadn't caught up).
    CREATE TABLE IF NOT EXISTS auto_notes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      INTEGER,
      handle          TEXT NOT NULL,
      message_guid    TEXT NOT NULL,
      message_rowid   INTEGER,
      message_text    TEXT,
      summary         TEXT NOT NULL,
      category        TEXT NOT NULL
                       CHECK (category IN ('urgent', 'business', 'personal')),
      reasoning       TEXT,
      created_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      reviewed_at     INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_notes_unique ON auto_notes(message_guid);
    CREATE INDEX IF NOT EXISTS idx_auto_notes_handle ON auto_notes(handle);
    CREATE INDEX IF NOT EXISTS idx_auto_notes_unreviewed ON auto_notes(reviewed_at);

    -- Summon sessions: Galt is invoked into a live conversation by a user-typed
    -- trigger phrase ("GALT!!" by default), and stays active until the user
    -- types the end phrase ("go away galt"), the per-session reply cap is hit,
    -- the session goes idle past summon_idle_timeout_min, or it's manually
    -- ended from the dashboard. Distinct from away_sessions (which cover
    -- when the user is gone). One active session per (chat_id) at a time.
    CREATE TABLE IF NOT EXISTS summon_sessions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id           INTEGER NOT NULL,
      handle            TEXT NOT NULL,
      started_at        INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      last_activity_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      last_ai_reply_at  INTEGER,
      ai_reply_count    INTEGER NOT NULL DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'ended')),
      ended_at          INTEGER,
      ended_reason      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_summon_sessions_chat_status ON summon_sessions(chat_id, status);
    CREATE INDEX IF NOT EXISTS idx_summon_sessions_started ON summon_sessions(started_at);

    -- Per-call AI usage log. One row per LLM completion that returns a
    -- usage object. Cost is computed at write time from a small price
    -- table (see server/ai.ts::priceUsage); storing it lets us aggregate
    -- without the price table at read time, and keeps history correct
    -- even if prices change later.
    CREATE TABLE IF NOT EXISTS ai_usage_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      provider          TEXT NOT NULL DEFAULT 'openai',
      model             TEXT NOT NULL,
      purpose           TEXT,                         -- 'classify' | 'draft' | 'auto_note' | 'flag_eval' | 'calendar' | 'radar_signal' | 'radar_profile' | 'summarize'
      prompt_tokens     INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens      INTEGER NOT NULL DEFAULT 0,
      cost_usd          REAL NOT NULL DEFAULT 0,
      called_at         INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_ai_usage_called_at ON ai_usage_log(called_at);

    -- Long-running tasks (Claude CLI delegations, future heavy
    -- operations). Decouples slow ops from the chat-turn request /
    -- response cycle. Events stream into task_events; the row here
    -- is the canonical task state, mirrored to RTDB so both clients
    -- can subscribe to live updates and act (cancel) on it.
    CREATE TABLE IF NOT EXISTS tasks (
      id                  TEXT PRIMARY KEY,                                -- uuid
      type                TEXT NOT NULL,                                   -- 'claude_delegate' | future kinds
      status              TEXT NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
      input               TEXT NOT NULL,                                   -- JSON
      source_chat_msg_id  TEXT,                                            -- the galt_chat message this task is attached to
      created_at          INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      started_at          INTEGER,
      finished_at         INTEGER,
      result              TEXT,                                            -- final reply or short summary
      error               TEXT,
      -- Claude-specific summary fields (null for other task types):
      session_id          TEXT,
      model               TEXT,
      total_cost_usd      REAL,
      num_turns           INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_source_msg ON tasks(source_chat_msg_id);

    CREATE TABLE IF NOT EXISTS task_events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id   TEXT NOT NULL,
      kind      TEXT NOT NULL,                                             -- 'tool_use' | 'tool_result' | 'message' | 'system' | 'error'
      data      TEXT,                                                      -- JSON
      ts        INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_task_events_task_ts ON task_events(task_id, ts);

    -- Google Chat spaces: all known spaces + watch state / polling watermark.
    CREATE TABLE IF NOT EXISTS gchat_spaces (
      name              TEXT PRIMARY KEY,      -- "spaces/XXXXXXX"
      display_name      TEXT,
      space_type        TEXT,                  -- SPACE | GROUP_CHAT | DIRECT_MESSAGE
      watched           INTEGER DEFAULT 0,     -- 1 = watcher polls this space
      last_message_time TEXT,                  -- ISO watermark for createTime filter
      added_at          INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    -- Google Chat messages: raw log for dedup + search.
    CREATE TABLE IF NOT EXISTS gchat_messages (
      name         TEXT PRIMARY KEY,           -- "spaces/XXX/messages/YYY"
      space_name   TEXT NOT NULL,
      sender_name  TEXT,
      sender_type  TEXT,                       -- HUMAN | BOT
      text         TEXT,
      create_time  TEXT,
      thread_name  TEXT,
      note_id      INTEGER,                    -- FK → auto_notes.id if extracted
      indexed_at   INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_gchat_messages_space ON gchat_messages(space_name, create_time);

    -- Repo monitor: registered repos (claude-kit enabled codebases).
    CREATE TABLE IF NOT EXISTS repos (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      local_path      TEXT NOT NULL UNIQUE,
      repo_url        TEXT,
      company         TEXT,
      platform        TEXT,
      description     TEXT,
      active          INTEGER DEFAULT 1,
      last_polled_at  INTEGER,
      last_commit_sha TEXT,
      added_at        INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS repo_phases (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      phase_num   INTEGER NOT NULL,
      name        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'unknown',
      scope       TEXT,
      task_ids    TEXT,
      updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      UNIQUE(repo_id, phase_num)
    );

    CREATE TABLE IF NOT EXISTS repo_tasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      task_id     TEXT NOT NULL,
      title       TEXT,
      state       TEXT NOT NULL DEFAULT 'backlog',
      phase_num   INTEGER,
      is_stub     INTEGER DEFAULT 0,
      body        TEXT,
      file_path   TEXT,
      mtime       INTEGER,
      updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      UNIQUE(repo_id, task_id)
    );
    CREATE INDEX IF NOT EXISTS idx_repo_tasks_state ON repo_tasks(repo_id, state);

    CREATE TABLE IF NOT EXISTS repo_audit_entries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      entry_date  TEXT NOT NULL,
      emoji       TEXT,
      text        TEXT,
      seen_at     INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_repo_audit_date ON repo_audit_entries(repo_id, entry_date DESC);

    CREATE TABLE IF NOT EXISTS state (
      key          TEXT PRIMARY KEY,
      value        TEXT NOT NULL
    );
  `);

  // Defensive ALTERs for upgrades from prior schema.
  // away_sessions.chat_id (added in Stage 2 of group-message support) —
  // existing rows leave it null; new sessions populate it.
  const awaySessionCols = db.prepare('PRAGMA table_info(away_sessions)').all() as Array<{ name: string }>;
  if (!awaySessionCols.some((c) => c.name === 'chat_id')) {
    db.exec('ALTER TABLE away_sessions ADD COLUMN chat_id INTEGER');
  }
  // The chat_id index is created here AFTER the column is guaranteed to
  // exist (either via the fresh CREATE TABLE in the inline block above,
  // or via the ALTER for existing installs).
  db.exec('CREATE INDEX IF NOT EXISTS idx_away_sessions_chat_status ON away_sessions(chat_id, status)');

  // scheduled_messages.chat_id (added in Stage 4 of group-message
  // support) — when set, the scheduler tick routes through the chat-
  // aware sendToChat instead of the legacy handle-only path.
  const scheduledCols = db.prepare('PRAGMA table_info(scheduled_messages)').all() as Array<{ name: string }>;
  if (!scheduledCols.some((c) => c.name === 'chat_id')) {
    db.exec('ALTER TABLE scheduled_messages ADD COLUMN chat_id INTEGER');
  }

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

  // calendar_proposals.target_calendar — destination calendar in
  // Calendar.app that the user picked on the approval card. Null
  // means "use Calendar.app's default" (the importer dialog will
  // fall back to its system default selection).
  const calPropCols = db.prepare('PRAGMA table_info(calendar_proposals)').all() as Array<{ name: string }>;
  if (!calPropCols.some((c) => c.name === 'target_calendar')) {
    db.exec('ALTER TABLE calendar_proposals ADD COLUMN target_calendar TEXT');
  }

  // Migrate legacy away_notes category set: meet/discuss/request/urgent/other → urgent/business/personal.
  // Detect via the CHECK clause in sqlite_master; idempotent (no-op on fresh
  // install or after migration). Runs BEFORE the rename-to-auto_notes step
  // so the data is shaped correctly before it moves.
  const legacyAwayNotesSql =
    (db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='away_notes'")
      .get() as { sql: string } | undefined)?.sql ?? '';
  if (legacyAwayNotesSql.includes("'meet'")) {
    db.exec(`
      BEGIN;
      CREATE TABLE away_notes_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id      INTEGER,
        handle          TEXT NOT NULL,
        message_guid    TEXT NOT NULL,
        message_rowid   INTEGER,
        message_text    TEXT,
        summary         TEXT NOT NULL,
        category        TEXT NOT NULL
                         CHECK (category IN ('urgent', 'business', 'personal')),
        reasoning       TEXT,
        created_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
        reviewed_at     INTEGER
      );
      INSERT INTO away_notes_new
        (id, session_id, handle, message_guid, message_rowid, message_text, summary, category, reasoning, created_at, reviewed_at)
      SELECT
        id, session_id, handle, message_guid, message_rowid, message_text, summary,
        CASE category
          WHEN 'urgent'  THEN 'urgent'
          WHEN 'request' THEN 'business'
          ELSE 'personal'
        END,
        reasoning, created_at, reviewed_at
      FROM away_notes;
      DROP TABLE away_notes;
      ALTER TABLE away_notes_new RENAME TO away_notes;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_away_notes_unique ON away_notes(message_guid);
      CREATE INDEX IF NOT EXISTS idx_away_notes_handle ON away_notes(handle);
      CREATE INDEX IF NOT EXISTS idx_away_notes_unreviewed ON away_notes(reviewed_at);
      COMMIT;
    `);
    console.log('[migrate] away_notes categories migrated to urgent/business/personal');
  }

  // Rename away_notes → auto_notes. The feature was promoted from "away
  // mode follow-ups" to a first-class 24/7 inbound-message triage; the
  // table moves with it. Idempotent: only runs when away_notes exists and
  // auto_notes does not.
  const hasAwayNotes = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='away_notes'")
    .get();
  const hasAutoNotes = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auto_notes'")
    .get();
  if (hasAwayNotes && !hasAutoNotes) {
    db.exec(`
      BEGIN;
      ALTER TABLE away_notes RENAME TO auto_notes;
      DROP INDEX IF EXISTS idx_away_notes_unique;
      DROP INDEX IF EXISTS idx_away_notes_handle;
      DROP INDEX IF EXISTS idx_away_notes_unreviewed;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_notes_unique ON auto_notes(message_guid);
      CREATE INDEX IF NOT EXISTS idx_auto_notes_handle ON auto_notes(handle);
      CREATE INDEX IF NOT EXISTS idx_auto_notes_unreviewed ON auto_notes(reviewed_at);
      COMMIT;
    `);
    console.log('[migrate] away_notes renamed to auto_notes');
  }

  // Add source + source_meta to auto_notes (Google Chat notes flow into the
  // same table; source distinguishes origin). Idempotent via PRAGMA check.
  const autoNoteCols = db.prepare('PRAGMA table_info(auto_notes)').all() as Array<{ name: string }>;
  if (!autoNoteCols.some((c) => c.name === 'source')) {
    db.exec("ALTER TABLE auto_notes ADD COLUMN source TEXT NOT NULL DEFAULT 'imessage'");
    console.log('[migrate] auto_notes: added source column');
  }
  if (!autoNoteCols.some((c) => c.name === 'source_meta')) {
    db.exec('ALTER TABLE auto_notes ADD COLUMN source_meta TEXT');
    console.log('[migrate] auto_notes: added source_meta column');
  }

  // Rename kv key summon_persona → galt_voice_profile. Galt's voice was
  // promoted from a summon-only "persona" knob to a first-class voice
  // profile parallel to the user's voice_profile (used wherever Galt is
  // himself rather than impersonating the user). Idempotent: only acts
  // when galt_voice_profile is unset and summon_persona has a value.
  const oldRow = db
    .prepare("SELECT value FROM state WHERE key='summon_persona'")
    .get() as { value: string } | undefined;
  const newRow = db
    .prepare("SELECT 1 FROM state WHERE key='galt_voice_profile'")
    .get();
  if (oldRow && !newRow) {
    db.exec('BEGIN');
    db.prepare("INSERT INTO state(key, value) VALUES ('galt_voice_profile', ?)")
      .run(oldRow.value);
    db.prepare("DELETE FROM state WHERE key='summon_persona'").run();
    db.exec('COMMIT');
    console.log('[migrate] summon_persona renamed to galt_voice_profile');
  } else if (oldRow && newRow) {
    // Both keys present (race condition / manual edit) — drop the old one
    // so the new one is the single source of truth going forward.
    db.prepare("DELETE FROM state WHERE key='summon_persona'").run();
    console.log('[migrate] dropped stale summon_persona key (galt_voice_profile already set)');
  }
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

/** Stable per-install UUID. Generated on first call, persisted in the
 *  state table forever. Used to identify which mac wrote a Firebase-
 *  mirrored row when this app ever runs on more than one machine. */
let _cachedDeviceId: string | null = null;
export function getDeviceId(): string {
  if (_cachedDeviceId) return _cachedDeviceId;
  let id = getState('device_id');
  if (!id) {
    id = randomUUID();
    setState('device_id', id);
    console.log(`[device] generated device_id=${id}`);
  }
  _cachedDeviceId = id;
  return id;
}

/* ---------- settings (typed wrapper around state) ---------- */

export interface AppSettings {
  /** Number of recent messages to attach to AI prompts as context. */
  ai_context_count: number;
  // The user's voice_profile / voice_profile_sample_count /
  // voice_profile_user_context / voice_profile_updated_at fields were
  // removed when Galt became the system-wide AI voice. Old data stays
  // in the kv store on disk (orphan keys) so it can be recovered if
  // the concept is ever rebuilt. Galt's own voice lives in
  // galt_voice_profile below.
  /** Away mode: when on, opted-in contacts get auto-replies. 0/1 (treated as bool). */
  away_mode_enabled: number;
  /** The greeting sent on the FIRST incoming message in away mode. */
  away_message: string;
  /** Per-session AI reply cap (safety against runaway). */
  away_max_replies_per_session: number;
  /** Free-text behavior guidance for Galt while in away mode.
   *  Distinct from galt_voice_profile (which captures Galt's voice for ALL
   *  modes). This shapes how Galt BEHAVES specifically while covering —
   *  banter level, deflection style, jokes, how to handle "are you really
   *  the AI?" etc. Wrapped by wrapper_away_persona before injection. */
  away_persona: string;
  /** Insert a humanizing pause before each away-mode auto-send so replies
   *  don't feel robotically instant. 0/1 (treated as bool). Default 1. */
  away_send_delay_enabled: number;
  /** Summon mode: master switch. 0/1. Default 1. When off, the trigger
   *  phrase does nothing. */
  summon_enabled: number;
  /** Phrase the USER types to summon Galt into a chat. Strict, case-sensitive
   *  substring match. */
  summon_trigger_phrase: string;
  /** Phrase the USER types to dismiss Galt. Case-insensitive substring match. */
  summon_end_phrase: string;
  /** Voice profile for Galt — prose describing Galt's style, tone,
   *  register, quirks. This is the SYSTEM-WIDE AI VOICE: every AI call
   *  (away mode, summon mode, manual draft) speaks in this voice.
   *  User-written; no AI generation. Was named summon_persona — migrated
   *  at boot. The user's old `voice_profile` setting is deprecated; Galt
   *  no longer impersonates the user. */
  galt_voice_profile: string;
  /** Per-session reply cap. Sessions auto-end when hit. */
  summon_max_replies_per_session: number;
  /** Auto-end after this many minutes with no messages in the chat. */
  summon_idle_timeout_min: number;
  /** Full system-prompt override for summon mode. When non-empty, REPLACES
   *  the built-in summon prompt entirely (the per-turn context note passed
   *  to draftReply). The thread, voice profile, contact context, address
   *  book, and persona keep flowing through their normal paths — only the
   *  summon-mode instruction text is overridden. Supports two placeholder
   *  substitutions: {userName} and {recipientName}. Empty = use built-in. */
  summon_system_prompt: string;
  /** Pre-AI literal "yes I'm here" acknowledgment Galt sends when the
   *  trigger phrase opens a new summon session AND the trigger is bare
   *  (no actual ask attached). Sent verbatim, bypasses the model.
   *  Mirrors away_message but for the summon side. Default: "yes...". */
  summon_acknowledgment: string;
  /** Auto Notes: master switch for the 24/7 inbound-message triage that
   *  extracts substantive follow-up items into the auto_notes table.
   *  When 0, no AI extraction runs on inbound messages (away mode and
   *  summon mode keep working — they're independent). 0/1, default 1. */
  auto_notes_enabled: number;
  /** Reserved for future use — minimum confidence (0..100) the extractor
   *  needs before persisting a note. Default 0 = no filter. The AI
   *  function doesn't return a confidence today; this exists so the
   *  setting + UI can land before the extractor is updated. */
  auto_notes_min_confidence: number;
  /** JSON array of handles (phone numbers / emails) to skip during auto-
   *  note extraction. Default '[]'. Lets the user opt specific contacts
   *  out without disabling the whole feature. */
  auto_notes_excluded_handles: string;
  /** OpenAI API key. When set, takes precedence over the OPENAI_API_KEY env
   *  var. Stored locally in app.db so users can configure AI from the
   *  Settings UI instead of editing .env. NEVER returned by /api/settings —
   *  the route masks it. */
  openai_api_key: string;
  /** Model name. Defaults to env or 'gpt-4o-mini'. */
  openai_model: string;
  /* ----- prompt/wrapper overrides (default '' = use code defaults) -----
   * Every hardcoded prompt fragment that ships in the AI layer can be
   * overridden by the user via Galt → Prompts. Empty string falls back
   * to the matching DEFAULT_* constant in server/ai.ts. PROMPT_DEFAULTS
   * (also in server/ai.ts) is mirrored to the UI via /api/settings so
   * the user can see exactly what's running.
   */
  /** Replaces DEFAULT_DRAFT_SYSTEM (universal "writing AS the user" base). */
  prompt_draft_system: string;
  /** Replaces DEFAULT_AWAY_GUARDRAIL — only injected when away_mode is on. */
  prompt_away_guardrail: string;
  /** Replaces buildAwayContextNote output (the per-turn away instruction).
   *  Substitutions: {recipientName}, {persona}. Empty = use code function. */
  prompt_away_system: string;
  /** Wrapper templates around data-injection blocks. {body} substitution. */
  wrapper_voice_profile: string;
  wrapper_contact_profile: string;
  wrapper_address_book: string;
  wrapper_calendar: string;
  wrapper_contact_notes: string;
  /** Wrapper for temperament. {temperament} + {guidance} substitutions. */
  wrapper_temperament: string;
  /** Wrapper for the away_persona block. {body} = the persona text. Only
   *  injected when in away mode and away_persona is non-empty. Promotes
   *  persona from "data fed to {persona} placeholder" to a first-class
   *  injection stage in the Away lane of the pipeline. */
  wrapper_away_persona: string;
}

export const SETTING_DEFAULTS: AppSettings = {
  ai_context_count: 20,
  away_mode_enabled: 0,
  away_message:
    "Hey, this is Galt — Chazz's AI assistant. He's away right now, but I can keep things moving in the meantime. Anything that needs his actual call I'll flag for him; he'll catch up properly when he's back.",
  away_max_replies_per_session: 50,
  away_persona: '',
  away_send_delay_enabled: 1,
  summon_enabled: 1,
  summon_trigger_phrase: 'GALT!!',
  summon_end_phrase: 'go away galt',
  galt_voice_profile: '',
  summon_max_replies_per_session: 30,
  summon_idle_timeout_min: 30,
  summon_system_prompt: '',
  summon_acknowledgment: 'yes...',
  auto_notes_enabled: 1,
  auto_notes_min_confidence: 0,
  auto_notes_excluded_handles: '[]',
  openai_api_key: '',
  openai_model: '',
  prompt_draft_system: '',
  prompt_away_guardrail: '',
  prompt_away_system: '',
  wrapper_voice_profile: '',
  wrapper_contact_profile: '',
  wrapper_address_book: '',
  wrapper_calendar: '',
  wrapper_contact_notes: '',
  wrapper_temperament: '',
  wrapper_away_persona: '',
};

export const SETTING_BOUNDS = {
  ai_context_count: { min: 1, max: 100 },
  away_max_replies_per_session: { min: 1, max: 200 },
  summon_max_replies_per_session: { min: 1, max: 200 },
  summon_idle_timeout_min: { min: 1, max: 720 },
  auto_notes_min_confidence: { min: 0, max: 100 },
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
    away_send_delay_enabled: parseIntOr(
      getState('away_send_delay_enabled'),
      SETTING_DEFAULTS.away_send_delay_enabled,
    ),
    summon_enabled: parseIntOr(
      getState('summon_enabled'),
      SETTING_DEFAULTS.summon_enabled,
    ),
    summon_trigger_phrase:
      getState('summon_trigger_phrase') ?? SETTING_DEFAULTS.summon_trigger_phrase,
    summon_end_phrase:
      getState('summon_end_phrase') ?? SETTING_DEFAULTS.summon_end_phrase,
    galt_voice_profile: getState('galt_voice_profile') ?? SETTING_DEFAULTS.galt_voice_profile,
    summon_max_replies_per_session: parseIntOr(
      getState('summon_max_replies_per_session'),
      SETTING_DEFAULTS.summon_max_replies_per_session,
    ),
    summon_idle_timeout_min: parseIntOr(
      getState('summon_idle_timeout_min'),
      SETTING_DEFAULTS.summon_idle_timeout_min,
    ),
    summon_system_prompt:
      getState('summon_system_prompt') ?? SETTING_DEFAULTS.summon_system_prompt,
    summon_acknowledgment:
      getState('summon_acknowledgment') ?? SETTING_DEFAULTS.summon_acknowledgment,
    auto_notes_enabled: parseIntOr(
      getState('auto_notes_enabled'),
      SETTING_DEFAULTS.auto_notes_enabled,
    ),
    auto_notes_min_confidence: parseIntOr(
      getState('auto_notes_min_confidence'),
      SETTING_DEFAULTS.auto_notes_min_confidence,
    ),
    auto_notes_excluded_handles:
      getState('auto_notes_excluded_handles') ?? SETTING_DEFAULTS.auto_notes_excluded_handles,
    openai_api_key: getState('openai_api_key') ?? SETTING_DEFAULTS.openai_api_key,
    openai_model: getState('openai_model') ?? SETTING_DEFAULTS.openai_model,
    prompt_draft_system: getState('prompt_draft_system') ?? SETTING_DEFAULTS.prompt_draft_system,
    prompt_away_guardrail: getState('prompt_away_guardrail') ?? SETTING_DEFAULTS.prompt_away_guardrail,
    prompt_away_system: getState('prompt_away_system') ?? SETTING_DEFAULTS.prompt_away_system,
    wrapper_voice_profile: getState('wrapper_voice_profile') ?? SETTING_DEFAULTS.wrapper_voice_profile,
    wrapper_contact_profile: getState('wrapper_contact_profile') ?? SETTING_DEFAULTS.wrapper_contact_profile,
    wrapper_address_book: getState('wrapper_address_book') ?? SETTING_DEFAULTS.wrapper_address_book,
    wrapper_calendar: getState('wrapper_calendar') ?? SETTING_DEFAULTS.wrapper_calendar,
    wrapper_contact_notes: getState('wrapper_contact_notes') ?? SETTING_DEFAULTS.wrapper_contact_notes,
    wrapper_temperament: getState('wrapper_temperament') ?? SETTING_DEFAULTS.wrapper_temperament,
    wrapper_away_persona: getState('wrapper_away_persona') ?? SETTING_DEFAULTS.wrapper_away_persona,
  };
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  if (patch.ai_context_count !== undefined) {
    const { min, max } = SETTING_BOUNDS.ai_context_count;
    const n = Math.max(min, Math.min(max, Math.floor(Number(patch.ai_context_count))));
    if (!Number.isFinite(n)) throw new Error('ai_context_count must be an integer');
    setState('ai_context_count', String(n));
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
  if (patch.away_send_delay_enabled !== undefined) {
    setState('away_send_delay_enabled', String(patch.away_send_delay_enabled ? 1 : 0));
  }
  if (patch.summon_enabled !== undefined) {
    setState('summon_enabled', String(patch.summon_enabled ? 1 : 0));
  }
  if (patch.summon_trigger_phrase !== undefined) {
    const v = String(patch.summon_trigger_phrase).trim();
    if (!v) throw new Error('summon_trigger_phrase cannot be empty');
    setState('summon_trigger_phrase', v);
  }
  if (patch.summon_end_phrase !== undefined) {
    const v = String(patch.summon_end_phrase).trim();
    if (!v) throw new Error('summon_end_phrase cannot be empty');
    setState('summon_end_phrase', v);
  }
  if (patch.galt_voice_profile !== undefined) {
    setState('galt_voice_profile', String(patch.galt_voice_profile));
  }
  if (patch.summon_max_replies_per_session !== undefined) {
    const { min, max } = SETTING_BOUNDS.summon_max_replies_per_session;
    const n = Math.max(min, Math.min(max, Math.floor(Number(patch.summon_max_replies_per_session))));
    if (!Number.isFinite(n)) throw new Error('summon_max_replies_per_session must be an integer');
    setState('summon_max_replies_per_session', String(n));
  }
  if (patch.summon_idle_timeout_min !== undefined) {
    const { min, max } = SETTING_BOUNDS.summon_idle_timeout_min;
    const n = Math.max(min, Math.min(max, Math.floor(Number(patch.summon_idle_timeout_min))));
    if (!Number.isFinite(n)) throw new Error('summon_idle_timeout_min must be an integer');
    setState('summon_idle_timeout_min', String(n));
  }
  if (patch.summon_system_prompt !== undefined) {
    setState('summon_system_prompt', String(patch.summon_system_prompt));
  }
  if (patch.summon_acknowledgment !== undefined) {
    setState('summon_acknowledgment', String(patch.summon_acknowledgment));
  }
  if (patch.auto_notes_enabled !== undefined) {
    setState('auto_notes_enabled', String(patch.auto_notes_enabled ? 1 : 0));
  }
  if (patch.auto_notes_min_confidence !== undefined) {
    const { min, max } = SETTING_BOUNDS.auto_notes_min_confidence;
    const n = Math.max(min, Math.min(max, Math.floor(Number(patch.auto_notes_min_confidence))));
    if (!Number.isFinite(n)) throw new Error('auto_notes_min_confidence must be an integer');
    setState('auto_notes_min_confidence', String(n));
  }
  if (patch.auto_notes_excluded_handles !== undefined) {
    // Must be a JSON array of strings. Reject anything else so the read
    // path can JSON.parse without try/catch.
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(patch.auto_notes_excluded_handles));
    } catch {
      throw new Error('auto_notes_excluded_handles must be a JSON array of strings');
    }
    if (!Array.isArray(parsed) || !parsed.every((h) => typeof h === 'string')) {
      throw new Error('auto_notes_excluded_handles must be a JSON array of strings');
    }
    setState('auto_notes_excluded_handles', JSON.stringify(parsed));
  }
  if (patch.openai_api_key !== undefined) {
    // Trim whitespace; an empty string clears the key (falls back to env var).
    const k = String(patch.openai_api_key).trim();
    setState('openai_api_key', k);
  }
  if (patch.openai_model !== undefined) {
    setState('openai_model', String(patch.openai_model).trim());
  }
  // Prompt / wrapper overrides — pass through verbatim. Empty string clears
  // the override and re-falls-back to the matching DEFAULT_* code constant.
  for (const key of [
    'prompt_draft_system',
    'prompt_away_guardrail',
    'prompt_away_system',
    'wrapper_voice_profile',
    'wrapper_contact_profile',
    'wrapper_address_book',
    'wrapper_calendar',
    'wrapper_contact_notes',
    'wrapper_temperament',
    'wrapper_away_persona',
  ] as const) {
    if (patch[key] !== undefined) {
      setState(key, String(patch[key]));
    }
  }
  return getSettings();
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

/* ---------- contact profiles (per-handle, long-form prose) ---------- */

export interface ContactProfile {
  handle: string;
  profile: string;
  updated_at: number;
}

/** Returns the profile if one exists, otherwise an empty string. Always safe to call. */
export function getContactProfile(handle: string): ContactProfile {
  const db = getAppDb();
  const row = db
    .prepare('SELECT handle, profile, updated_at FROM contact_profiles WHERE handle = ?')
    .get(handle) as ContactProfile | undefined;
  return row ?? { handle, profile: '', updated_at: 0 };
}

/** Set or clear the profile. An empty string is a valid value (clears it). */
export function setContactProfile(handle: string, profile: string): ContactProfile {
  const db = getAppDb();
  const trimmed = profile.trim();
  db.prepare(
    `INSERT INTO contact_profiles(handle, profile, updated_at)
     VALUES (?, ?, strftime('%s','now')*1000)
     ON CONFLICT(handle) DO UPDATE SET
       profile = excluded.profile,
       updated_at = excluded.updated_at`,
  ).run(handle, trimmed);
  return getContactProfile(handle);
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
  /** Set when the schedule was created from a chat-aware path; the
   *  scheduler tick prefers it over `handle` so group sends route
   *  correctly. Null for legacy 1:1 schedules. */
  chat_id: number | null;
  body: string;
  send_at: number;
  status: ScheduledStatus;
  service: string;
  source_draft_id: number | null;
  created_at: number;
  sent_at: number | null;
  error: string | null;
}

const SCHED_COLS =
  'id, handle, chat_id, body, send_at, status, service, source_draft_id, created_at, sent_at, error';

export function listScheduled(status?: ScheduledStatus): ScheduledMessage[] {
  const db = getAppDb();
  if (status) {
    return db
      .prepare(`SELECT ${SCHED_COLS} FROM scheduled_messages WHERE status = ? ORDER BY send_at ASC`)
      .all(status) as ScheduledMessage[];
  }
  return db
    .prepare(`SELECT ${SCHED_COLS} FROM scheduled_messages ORDER BY send_at ASC`)
    .all() as ScheduledMessage[];
}

export function getScheduled(id: number): ScheduledMessage | null {
  const db = getAppDb();
  const row = db
    .prepare(`SELECT ${SCHED_COLS} FROM scheduled_messages WHERE id = ?`)
    .get(id) as ScheduledMessage | undefined;
  return row ?? null;
}

export function listDueScheduled(now: number = Date.now()): ScheduledMessage[] {
  const db = getAppDb();
  return db
    .prepare(
      `SELECT ${SCHED_COLS} FROM scheduled_messages WHERE status = 'pending' AND send_at <= ? ORDER BY send_at ASC`,
    )
    .all(now) as ScheduledMessage[];
}

export function createScheduled(input: {
  handle: string;
  chat_id?: number | null;
  body: string;
  send_at: number;
  service?: string;
  source_draft_id?: number | null;
}): ScheduledMessage {
  const db = getAppDb();
  const info = db
    .prepare(
      'INSERT INTO scheduled_messages(handle, chat_id, body, send_at, service, source_draft_id) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      input.handle,
      input.chat_id ?? null,
      input.body,
      input.send_at,
      input.service ?? 'iMessage',
      input.source_draft_id ?? null,
    );
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
  /** Calendar name the user picked on the approval card. Null = use
   *  Calendar.app's default. Stamped into the .ics as X-WR-CALNAME
   *  on export. */
  target_calendar: string | null;
}

const CAL_COLS =
  'id, source_msg_guid, message_rowid, chat_id, handle, title, start_ms, end_ms, location, participants, notes, confidence, reasoning, status, source_rule_id, created_at, decided_at, target_calendar';

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

/** Update which calendar the proposal targets. Null clears it so
 *  the .ics is exported without an X-WR-CALNAME hint (Calendar.app
 *  uses its system default). */
export function setCalendarProposalTarget(
  id: number,
  targetCalendar: string | null,
): CalendarProposal | null {
  const db = getAppDb();
  db.prepare('UPDATE calendar_proposals SET target_calendar = ? WHERE id = ?')
    .run(targetCalendar, id);
  return getCalendarProposal(id);
}

/** Insert a chat-sourced calendar proposal. Sentinel values are used
 *  for the message-bound columns since the existing schema requires
 *  them NOT NULL (the schema predates chat-sourced proposals). The
 *  source_msg_guid is `chat:<galt_message_id>` for dedup. */
export function insertChatCalendarProposal(input: {
  galt_message_id: string;
  title: string;
  start_ms: number | null;
  end_ms: number | null;
  location: string | null;
  participants: string | null;
  notes: string | null;
  confidence: number | null;
  reasoning: string | null;
}): CalendarProposal | null {
  return insertCalendarProposal({
    source_msg_guid: `chat:${input.galt_message_id}`,
    message_rowid: 0,
    chat_id: 0,
    handle: '',
    title: input.title,
    start_ms: input.start_ms,
    end_ms: input.end_ms,
    location: input.location,
    participants: input.participants,
    notes: input.notes,
    confidence: input.confidence,
    reasoning: input.reasoning,
    source_rule_id: null,
  });
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
  /** Set when the session covers a group chat. Null for legacy 1:1
   *  sessions and for 1:1 sessions opened before Stage 2 — the handle
   *  stays the canonical key in that case. */
  chat_id: number | null;
  started_at: number;
  last_ai_reply_at: number | null;
  ai_reply_count: number;
  status: AwaySessionStatus;
  ended_at: number | null;
  ended_reason: string | null;
}

/* ============================================================
   Away mode — group-chat watch list (parallel to away_contacts)
   ============================================================ */

export interface AwayChat {
  id: number;
  chat_id: number;
  label: string | null;
  enabled: 0 | 1;
  created_at: number;
}

export function listAwayChats(): AwayChat[] {
  const db = getAppDb();
  return db
    .prepare('SELECT id, chat_id, label, enabled, created_at FROM away_chats ORDER BY id DESC')
    .all() as AwayChat[];
}

/** Set of chat.db chat_id values currently opted into Away mode. */
export function listEnabledAwayChatIds(): Set<number> {
  const db = getAppDb();
  const rows = db
    .prepare('SELECT chat_id FROM away_chats WHERE enabled = 1')
    .all() as Array<{ chat_id: number }>;
  return new Set(rows.map((r) => r.chat_id));
}

export function isAwayChatWatched(chatId: number): boolean {
  const db = getAppDb();
  const row = db
    .prepare('SELECT 1 FROM away_chats WHERE chat_id = ? AND enabled = 1 LIMIT 1')
    .get(chatId);
  return !!row;
}

export function addAwayChat(chatId: number, label: string | null): AwayChat {
  const db = getAppDb();
  db
    .prepare('INSERT OR IGNORE INTO away_chats(chat_id, label) VALUES (?, ?)')
    .run(chatId, label);
  if (label !== null) {
    db.prepare(
      "UPDATE away_chats SET label = ? WHERE chat_id = ? AND (label IS NULL OR label = '')",
    ).run(label, chatId);
  }
  return db
    .prepare('SELECT id, chat_id, label, enabled, created_at FROM away_chats WHERE chat_id = ?')
    .get(chatId) as AwayChat;
}

export function setAwayChatEnabled(id: number, enabled: boolean): boolean {
  const db = getAppDb();
  return (
    db.prepare('UPDATE away_chats SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id).changes > 0
  );
}

export function removeAwayChat(id: number): boolean {
  const db = getAppDb();
  return db.prepare('DELETE FROM away_chats WHERE id = ?').run(id).changes > 0;
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
  'id, handle, chat_id, started_at, last_ai_reply_at, ai_reply_count, status, ended_at, ended_reason';

/** Look up an active session for a 1:1 chat by recipient handle.
 *  Group chats: use `getActiveAwaySessionForChat(chatId)` instead — a
 *  session in a group is keyed by chat, not by any single member's
 *  handle. */
export function getActiveAwaySession(handle: string): AwaySession | null {
  const db = getAppDb();
  const row = db
    .prepare(
      `SELECT ${AWAY_SESSION_COLS}
       FROM away_sessions
       WHERE handle = ? AND chat_id IS NULL AND status != 'ended'
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(handle) as AwaySession | undefined;
  return row ?? null;
}

/** Look up an active session for a group chat by chat_id. */
export function getActiveAwaySessionForChat(chatId: number): AwaySession | null {
  const db = getAppDb();
  const row = db
    .prepare(
      `SELECT ${AWAY_SESSION_COLS}
       FROM away_sessions
       WHERE chat_id = ? AND status != 'ended'
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(chatId) as AwaySession | undefined;
  return row ?? null;
}

/** Create a session. For 1:1 chats pass just the handle (chat_id stays
 *  null — handle is the canonical key). For group chats pass both — the
 *  chat_id becomes the canonical key, handle is stored for display
 *  (typically the chat.chat_identifier). */
export function createAwaySession(handle: string, chatId?: number | null): AwaySession {
  const db = getAppDb();
  const info = db
    .prepare("INSERT INTO away_sessions(handle, chat_id, status) VALUES (?, ?, 'greeting_sent')")
    .run(handle, chatId ?? null);
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

/* ---------- summon sessions (Galt invoked into a live conversation) ---------- */

export interface SummonSession {
  id: number;
  chat_id: number;
  handle: string;
  started_at: number;
  last_activity_at: number;
  last_ai_reply_at: number | null;
  ai_reply_count: number;
  status: 'active' | 'ended';
  ended_at: number | null;
  ended_reason: string | null;
}

const SUMMON_SESSION_COLS =
  'id, chat_id, handle, started_at, last_activity_at, last_ai_reply_at, ai_reply_count, status, ended_at, ended_reason';

/** Active summon session for a chat, or null. (One per chat at a time.) */
export function getActiveSummonSession(chatId: number): SummonSession | null {
  const db = getAppDb();
  const row = db
    .prepare(
      `SELECT ${SUMMON_SESSION_COLS}
       FROM summon_sessions
       WHERE chat_id = ? AND status = 'active'
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(chatId) as SummonSession | undefined;
  return row ?? null;
}

/** Open a new summon session. Caller should ensure no active one exists first. */
export function createSummonSession(chatId: number, handle: string): SummonSession {
  const db = getAppDb();
  const info = db
    .prepare(
      "INSERT INTO summon_sessions(chat_id, handle, status) VALUES (?, ?, 'active')",
    )
    .run(chatId, handle);
  return db
    .prepare(`SELECT ${SUMMON_SESSION_COLS} FROM summon_sessions WHERE id = ?`)
    .get(info.lastInsertRowid) as SummonSession;
}

/** Bump activity timestamp without incrementing reply count (called on every
 *  message in the session, AI or human, so idle-timeout works). */
export function touchSummonSession(id: number): void {
  const db = getAppDb();
  db.prepare(
    "UPDATE summon_sessions SET last_activity_at = strftime('%s','now')*1000 WHERE id = ?",
  ).run(id);
}

/** Bump after Galt successfully sends a reply. */
export function bumpSummonSession(id: number): SummonSession | null {
  const db = getAppDb();
  db.prepare(
    "UPDATE summon_sessions SET ai_reply_count = ai_reply_count + 1, last_ai_reply_at = strftime('%s','now')*1000, last_activity_at = strftime('%s','now')*1000 WHERE id = ?",
  ).run(id);
  return db
    .prepare(`SELECT ${SUMMON_SESSION_COLS} FROM summon_sessions WHERE id = ?`)
    .get(id) as SummonSession | null;
}

export function endSummonSession(id: number, reason: string): SummonSession | null {
  const db = getAppDb();
  db.prepare(
    "UPDATE summon_sessions SET status = 'ended', ended_at = strftime('%s','now')*1000, ended_reason = ? WHERE id = ?",
  ).run(reason, id);
  return db
    .prepare(`SELECT ${SUMMON_SESSION_COLS} FROM summon_sessions WHERE id = ?`)
    .get(id) as SummonSession | null;
}

export function endAllActiveSummonSessions(reason: string): number {
  const db = getAppDb();
  return db
    .prepare(
      "UPDATE summon_sessions SET status = 'ended', ended_at = strftime('%s','now')*1000, ended_reason = ? WHERE status = 'active'",
    )
    .run(reason).changes;
}

export function listSummonSessions(opts: { activeOnly?: boolean; limit?: number } = {}): SummonSession[] {
  const db = getAppDb();
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  if (opts.activeOnly) {
    return db
      .prepare(
        `SELECT ${SUMMON_SESSION_COLS}
         FROM summon_sessions
         WHERE status = 'active'
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(limit) as SummonSession[];
  }
  return db
    .prepare(`SELECT ${SUMMON_SESSION_COLS} FROM summon_sessions ORDER BY started_at DESC LIMIT ?`)
    .all(limit) as SummonSession[];
}

export function countActiveSummonSessions(): number {
  const db = getAppDb();
  const row = db
    .prepare("SELECT COUNT(*) as n FROM summon_sessions WHERE status = 'active'")
    .get() as { n: number } | undefined;
  return row?.n ?? 0;
}

/** All chat_ids with an active summon session — fast lookup for handler. */
export function activeSummonChatIds(): Set<number> {
  const db = getAppDb();
  const rows = db
    .prepare("SELECT DISTINCT chat_id FROM summon_sessions WHERE status = 'active'")
    .all() as Array<{ chat_id: number }>;
  return new Set(rows.map((r) => r.chat_id));
}

/* ---------- auto notes (24/7 inbound triage — substantive items to follow up on) ---------- */

export type AutoNoteCategory = 'urgent' | 'business' | 'personal';
export type AutoNoteSource = 'imessage' | 'gchat';

export interface AutoNote {
  id: number;
  session_id: number | null;
  handle: string;
  message_guid: string;
  message_rowid: number | null;
  message_text: string | null;
  summary: string;
  category: AutoNoteCategory;
  reasoning: string | null;
  created_at: number;
  reviewed_at: number | null;
  /** 'imessage' (default) or 'gchat' */
  source: AutoNoteSource;
  /** JSON string — for gchat: { space_name, space_display_name, sender_name } */
  source_meta: string | null;
}

const AUTO_NOTE_COLS =
  'id, session_id, handle, message_guid, message_rowid, message_text, summary, category, reasoning, created_at, reviewed_at, source, source_meta';

export function autoNoteAlreadyExists(messageGuid: string): boolean {
  const db = getAppDb();
  return !!db
    .prepare('SELECT 1 FROM auto_notes WHERE message_guid = ? LIMIT 1')
    .get(messageGuid);
}

export function insertAutoNote(input: {
  session_id: number | null;
  handle: string;
  message_guid: string;
  message_rowid: number | null;
  message_text: string | null;
  summary: string;
  category: AutoNoteCategory;
  reasoning: string | null;
  source?: AutoNoteSource;
  source_meta?: string | null;
}): AutoNote | null {
  const db = getAppDb();
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO auto_notes
        (session_id, handle, message_guid, message_rowid, message_text, summary, category, reasoning, source, source_meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.source ?? 'imessage',
      input.source_meta ?? null,
    );
  if (info.changes === 0) return null;
  return db
    .prepare(`SELECT ${AUTO_NOTE_COLS} FROM auto_notes WHERE id = ?`)
    .get(info.lastInsertRowid) as AutoNote;
}

export function listAutoNotes(opts: { reviewed?: boolean; limit?: number } = {}): AutoNote[] {
  const db = getAppDb();
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
  if (opts.reviewed === false) {
    return db
      .prepare(
        `SELECT ${AUTO_NOTE_COLS} FROM auto_notes WHERE reviewed_at IS NULL ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as AutoNote[];
  }
  if (opts.reviewed === true) {
    return db
      .prepare(
        `SELECT ${AUTO_NOTE_COLS} FROM auto_notes WHERE reviewed_at IS NOT NULL ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as AutoNote[];
  }
  return db
    .prepare(`SELECT ${AUTO_NOTE_COLS} FROM auto_notes ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as AutoNote[];
}

export function getAutoNote(id: number): AutoNote | null {
  const db = getAppDb();
  const row = db
    .prepare(`SELECT ${AUTO_NOTE_COLS} FROM auto_notes WHERE id = ?`)
    .get(id) as AutoNote | undefined;
  return row ?? null;
}

export function markAutoNoteReviewed(id: number): AutoNote | null {
  const db = getAppDb();
  db.prepare(
    "UPDATE auto_notes SET reviewed_at = strftime('%s','now')*1000 WHERE id = ?",
  ).run(id);
  return getAutoNote(id);
}

export function markAllAutoNotesReviewed(): number {
  const db = getAppDb();
  return db
    .prepare(
      "UPDATE auto_notes SET reviewed_at = strftime('%s','now')*1000 WHERE reviewed_at IS NULL",
    )
    .run().changes;
}

export function removeAutoNote(id: number): boolean {
  const db = getAppDb();
  return db.prepare('DELETE FROM auto_notes WHERE id = ?').run(id).changes > 0;
}

export function countUnreviewedAutoNotes(): number {
  const db = getAppDb();
  const row = db
    .prepare('SELECT COUNT(*) as n FROM auto_notes WHERE reviewed_at IS NULL')
    .get() as { n: number } | undefined;
  return row?.n ?? 0;
}

/* ============================================================
   AI usage log
   ============================================================ */

export interface AiUsageInput {
  provider: string;
  model: string;
  purpose: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

export function insertAiUsage(input: AiUsageInput): void {
  const db = getAppDb();
  db.prepare(
    `INSERT INTO ai_usage_log
       (provider, model, purpose, prompt_tokens, completion_tokens, total_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.provider,
    input.model,
    input.purpose,
    input.prompt_tokens,
    input.completion_tokens,
    input.total_tokens,
    input.cost_usd,
  );
}

export interface AiUsageStats {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

const ZERO_STATS: AiUsageStats = {
  calls: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  cost_usd: 0,
};

function aggregateSince(sinceMs: number | null): AiUsageStats {
  const db = getAppDb();
  const sql = sinceMs == null
    ? `SELECT COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens), 0)     AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              COALESCE(SUM(total_tokens), 0)      AS total_tokens,
              COALESCE(SUM(cost_usd), 0)          AS cost_usd
         FROM ai_usage_log`
    : `SELECT COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens), 0)     AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              COALESCE(SUM(total_tokens), 0)      AS total_tokens,
              COALESCE(SUM(cost_usd), 0)          AS cost_usd
         FROM ai_usage_log
         WHERE called_at >= ?`;
  const row = sinceMs == null
    ? (db.prepare(sql).get() as AiUsageStats | undefined)
    : (db.prepare(sql).get(sinceMs) as AiUsageStats | undefined);
  return row ?? ZERO_STATS;
}

/** Aggregate stats: today (UTC midnight), last 30 days, all-time. */
export function getAiUsageStats(): {
  today: AiUsageStats;
  last_30d: AiUsageStats;
  all_time: AiUsageStats;
} {
  const now = new Date();
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return {
    today: aggregateSince(utcMidnight),
    last_30d: aggregateSince(thirtyDaysAgo),
    all_time: aggregateSince(null),
  };
}

/* ============================================================
   Tasks — long-running ops (Claude CLI delegations etc.)
   ============================================================ */

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type TaskType = 'claude_delegate';  // future kinds appended here

export interface TaskRow {
  id: string;
  type: TaskType;
  status: TaskStatus;
  input: Record<string, unknown>;
  source_chat_msg_id: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  result: string | null;
  error: string | null;
  session_id: string | null;
  model: string | null;
  total_cost_usd: number | null;
  num_turns: number | null;
}

export interface TaskEventRow {
  id: number;
  task_id: string;
  kind: string;
  data: unknown;
  ts: number;
}

const TASK_COLS =
  'id, type, status, input, source_chat_msg_id, created_at, started_at, finished_at, ' +
  'result, error, session_id, model, total_cost_usd, num_turns';

function rowToTask(raw: Record<string, unknown>): TaskRow {
  let input: Record<string, unknown> = {};
  try { input = JSON.parse(String(raw.input ?? '{}')); } catch { input = {}; }
  return {
    id: String(raw.id),
    type: raw.type as TaskType,
    status: raw.status as TaskStatus,
    input,
    source_chat_msg_id: (raw.source_chat_msg_id as string | null) ?? null,
    created_at: Number(raw.created_at ?? 0),
    started_at: raw.started_at == null ? null : Number(raw.started_at),
    finished_at: raw.finished_at == null ? null : Number(raw.finished_at),
    result: (raw.result as string | null) ?? null,
    error: (raw.error as string | null) ?? null,
    session_id: (raw.session_id as string | null) ?? null,
    model: (raw.model as string | null) ?? null,
    total_cost_usd: raw.total_cost_usd == null ? null : Number(raw.total_cost_usd),
    num_turns: raw.num_turns == null ? null : Number(raw.num_turns),
  };
}

export function createTask(input: {
  id: string;
  type: TaskType;
  input: Record<string, unknown>;
  source_chat_msg_id?: string | null;
}): TaskRow {
  const db = getAppDb();
  db.prepare(
    `INSERT INTO tasks (id, type, status, input, source_chat_msg_id)
     VALUES (?, ?, 'queued', ?, ?)`,
  ).run(input.id, input.type, JSON.stringify(input.input), input.source_chat_msg_id ?? null);
  return getTask(input.id)!;
}

export function getTask(id: string): TaskRow | null {
  const db = getAppDb();
  const row = db.prepare(`SELECT ${TASK_COLS} FROM tasks WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : null;
}

export function listTasks(opts: { status?: TaskStatus; limit?: number } = {}): TaskRow[] {
  const db = getAppDb();
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  const rows = opts.status
    ? (db.prepare(`SELECT ${TASK_COLS} FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
        .all(opts.status, limit) as Array<Record<string, unknown>>)
    : (db.prepare(`SELECT ${TASK_COLS} FROM tasks ORDER BY created_at DESC LIMIT ?`)
        .all(limit) as Array<Record<string, unknown>>);
  return rows.map(rowToTask);
}

/** Patch fields on a task. Pass the new status to trigger started_at /
 *  finished_at stamping; the function decides whether to stamp based
 *  on the transition. */
export function updateTask(
  id: string,
  patch: Partial<Pick<TaskRow, 'status' | 'result' | 'error' | 'session_id' | 'model' | 'total_cost_usd' | 'num_turns'>>,
): TaskRow | null {
  const db = getAppDb();
  const existing = getTask(id);
  if (!existing) return null;
  const now = Date.now();
  const sets: string[] = [];
  const vals: Array<string | number | null> = [];
  if (patch.status !== undefined) {
    sets.push('status = ?');
    vals.push(patch.status);
    // Stamp started_at on first transition into 'running'.
    if (patch.status === 'running' && existing.started_at == null) {
      sets.push('started_at = ?');
      vals.push(now);
    }
    // Stamp finished_at on first transition to a terminal state.
    if (
      (patch.status === 'succeeded' || patch.status === 'failed' || patch.status === 'cancelled') &&
      existing.finished_at == null
    ) {
      sets.push('finished_at = ?');
      vals.push(now);
    }
  }
  if (patch.result !== undefined)         { sets.push('result = ?');         vals.push(patch.result); }
  if (patch.error !== undefined)          { sets.push('error = ?');          vals.push(patch.error); }
  if (patch.session_id !== undefined)     { sets.push('session_id = ?');     vals.push(patch.session_id); }
  if (patch.model !== undefined)          { sets.push('model = ?');          vals.push(patch.model); }
  if (patch.total_cost_usd !== undefined) { sets.push('total_cost_usd = ?'); vals.push(patch.total_cost_usd); }
  if (patch.num_turns !== undefined)      { sets.push('num_turns = ?');      vals.push(patch.num_turns); }
  if (sets.length === 0) return existing;
  vals.push(id);
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getTask(id);
}

export function appendTaskEvent(taskId: string, kind: string, data: unknown): TaskEventRow {
  const db = getAppDb();
  const info = db
    .prepare('INSERT INTO task_events (task_id, kind, data) VALUES (?, ?, ?)')
    .run(taskId, kind, data == null ? null : JSON.stringify(data));
  const row = db
    .prepare('SELECT id, task_id, kind, data, ts FROM task_events WHERE id = ?')
    .get(info.lastInsertRowid) as Record<string, unknown>;
  let parsed: unknown = null;
  if (row.data) {
    try { parsed = JSON.parse(String(row.data)); } catch { parsed = row.data; }
  }
  return {
    id: Number(row.id),
    task_id: String(row.task_id),
    kind: String(row.kind),
    data: parsed,
    ts: Number(row.ts),
  };
}

export function listTaskEvents(taskId: string, opts: { sinceId?: number; limit?: number } = {}): TaskEventRow[] {
  const db = getAppDb();
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 500));
  const sinceId = opts.sinceId ?? 0;
  const rows = db
    .prepare(
      'SELECT id, task_id, kind, data, ts FROM task_events WHERE task_id = ? AND id > ? ORDER BY id ASC LIMIT ?',
    )
    .all(taskId, sinceId, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    let parsed: unknown = null;
    if (row.data) {
      try { parsed = JSON.parse(String(row.data)); } catch { parsed = row.data; }
    }
    return {
      id: Number(row.id),
      task_id: String(row.task_id),
      kind: String(row.kind),
      data: parsed,
      ts: Number(row.ts),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Google Chat spaces                                                  */
/* ------------------------------------------------------------------ */

export interface GChatSpaceRow {
  name: string;
  display_name: string | null;
  space_type: string | null;
  watched: number;    // 0 | 1
  last_message_time: string | null;
  added_at: number;
}

export function upsertGChatSpace(input: {
  name: string;
  display_name: string;
  space_type: string;
}): GChatSpaceRow {
  const db = getAppDb();
  db.prepare(`
    INSERT INTO gchat_spaces (name, display_name, space_type)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      display_name = excluded.display_name,
      space_type   = excluded.space_type
  `).run(input.name, input.display_name, input.space_type);
  return db.prepare('SELECT * FROM gchat_spaces WHERE name = ?').get(input.name) as GChatSpaceRow;
}

export function listGChatSpaces(): GChatSpaceRow[] {
  return getAppDb()
    .prepare('SELECT * FROM gchat_spaces ORDER BY display_name ASC')
    .all() as GChatSpaceRow[];
}

export function listWatchedSpaces(): GChatSpaceRow[] {
  return getAppDb()
    .prepare('SELECT * FROM gchat_spaces WHERE watched = 1 ORDER BY display_name ASC')
    .all() as GChatSpaceRow[];
}

export function setGChatSpaceWatched(name: string, watched: boolean): boolean {
  const info = getAppDb()
    .prepare('UPDATE gchat_spaces SET watched = ? WHERE name = ?')
    .run(watched ? 1 : 0, name);
  return info.changes > 0;
}

export function updateGChatSpaceWatermark(name: string, lastMessageTime: string): void {
  getAppDb()
    .prepare('UPDATE gchat_spaces SET last_message_time = ? WHERE name = ?')
    .run(lastMessageTime, name);
}

/* ------------------------------------------------------------------ */
/* Google Chat messages                                                */
/* ------------------------------------------------------------------ */

export interface GChatMessageRow {
  name: string;
  space_name: string;
  sender_name: string | null;
  sender_type: string | null;
  text: string | null;
  create_time: string | null;
  thread_name: string | null;
  note_id: number | null;
  indexed_at: number;
}

/** Insert a GChat message; idempotent (INSERT OR IGNORE). Returns true if new. */
export function insertGChatMessage(input: {
  name: string;
  space_name: string;
  sender_name: string;
  sender_type: string;
  text: string;
  create_time: string;
  thread_name: string | null;
}): boolean {
  const info = getAppDb().prepare(`
    INSERT OR IGNORE INTO gchat_messages
      (name, space_name, sender_name, sender_type, text, create_time, thread_name)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.name, input.space_name, input.sender_name, input.sender_type,
    input.text, input.create_time, input.thread_name,
  );
  return info.changes > 0;
}

export function setGChatMessageNoteId(messageName: string, noteId: number): void {
  getAppDb()
    .prepare('UPDATE gchat_messages SET note_id = ? WHERE name = ?')
    .run(noteId, messageName);
}

export function listGChatMessages(
  spaceName: string,
  opts: { limit?: number } = {},
): GChatMessageRow[] {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  return getAppDb()
    .prepare(
      'SELECT * FROM gchat_messages WHERE space_name = ? ORDER BY create_time DESC LIMIT ?',
    )
    .all(spaceName, limit) as GChatMessageRow[];
}

export function searchGChatMessages(query: string, spaceName?: string): GChatMessageRow[] {
  const db = getAppDb();
  const like = `%${query}%`;
  if (spaceName) {
    return db
      .prepare('SELECT * FROM gchat_messages WHERE space_name = ? AND text LIKE ? ORDER BY create_time DESC LIMIT 50')
      .all(spaceName, like) as GChatMessageRow[];
  }
  return db
    .prepare('SELECT * FROM gchat_messages WHERE text LIKE ? ORDER BY create_time DESC LIMIT 50')
    .all(like) as GChatMessageRow[];
}

/* ------------------------------------------------------------------ */
/* Repo monitor                                                        */
/* ------------------------------------------------------------------ */

export interface RepoRow {
  id: number;
  name: string;
  local_path: string;
  repo_url: string | null;
  company: string | null;
  platform: string | null;
  description: string | null;
  active: number;
  last_polled_at: number | null;
  last_commit_sha: string | null;
  added_at: number;
}

export interface RepoPhaseRow {
  id: number;
  repo_id: number;
  phase_num: number;
  name: string;
  status: string;
  scope: string | null;
  task_ids: string | null;   // JSON array
  updated_at: number;
}

export interface RepoTaskRow {
  id: number;
  repo_id: number;
  task_id: string;
  title: string | null;
  state: string;
  phase_num: number | null;
  is_stub: number;
  body: string | null;
  file_path: string | null;
  mtime: number | null;
  updated_at: number;
}

export interface RepoAuditEntryRow {
  id: number;
  repo_id: number;
  entry_date: string;
  emoji: string | null;
  text: string | null;
  seen_at: number;
}

export function registerRepo(input: {
  name: string;
  local_path: string;
  company?: string | null;
  repo_url?: string | null;
  platform?: string | null;
  description?: string | null;
}): RepoRow {
  const db = getAppDb();
  db.prepare(`
    INSERT INTO repos (name, local_path, company, repo_url, platform, description)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(local_path) DO UPDATE SET
      name        = excluded.name,
      company     = excluded.company,
      repo_url    = excluded.repo_url,
      platform    = excluded.platform,
      description = excluded.description,
      active      = 1
  `).run(
    input.name, input.local_path,
    input.company ?? null, input.repo_url ?? null,
    input.platform ?? null, input.description ?? null,
  );
  return db.prepare('SELECT * FROM repos WHERE local_path = ?').get(input.local_path) as RepoRow;
}

export function listRepos(opts: { activeOnly?: boolean } = {}): RepoRow[] {
  const db = getAppDb();
  if (opts.activeOnly) {
    return db.prepare('SELECT * FROM repos WHERE active = 1 ORDER BY company, name').all() as RepoRow[];
  }
  return db.prepare('SELECT * FROM repos ORDER BY company, name').all() as RepoRow[];
}

export function getRepo(id: number): RepoRow | null {
  return getAppDb().prepare('SELECT * FROM repos WHERE id = ?').get(id) as RepoRow | null;
}

export function setRepoActive(id: number, active: boolean): boolean {
  const info = getAppDb().prepare('UPDATE repos SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  return info.changes > 0;
}

export function getRepoLastPollSha(id: number): string | null {
  const row = getAppDb()
    .prepare('SELECT last_commit_sha FROM repos WHERE id = ?')
    .get(id) as { last_commit_sha: string | null } | undefined;
  return row?.last_commit_sha ?? null;
}

/** Persist a fresh snapshot into the DB. Pass snapshot=null to just update the poll timestamp. */
export function upsertRepoSnapshot(
  repoId: number,
  snapshot: import('../integrations/repo-monitor.js').RepoSnapshot | null,
  commitSha: string | null,
): void {
  const db = getAppDb();
  const now = Date.now();

  db.prepare(
    'UPDATE repos SET last_polled_at = ?, last_commit_sha = ? WHERE id = ?',
  ).run(now, commitSha, repoId);

  if (!snapshot) return;

  // Update repo metadata from snapshot.
  db.prepare(`
    UPDATE repos SET
      repo_url    = COALESCE(?, repo_url),
      platform    = COALESCE(?, platform),
      description = COALESCE(?, description)
    WHERE id = ?
  `).run(
    snapshot.meta.repo_url, snapshot.meta.platform,
    snapshot.meta.description, repoId,
  );

  // Upsert phases.
  const upsertPhase = db.prepare(`
    INSERT INTO repo_phases (repo_id, phase_num, name, status, scope, task_ids, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo_id, phase_num) DO UPDATE SET
      name = excluded.name, status = excluded.status,
      scope = excluded.scope, task_ids = excluded.task_ids,
      updated_at = excluded.updated_at
  `);
  for (const p of snapshot.phases) {
    upsertPhase.run(
      repoId, p.phase_num, p.name, p.status,
      p.scope, JSON.stringify(p.task_ids), now,
    );
  }

  // Upsert tasks.
  const upsertTask = db.prepare(`
    INSERT INTO repo_tasks (repo_id, task_id, title, state, phase_num, is_stub, body, file_path, mtime, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo_id, task_id) DO UPDATE SET
      title = excluded.title, state = excluded.state,
      phase_num = excluded.phase_num, is_stub = excluded.is_stub,
      body = excluded.body, file_path = excluded.file_path,
      mtime = excluded.mtime, updated_at = excluded.updated_at
  `);
  for (const t of snapshot.tasks) {
    upsertTask.run(
      repoId, t.task_id, t.title, t.state,
      t.phase_num, t.is_stub ? 1 : 0,
      t.body, t.file_path, t.mtime, now,
    );
  }

  // Audit entries — insert new ones only (append-only log).
  const insertAudit = db.prepare(`
    INSERT OR IGNORE INTO repo_audit_entries (repo_id, entry_date, emoji, text)
    VALUES (?, ?, ?, ?)
  `);
  for (const e of snapshot.audit_entries) {
    insertAudit.run(repoId, e.entry_date, e.emoji, e.text);
  }
}

export function listRepoPhases(repoId: number): RepoPhaseRow[] {
  return getAppDb()
    .prepare('SELECT * FROM repo_phases WHERE repo_id = ? ORDER BY phase_num ASC')
    .all(repoId) as RepoPhaseRow[];
}

export function listRepoTasks(repoId: number, opts: { state?: string } = {}): RepoTaskRow[] {
  const db = getAppDb();
  if (opts.state) {
    return db
      .prepare('SELECT * FROM repo_tasks WHERE repo_id = ? AND state = ? ORDER BY task_id ASC')
      .all(repoId, opts.state) as RepoTaskRow[];
  }
  return db
    .prepare('SELECT * FROM repo_tasks WHERE repo_id = ? ORDER BY state ASC, task_id ASC')
    .all(repoId) as RepoTaskRow[];
}

export function listAllActiveTasks(): Array<RepoTaskRow & { repo_name: string; company: string | null }> {
  return getAppDb().prepare(`
    SELECT rt.*, r.name as repo_name, r.company
    FROM repo_tasks rt
    JOIN repos r ON r.id = rt.repo_id
    WHERE rt.state = 'active' AND r.active = 1
    ORDER BY rt.mtime ASC
  `).all() as Array<RepoTaskRow & { repo_name: string; company: string | null }>;
}

export function searchRepoTasks(query: string, opts: { state?: string; repoId?: number } = {}): RepoTaskRow[] {
  const db = getAppDb();
  const like = `%${query}%`;
  let sql = `
    SELECT rt.*, r.name as repo_name, r.company
    FROM repo_tasks rt
    JOIN repos r ON r.id = rt.repo_id
    WHERE r.active = 1 AND (rt.title LIKE ? OR rt.task_id LIKE ? OR rt.body LIKE ?)
  `;
  const params: unknown[] = [like, like, like];
  if (opts.state) { sql += ' AND rt.state = ?'; params.push(opts.state); }
  if (opts.repoId) { sql += ' AND rt.repo_id = ?'; params.push(opts.repoId); }
  sql += ' ORDER BY rt.state ASC, rt.task_id ASC LIMIT 50';
  return db.prepare(sql).all(...params) as RepoTaskRow[];
}

export function listRepoAuditEntries(repoId: number, limit = 20): RepoAuditEntryRow[] {
  return getAppDb()
    .prepare('SELECT * FROM repo_audit_entries WHERE repo_id = ? ORDER BY entry_date DESC, id DESC LIMIT ?')
    .all(repoId, limit) as RepoAuditEntryRow[];
}
