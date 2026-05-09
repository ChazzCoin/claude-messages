import express from 'express';
import type { ErrorRequestHandler, Request, Response, NextFunction } from 'express';
import type { MessageRow } from './db/messages.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
import { config } from './config.js';
import {
  getChatDb,
  closeChatDb,
  listChats,
  listMessagesForChat,
  listRecentMessages,
  appleDateToUnixMs,
} from './db/messages.js';
import {
  getAppDb,
  closeAppDb,
  listDrafts,
  getDraft,
  updateDraftStatus,
  createDraft,
  stampDraftStaged,
  getSettings,
  updateSettings,
  getDeviceId,
  SETTING_BOUNDS,
  listNotesForHandle,
  addNoteForHandle,
  removeNote,
  getContactProfile,
  setContactProfile,
  // monitor rules + flags
  listMonitorRules,
  listEnabledMonitorRules,
  addMonitorRule,
  setMonitorRuleEnabled,
  removeMonitorRule,
  listFlags,
  insertFlag,
  markFlagReviewed,
  removeFlag,
  countUnreviewedFlags,
  // scheduled messages
  listScheduled,
  getScheduled,
  listDueScheduled,
  createScheduled,
  updateScheduledStatus,
  updateScheduled,
  // radar
  RADAR_CATEGORIES,
  listRadarContacts,
  listEnabledRadarHandles,
  getRadarContact,
  addRadarContact,
  setRadarEnabled,
  removeRadarContact,
  setRadarProfile,
  listRadarSignals,
  insertRadarSignals,
  radarSignalAlreadyProcessed,
  removeRadarSignal,
  countRadarSignalsByCategory,
  // calendar proposals
  listCalendarProposals,
  getCalendarProposal,
  calendarProposalAlreadyExists,
  insertCalendarProposal,
  updateCalendarProposalStatus,
  removeCalendarProposal,
  countPendingCalendarProposals,
  // away mode
  listAwayContacts,
  listEnabledAwayHandles,
  addAwayContact,
  setAwayContactEnabled,
  removeAwayContact,
  getActiveAwaySession,
  createAwaySession,
  bumpAwaySession,
  endAwaySession,
  endAllActiveAwaySessions,
  listAwaySessions,
  countActiveAwaySessions,
  // auto notes (24/7 inbound triage)
  listAutoNotes,
  insertAutoNote,
  autoNoteAlreadyExists,
  markAutoNoteReviewed,
  markAllAutoNotesReviewed,
  removeAutoNote,
  getAutoNote,
  countUnreviewedAutoNotes,
  // summon mode
  getActiveSummonSession,
  createSummonSession,
  bumpSummonSession,
  touchSummonSession,
  endSummonSession,
  endAllActiveSummonSessions,
  listSummonSessions,
  countActiveSummonSessions,
  activeSummonChatIds,
  type MonitorScopeType,
  type MonitorKind,
  type MonitorRule,
  type ScheduledStatus,
  type RadarCategory,
  type CalendarProposalStatus,
  type AwaySession,
  type SummonSession,
} from './db/app.js';
import { sendMessageViaAppleScript } from './send.js';
import { messageWatcher } from './watcher.js';
import { mirrorAutoNote, mirrorUpdateNote, mirrorDeleteNote } from './firebase.js';
import { pushStateSnapshot, pushStateSnapshotNow } from './firebase-state.js';
import { startCommandListener, stopCommandListener } from './firebase-commands.js';
import {
  listAllContacts,
  listContactsWithHandles,
  preloadContacts,
  reloadContacts,
  getContactNameForHandle,
  getContactByHandle,
  formatContactContext,
  normalizeHandle,
} from './db/contacts.js';
import {
  getUpcomingEvents,
  formatAvailabilityContext,
  clearCalendarCache,
  listCalendars,
  createEvent,
  updateEvent,
  deleteEvent,
} from './integrations/calendar.js';
import type { Draft } from './db/app.js';

type EnrichedDraft = Draft & { contact_name: string | null };

function enrichDraft(d: Draft | null): EnrichedDraft | null {
  if (!d) return null;
  return { ...d, contact_name: getContactNameForHandle(d.handle) };
}
import {
  isAIConfigured,
  apiKeySource,
  effectiveModel,
  classifyIncoming,
  draftReply,
  buildThreadFromMessages,
  summarizeThread,
  evaluateRuleAgainstMessage,
  extractRadarSignals,
  distillRadarProfile,
  extractCalendarEvent,
  extractAutoNote,
  type PromptOverrides,
  PROMPT_DEFAULTS,
  PIPELINE_STAGES,
  applyTemplate,
} from './ai.js';

/** Pull the prompt/wrapper override fields out of full settings so AI calls
 *  get a narrow PromptOverrides object instead of the whole AppSettings. */
function pickPromptOverrides(s: ReturnType<typeof getSettings>): PromptOverrides {
  return {
    prompt_draft_system: s.prompt_draft_system,
    prompt_away_guardrail: s.prompt_away_guardrail,
    wrapper_voice_profile: s.wrapper_voice_profile,
    wrapper_contact_profile: s.wrapper_contact_profile,
    wrapper_address_book: s.wrapper_address_book,
    wrapper_calendar: s.wrapper_calendar,
    wrapper_contact_notes: s.wrapper_contact_notes,
    wrapper_temperament: s.wrapper_temperament,
    wrapper_away_persona: s.wrapper_away_persona,
  };
}

const app = express();
app.use(express.json({ limit: '256kb' }));

/* ---------- helpers ---------- */

function intParam(v: unknown, fallback: number, min = 1, max = 1000): number {
  const n = typeof v === 'string' ? parseInt(v, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function asyncHandler<T extends Request, U extends Response>(
  fn: (req: T, res: U, next: NextFunction) => Promise<unknown>,
) {
  return (req: T, res: U, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

/**
 * Resolve the two prompt-context blocks pulled from macOS data sources for a
 * draft against `handle`. Both are best-effort: if Calendar.app's Automation
 * grant isn't in place yet, or AddressBook isn't readable, we return empty
 * strings so the draft path keeps working. Calendar fetches are 60s-cached
 * inside the integration, so calling this on every draft is fine.
 */
async function resolveDraftContext(handle: string): Promise<{
  addressBookContext: string;
  userAvailability: string;
}> {
  const ab = getContactByHandle(handle);
  const addressBookContext = formatContactContext(ab);
  let userAvailability = '';
  try {
    const events = await getUpcomingEvents({ hoursBack: 2, hoursAhead: 168 });
    userAvailability = formatAvailabilityContext(events);
  } catch (err) {
    console.warn(`[calendar] availability fetch failed: ${(err as Error).message}`);
  }
  return { addressBookContext, userAvailability };
}

/* ---------- routes: health ---------- */

app.get('/api/health', (_req, res) => {
  let chatDbOk = false;
  let chatDbError: string | null = null;
  try {
    const db = getChatDb();
    db.prepare('SELECT 1').get();
    chatDbOk = true;
  } catch (err) {
    chatDbError = (err as Error).message;
  }
  res.json({
    ok: true,
    server: 'galt',
    version: '0.1.0',
    chat_db: { path: config.chatDbPath, ok: chatDbOk, error: chatDbError },
    app_db: { path: config.appDbPath },
    openai_configured: isAIConfigured(),
    openai_model: effectiveModel(),
    openai_key_source: apiKeySource(),
    watcher_running: messageWatcher.isRunning(),
    away_mode_enabled: !!getSettings().away_mode_enabled,
    away_active_sessions: countActiveAwaySessions(),
    auto_unreviewed_notes: countUnreviewedAutoNotes(),
    summon_enabled: !!getSettings().summon_enabled,
    summon_active_sessions: countActiveSummonSessions(),
  });
});

/* ---------- routes: chats / messages (read-only chat.db) ---------- */

app.get('/api/chats', (req, res) => {
  const limit = intParam(req.query.limit, 100, 1, 500);
  res.json({ chats: listChats(limit) });
});

app.get('/api/chats/:id/messages', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid chat id' });
  const since = intParam(req.query.since, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = intParam(req.query.limit, 200, 1, 1000);
  return res.json({ messages: listMessagesForChat(id, since, limit) });
});

app.get('/api/messages/recent', (req, res) => {
  const since = intParam(req.query.since, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = intParam(req.query.limit, 100, 1, 500);
  res.json({ messages: listRecentMessages(since, limit) });
});

/* ---------- search across all messages ---------- */

app.get('/api/messages/search', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const limit = intParam(req.query.limit, 50, 1, 500);
  if (q.length < 2) return res.json({ q, results: [], hint: 'enter ≥ 2 chars' });

  const db = getChatDb();
  const rows = db
    .prepare(
      `
      SELECT
        m.ROWID           AS id,
        m.guid            AS guid,
        m.text            AS text,
        m.handle_id       AS handle_id,
        h.id              AS handle,
        m.date            AS date,
        m.is_from_me      AS is_from_me,
        m.service         AS service,
        cmj.chat_id       AS chat_id,
        c.display_name    AS chat_display_name,
        c.chat_identifier AS chat_identifier
      FROM message m
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN chat c ON c.ROWID = cmj.chat_id
      WHERE m.text LIKE ?
        AND (m.associated_message_type IS NULL OR m.associated_message_type = 0)
      ORDER BY m.date DESC
      LIMIT ?;
      `,
    )
    .all(`%${q.replace(/[%_]/g, (m) => '\\' + m)}%`, limit) as Array<{
    id: number;
    guid: string;
    text: string | null;
    handle_id: number | null;
    handle: string | null;
    date: number | bigint | null;
    is_from_me: number;
    service: string | null;
    chat_id: number | null;
    chat_display_name: string | null;
    chat_identifier: string | null;
  }>;

  const results = rows.map((r) => {
    const isFromMe = (r.is_from_me ? 1 : 0) as 0 | 1;
    return {
      id: r.id,
      guid: r.guid,
      text: r.text,
      handle: r.handle,
      contact_name: isFromMe ? null : getContactNameForHandle(r.handle),
      date_ms: appleDateToUnixMs(r.date),
      is_from_me: isFromMe,
      service: r.service,
      chat_id: r.chat_id,
      chat_display_name: r.chat_display_name,
      chat_identifier: r.chat_identifier,
      chat_contact_name: getContactNameForHandle(r.chat_identifier),
    };
  });

  res.json({ q, results });
});

/* ---------- attachments (streaming) ---------- */

app.get('/api/attachments/:rowid', (req, res) => {
  const rowid = parseInt(req.params.rowid, 10);
  if (!Number.isFinite(rowid)) return res.status(400).json({ error: 'invalid rowid' });
  try {
    const db = getChatDb();
    const row = db
      .prepare('SELECT filename, mime_type, transfer_name FROM attachment WHERE ROWID = ?')
      .get(rowid) as
      | { filename: string | null; mime_type: string | null; transfer_name: string | null }
      | undefined;
    if (!row || !row.filename) return res.status(404).json({ error: 'attachment not found' });
    let p = row.filename;
    if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'attachment file missing on disk' });
    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    if (row.transfer_name) {
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${row.transfer_name.replace(/"/g, '')}"`,
      );
    }
    fs.createReadStream(p).pipe(res);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ---------- routes: drafts (app.db + AppleScript send) ---------- */

app.get('/api/drafts', (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const valid = ['pending', 'sent', 'discarded', 'edited'] as const;
  const filter = (valid as readonly string[]).includes(status ?? '')
    ? (status as (typeof valid)[number])
    : undefined;
  res.json({ drafts: listDrafts(filter).map((d) => enrichDraft(d)!) });
});

app.post('/api/drafts', (req, res) => {
  const chatId = parseInt(req.body?.chat_id, 10);
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  let handle = normalizeHandle(req.body?.handle);
  if (!Number.isFinite(chatId) || !body) {
    return res.status(400).json({ error: 'chat_id and body required' });
  }
  if (!handle) {
    try {
      const db = getChatDb();
      const row = db.prepare('SELECT chat_identifier FROM chat WHERE ROWID = ?').get(chatId) as
        | { chat_identifier: string }
        | undefined;
      if (!row) return res.status(404).json({ error: `chat ${chatId} not found` });
      handle = row.chat_identifier;
    } catch (err) {
      return res.status(500).json({ error: `chat lookup failed: ${(err as Error).message}` });
    }
  }
  const sourceGuid =
    typeof req.body?.source_msg_guid === 'string' && req.body.source_msg_guid.length > 0
      ? req.body.source_msg_guid
      : `manual-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const reasoning =
    typeof req.body?.reasoning === 'string' && req.body.reasoning.length > 0
      ? req.body.reasoning
      : null;
  const draft = createDraft({ source_msg_guid: sourceGuid, chat_id: chatId, handle, body, reasoning });
  return res.status(201).json({ draft: enrichDraft(draft) });
});

app.post(
  '/api/drafts/:id/approve',
  asyncHandler(async (req, res) => {
    const idStr = req.params.id ?? '';
    const id = parseInt(idStr, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const draft = getDraft(id);
    if (!draft) return res.status(404).json({ error: 'not found' });
    if (draft.status !== 'pending')
      return res.status(409).json({ error: `cannot send draft in status ${draft.status}` });

    const body = typeof req.body?.body === 'string' ? req.body.body : draft.body;
    const edited = body !== draft.body;

    await sendMessageViaAppleScript(draft.handle, body);
    const updated = updateDraftStatus(id, 'sent', edited ? body : undefined);
    return res.json({ draft: enrichDraft(updated) });
  }),
);

app.post('/api/drafts/:id/discard', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const draft = getDraft(id);
  if (!draft) return res.status(404).json({ error: 'not found' });
  return res.json({ draft: enrichDraft(updateDraftStatus(id, 'discarded')) });
});

/**
 * Stage a draft into Messages.app's input field instead of sending it.
 * Uses the `sms:` URL scheme — opens the conversation with the recipient
 * and pre-fills the body. The user reviews and sends from Messages.app.
 */
app.post(
  '/api/drafts/:id/stage',
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id ?? '', 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const draft = getDraft(id);
    if (!draft) return res.status(404).json({ error: 'not found' });
    if (draft.status === 'sent' || draft.status === 'discarded') {
      return res.status(409).json({ error: `cannot stage draft in status ${draft.status}` });
    }

    const url = `sms:${draft.handle}&body=${encodeURIComponent(draft.body)}`;
    try {
      await execFileP('open', [url]);
    } catch (err) {
      return res.status(500).json({ error: `open failed: ${(err as Error).message}` });
    }

    return res.json({ draft: enrichDraft(stampDraftStaged(id)) });
  }),
);

/**
 * Direct send — for user-typed messages where no draft exists. Bypasses the
 * approval queue (the user typed it themselves and clicked Send; no second
 * confirmation needed). Records as a draft with status='sent' immediately so
 * it shows up in stats/history exactly like an approved AI draft.
 *
 * Body: { chat_id: number, body: string, handle?: string, reasoning?: string }
 * Returns: { draft }   (the sent record)
 */
app.post(
  '/api/send',
  asyncHandler(async (req, res) => {
    const chatId = parseInt(req.body?.chat_id, 10);
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!Number.isFinite(chatId) || !body) {
      return res.status(400).json({ error: 'chat_id and body required' });
    }
    let handle = normalizeHandle(req.body?.handle);
    if (!handle) {
      try {
        const db = getChatDb();
        const row = db.prepare('SELECT chat_identifier FROM chat WHERE ROWID = ?').get(chatId) as
          | { chat_identifier: string }
          | undefined;
        if (!row) return res.status(404).json({ error: `chat ${chatId} not found` });
        handle = row.chat_identifier;
      } catch (err) {
        return res.status(500).json({ error: `chat lookup failed: ${(err as Error).message}` });
      }
    }

    // AppleScript first — if it throws, no draft is created (no fake history).
    await sendMessageViaAppleScript(handle, body);

    const sourceGuid = `direct-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const reasoning =
      typeof req.body?.reasoning === 'string' && req.body.reasoning.length > 0
        ? req.body.reasoning
        : 'direct send (user-typed, no AI)';
    const draft = createDraft({ source_msg_guid: sourceGuid, chat_id: chatId, handle, body, reasoning });
    const sent = updateDraftStatus(draft.id, 'sent');
    return res.json({ draft: enrichDraft(sent) });
  }),
);

/* ---------- SSE: live message stream ---------- */

type SSEClient = Response;
const sseClients = new Set<SSEClient>();

function sseBroadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    try {
      c.write(payload);
    } catch {
      sseClients.delete(c);
    }
  }
}

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // CORS not relevant — same-origin localhost — but harmless to leave permissive.
  res.flushHeaders();
  res.write(`: connected\n\n`);
  sseClients.add(res);
  const ka = setInterval(() => {
    try {
      res.write(`: ka\n\n`);
    } catch {
      /* noop */
    }
  }, 25_000);
  req.on('close', () => {
    clearInterval(ka);
    sseClients.delete(res);
  });
});

messageWatcher.onMessages((messages: MessageRow[]) => {
  if (!messages.length) return;
  // listRecentMessages already filters tapbacks; just fan out the real rows.
  sseBroadcast('message.new', { messages, count: messages.length });
});

/* ---------- routes: contacts (macOS AddressBook → handle map) ---------- */

app.get('/api/contacts', (_req, res) => {
  res.json({ contacts: listContactsWithHandles() });
});

app.post('/api/contacts/reload', (_req, res) => {
  res.json({ ok: true, ...reloadContacts() });
});

// Look up a single contact's full AddressBook record by handle. Used by the
// dashboard to show what context (notes, role, birthday) gets injected into
// drafts for this person.
app.get('/api/contacts/lookup', (req, res) => {
  const handle = typeof req.query.handle === 'string' ? normalizeHandle(req.query.handle) : '';
  if (!handle) return res.status(400).json({ error: 'handle required' });
  const info = getContactByHandle(handle);
  if (!info) return res.json({ handle, contact: null, prompt_context: '' });
  return res.json({ handle, contact: info, prompt_context: formatContactContext(info) });
});

/* ---------- routes: calendar (macOS Calendar.app → upcoming events) ---------- */
// Reads everything Calendar.app aggregates: iCloud, every linked Google
// account, Exchange, CalDAV. Requires Automation → Calendar grant for the
// LaunchAgent's Node binary the first time. The fetch is 60s-cached to
// keep the AI draft hot path tolerable.

app.get(
  '/api/calendar/upcoming',
  asyncHandler(async (req, res) => {
    const hoursAhead = intParam(req.query.hours, 24, 1, 720);
    const hoursBack = intParam(req.query.hours_back, 0, 0, 168);
    try {
      const events = await getUpcomingEvents({ hoursAhead, hoursBack });
      return res.json({
        hours_ahead: hoursAhead,
        hours_back: hoursBack,
        count: events.length,
        events,
        prompt_context: formatAvailabilityContext(events),
      });
    } catch (err) {
      return res.status(503).json({
        error: 'calendar fetch failed',
        detail: (err as Error).message,
        hint: 'Grant Automation → Calendar to the LaunchAgent\'s Node binary in System Settings → Privacy & Security.',
      });
    }
  }),
);

app.post('/api/calendar/cache/clear', (_req, res) => {
  clearCalendarCache();
  res.json({ ok: true });
});

// List calendars Calendar.app knows about. Each entry tells you whether it's
// writable so the UI can disable read-only sources (e.g. holidays, birthdays)
// in the "create event" picker.
app.get(
  '/api/calendar/calendars',
  asyncHandler(async (_req, res) => {
    try {
      const calendars = await listCalendars();
      return res.json({ count: calendars.length, calendars });
    } catch (err) {
      return res.status(503).json({ error: 'list calendars failed', detail: (err as Error).message });
    }
  }),
);

// Create an event. Body: { title, start_iso, end_iso, location?, notes?,
// calendar?, all_day? }. When calendar is omitted, uses Calendar.app's
// default. Returns the new event's UID for follow-up updates/deletes.
app.post(
  '/api/calendar/events',
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const start = typeof body.start_iso === 'string' ? body.start_iso : '';
    const end = typeof body.end_iso === 'string' ? body.end_iso : '';
    if (!title || !start || !end) {
      return res.status(400).json({ error: 'title, start_iso, end_iso required' });
    }
    try {
      const result = await createEvent({
        title,
        start_iso: start,
        end_iso: end,
        location: typeof body.location === 'string' ? body.location : null,
        notes: typeof body.notes === 'string' ? body.notes : null,
        calendar: typeof body.calendar === 'string' ? body.calendar : null,
        all_day: !!body.all_day,
      });
      return res.status(201).json(result);
    } catch (err) {
      return res.status(500).json({ error: 'create failed', detail: (err as Error).message });
    }
  }),
);

// Update an event by UID. Body fields are all optional; only provided fields
// are changed. Recurring events: behavior follows Calendar.app's default
// (the series is modified). One-instance-only edits are not supported yet.
app.patch(
  '/api/calendar/events/:uid',
  asyncHandler(async (req, res) => {
    const uid = req.params.uid ?? '';
    if (!uid) return res.status(400).json({ error: 'uid required' });
    const body = req.body ?? {};
    const patch: Parameters<typeof updateEvent>[1] = {};
    if (typeof body.title === 'string') patch.title = body.title.trim();
    if (typeof body.start_iso === 'string') patch.start_iso = body.start_iso;
    if (typeof body.end_iso === 'string') patch.end_iso = body.end_iso;
    if ('location' in body) patch.location = body.location ?? null;
    if ('notes' in body) patch.notes = body.notes ?? null;
    if ('all_day' in body) patch.all_day = !!body.all_day;
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'no editable fields in body' });
    }
    try {
      const result = await updateEvent(uid, patch);
      return res.json(result);
    } catch (err) {
      const msg = (err as Error).message;
      const code = msg.includes('not found') ? 404 : 500;
      return res.status(code).json({ error: 'update failed', detail: msg });
    }
  }),
);

app.delete(
  '/api/calendar/events/:uid',
  asyncHandler(async (req, res) => {
    const uid = req.params.uid ?? '';
    if (!uid) return res.status(400).json({ error: 'uid required' });
    try {
      await deleteEvent(uid);
      return res.status(204).end();
    } catch (err) {
      const msg = (err as Error).message;
      const code = msg.includes('not found') ? 404 : 500;
      return res.status(code).json({ error: 'delete failed', detail: msg });
    }
  }),
);

/* ---------- routes: per-contact memory notes ---------- */
// Use ?handle=<encoded> in the query string so we don't have to escape
// + and @ characters in URL paths. Notes are 1:1 chat scoped — for
// groups, store on the chat_id directly (TODO).

app.get('/api/contacts/notes', (req, res) => {
  const handle = typeof req.query.handle === 'string' ? req.query.handle : '';
  if (!handle) return res.status(400).json({ error: 'handle required' });
  res.json({ handle, notes: listNotesForHandle(handle) });
});

app.post('/api/contacts/notes', (req, res) => {
  const handle = normalizeHandle(req.body?.handle);
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!handle || !body) return res.status(400).json({ error: 'handle and body required' });
  res.status(201).json({ note: addNoteForHandle(handle, body) });
});

app.delete('/api/contacts/notes/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const ok = removeNote(id);
  return ok ? res.status(204).end() : res.status(404).json({ error: 'not found' });
});

/* ---------- routes: per-contact profile (long-form prose) ---------- */
// One prose block per handle. Distinct from notes (short bullets) and radar
// profile (auto-distilled from signals). Injected into every AI reply.

app.get('/api/contacts/profile', (req, res) => {
  const handle = typeof req.query.handle === 'string' ? req.query.handle : '';
  if (!handle) return res.status(400).json({ error: 'handle required' });
  res.json(getContactProfile(handle));
});

app.put('/api/contacts/profile', (req, res) => {
  const handle = normalizeHandle(req.body?.handle);
  const profile = typeof req.body?.profile === 'string' ? req.body.profile : '';
  if (!handle) return res.status(400).json({ error: 'handle required' });
  res.json(setContactProfile(handle, profile));
});

/* ---------- routes: settings ---------- */

/**
 * Redact secrets before returning settings over the network. The raw OpenAI
 * key NEVER leaves the server — UI gets a boolean + last-4 for display.
 * Source tells the UI whether the active key comes from the DB (Settings UI)
 * or .env, so it can surface that context.
 */
function redactSettingsForResponse(s: ReturnType<typeof getSettings>) {
  const dbKey = s.openai_api_key?.trim() || '';
  const envKey = config.openai.apiKey || '';
  const effective = dbKey || envKey;
  // Strip the raw key from the response object.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { openai_api_key, ...rest } = s;
  return {
    ...rest,
    openai_api_key_set: !!effective,
    openai_api_key_last4: effective ? effective.slice(-4) : '',
    openai_api_key_source: apiKeySource(),
  };
}

app.get('/api/settings', (_req, res) => {
  res.json({
    settings: redactSettingsForResponse(getSettings()),
    bounds: SETTING_BOUNDS,
    // Built-in prompt/wrapper defaults — the actual text the AI layer
    // falls back to when the matching override setting is empty. Surfaced
    // here so the Galt page can render "what's currently running" without
    // duplicating the strings on the client. Values include the literal
    // {placeholders} the user can use in their overrides ({body},
    // {temperament}, {guidance}, etc.). prompt_away_system has no entry —
    // its default is generated by buildAwayContextNote() at call time
    // with substituted recipient/persona, so showing a static template
    // in the UI doesn't help; we return the unsubstituted default below.
    prompt_defaults: {
      ...PROMPT_DEFAULTS,
      // Static template version of the away prompt (with {recipientName}
      // placeholder left in). Renders the SAME sections buildAwayContextNote
      // builds, just without runtime substitution applied. Generated lazily
      // so the UI sees a stable string.
      prompt_away_system: buildAwayContextNote('{recipientName}'),
      prompt_summon_system: buildSummonContextNote({
        userName: '{userName}',
        recipientName: '{recipientName}',
        triggerFromUser: true,
        isActivation: true,
      }),
    },
    // Ordered list of every pipeline stage the AI layer runs. The Galt
    // page renders the visualization from this list — single source of
    // truth: what the user sees IS what runs at request time.
    pipeline_stages: PIPELINE_STAGES,
  });
});

app.put('/api/settings', (req, res) => {
  try {
    const before = getSettings();
    const settings = updateSettings(req.body ?? {});
    // Safety: flipping away_mode_enabled from on→off ends every active session
    // so the AI doesn't keep replying after the user is back.
    if (before.away_mode_enabled && !settings.away_mode_enabled) {
      const ended = endAllActiveAwaySessions('away_mode_disabled');
      if (ended > 0) {
        console.log(`[away] ended ${ended} session(s) due to away mode disabled`);
        sseBroadcast('away.mode_disabled', { ended_sessions: ended });
      }
    }
    // Same safety for summon: turning the master switch off ends every
    // active session (Galt was actively in conversations; user is taking back over).
    if (before.summon_enabled && !settings.summon_enabled) {
      const ended = endAllActiveSummonSessions('globally_disabled');
      if (ended > 0) {
        console.log(`[summon] ended ${ended} session(s) due to summon disabled globally`);
        sseBroadcast('summon.globally_disabled', { ended_sessions: ended });
      }
    }
    pushStateSnapshot();
    res.json({ settings: redactSettingsForResponse(settings), bounds: SETTING_BOUNDS });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/* ---------- routes: AI (classification + draft generation) ---------- */

function requireAI(_req: Request, res: Response): boolean {
  if (!isAIConfigured()) {
    res.status(503).json({
      error: 'AI features unavailable: no OpenAI API key configured. Add one in Settings → OpenAI, or set OPENAI_API_KEY in .env.',
    });
    return false;
  }
  return true;
}

app.post(
  '/api/ai/classify',
  asyncHandler(async (req, res) => {
    if (!requireAI(req, res)) return;
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'text required' });
    const classification = await classifyIncoming(text);
    return res.json({ classification });
  }),
);

// /api/ai/draft REMOVED — manual AI draft generation (the "3 AI options"
// flow that suggested replies for the user to edit before sending) was
// retired when Galt became the system-wide AI. Galt's only AI generation
// paths now are away mode and summon mode auto-replies. Drafts CRUD
// endpoints below stay for historical/scratch use; they're not fed by
// any AI flow anymore.

/**
 * POST /api/ai/summarize
 * Body: { chat_id, count?: 1..200 (default 30) }
 * Reads the last N messages of the chat, asks the model for a bullet-point digest.
 */
app.post(
  '/api/ai/summarize',
  asyncHandler(async (req, res) => {
    if (!requireAI(req, res)) return;
    const chatId = parseInt(req.body?.chat_id, 10);
    if (!Number.isFinite(chatId)) return res.status(400).json({ error: 'chat_id required' });
    const ccRaw = parseInt(req.body?.count, 10);
    const count = Number.isFinite(ccRaw) ? Math.max(1, Math.min(200, ccRaw)) : 30;

    const messagesDesc = listMessagesForChat(chatId, 0, count);
    if (messagesDesc.length === 0) {
      return res.status(400).json({ error: `chat ${chatId} has no messages` });
    }
    const thread = buildThreadFromMessages(messagesDesc);
    if (thread.length === 0) {
      return res
        .status(400)
        .json({ error: 'no decodable text in the recent window' });
    }

    const result = await summarizeThread({ thread });
    return res.json({
      summary: result.summary,
      turns: thread.length,
      model: result.model,
      usage: result.usage ?? null,
    });
  }),
);

// /api/ai/voice-profile/regenerate REMOVED — the user's voice profile
// concept was retired when Galt became the system-wide AI voice. The
// only voice profile that matters now is galt_voice_profile, which is
// user-written prose (no AI distillation needed). Old voice_profile
// data still on disk in app.db; see CLAUDE.md.

/* ---------- routes: monitor rules + flagged messages ---------- */

app.get('/api/monitor/rules', (_req, res) => {
  res.json({ rules: listMonitorRules() });
});

app.post('/api/monitor/rules', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const promptText = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  const kindRaw = typeof req.body?.kind === 'string' ? req.body.kind : 'flag';
  const validKinds: readonly string[] = ['flag', 'calendar'];
  if (!validKinds.includes(kindRaw)) {
    return res.status(400).json({ error: 'kind must be one of flag|calendar' });
  }
  const kind = kindRaw as MonitorKind;
  const scopeRaw = typeof req.body?.scope_type === 'string' ? req.body.scope_type : '';
  const validScopes: readonly string[] = ['contact', 'unknown', 'all'];
  if (!validScopes.includes(scopeRaw)) {
    return res.status(400).json({ error: 'scope_type must be one of contact|unknown|all' });
  }
  const scope_type = scopeRaw as MonitorScopeType;
  const scope_handle =
    scope_type === 'contact'
      ? normalizeHandle(req.body?.scope_handle) || null
      : null;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (kind === 'flag' && !promptText) {
    return res.status(400).json({ error: 'prompt required for flag-kind rules' });
  }
  if (scope_type === 'contact' && !scope_handle) {
    return res
      .status(400)
      .json({ error: 'scope_handle required when scope_type is "contact"' });
  }
  try {
    const rule = addMonitorRule({ name, kind, scope_type, scope_handle, prompt: promptText });
    return res.status(201).json({ rule });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
});

app.patch('/api/monitor/rules/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  if (typeof req.body?.enabled !== 'boolean')
    return res.status(400).json({ error: 'only `enabled: bool` supported here' });
  const ok = setMonitorRuleEnabled(id, req.body.enabled);
  return ok ? res.json({ ok: true }) : res.status(404).json({ error: 'not found' });
});

app.delete('/api/monitor/rules/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const ok = removeMonitorRule(id);
  return ok ? res.status(204).end() : res.status(404).json({ error: 'not found' });
});

app.get('/api/monitor/flags', (req, res) => {
  const reviewedRaw = req.query.reviewed;
  let reviewed: boolean | undefined;
  if (reviewedRaw === 'true') reviewed = true;
  else if (reviewedRaw === 'false') reviewed = false;
  const ruleIdRaw = parseInt(req.query.rule_id as string, 10);
  const rule_id = Number.isFinite(ruleIdRaw) ? ruleIdRaw : undefined;
  const limit = intParam(req.query.limit, 100, 1, 500);
  const flags = listFlags({ reviewed, rule_id, limit }).map((f) => ({
    ...f,
    contact_name: getContactNameForHandle(f.handle),
  }));
  res.json({ flags, unreviewed: countUnreviewedFlags() });
});

app.post('/api/monitor/flags/:id/review', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const flag = markFlagReviewed(id);
  if (!flag) return res.status(404).json({ error: 'not found' });
  res.json({ flag: { ...flag, contact_name: getContactNameForHandle(flag.handle) } });
});

app.delete('/api/monitor/flags/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const ok = removeFlag(id);
  return ok ? res.status(204).end() : res.status(404).json({ error: 'not found' });
});

/* ---------- routes: scheduled messages ---------- */

function enrichScheduled<T extends { handle: string }>(s: T): T & { contact_name: string | null } {
  return { ...s, contact_name: getContactNameForHandle(s.handle) };
}

app.get('/api/scheduled', (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const valid = ['pending', 'sent', 'failed', 'cancelled'] as const;
  const filter = (valid as readonly string[]).includes(status ?? '')
    ? (status as ScheduledStatus)
    : undefined;
  res.json({ scheduled: listScheduled(filter).map((s) => enrichScheduled(s)) });
});

app.post('/api/scheduled', (req, res) => {
  const handleRaw = normalizeHandle(req.body?.handle);
  const chatIdRaw = parseInt(req.body?.chat_id, 10);
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  const sendAt = parseInt(req.body?.send_at, 10);
  if (!body) return res.status(400).json({ error: 'body required' });
  if (!Number.isFinite(sendAt)) return res.status(400).json({ error: 'send_at (unix ms) required' });
  if (sendAt < Date.now() - 60_000) {
    return res.status(400).json({ error: 'send_at must be in the future' });
  }

  // Resolve handle: explicit > chat_id lookup
  let handle = handleRaw;
  if (!handle && Number.isFinite(chatIdRaw)) {
    try {
      const db = getChatDb();
      const row = db.prepare('SELECT chat_identifier FROM chat WHERE ROWID = ?').get(chatIdRaw) as
        | { chat_identifier: string }
        | undefined;
      if (!row) return res.status(404).json({ error: `chat ${chatIdRaw} not found` });
      handle = row.chat_identifier;
    } catch (err) {
      return res.status(500).json({ error: `chat lookup failed: ${(err as Error).message}` });
    }
  }
  if (!handle) return res.status(400).json({ error: 'handle or chat_id required' });

  const sched = createScheduled({ handle, body, send_at: sendAt });
  res.status(201).json({ scheduled: enrichScheduled(sched) });
});

app.patch('/api/scheduled/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const existing = getScheduled(id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (existing.status !== 'pending') {
    return res.status(409).json({ error: `cannot edit a ${existing.status} message` });
  }
  const patch: { send_at?: number; body?: string } = {};
  if (req.body?.send_at !== undefined) {
    const t = parseInt(req.body.send_at, 10);
    if (!Number.isFinite(t)) return res.status(400).json({ error: 'send_at must be unix ms' });
    patch.send_at = t;
  }
  if (req.body?.body !== undefined) {
    if (typeof req.body.body !== 'string' || !req.body.body.trim()) {
      return res.status(400).json({ error: 'body must be a non-empty string' });
    }
    patch.body = req.body.body.trim();
  }
  const updated = updateScheduled(id, patch);
  res.json({ scheduled: enrichScheduled(updated!) });
});

app.delete('/api/scheduled/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const existing = getScheduled(id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (existing.status === 'sent') {
    return res.status(409).json({ error: 'cannot cancel an already-sent message' });
  }
  const updated = updateScheduledStatus(id, 'cancelled');
  res.json({ scheduled: enrichScheduled(updated!) });
});

/** Schedule a draft for later send. Body: { send_at: unix_ms }. The draft
 *  itself is left as-is in the queue; a new scheduled_messages row is
 *  created referencing it (source_draft_id). */
app.post('/api/drafts/:id/schedule', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const draft = getDraft(id);
  if (!draft) return res.status(404).json({ error: 'not found' });
  if (draft.status !== 'pending') {
    return res.status(409).json({ error: `cannot schedule a draft in status ${draft.status}` });
  }
  const sendAt = parseInt(req.body?.send_at, 10);
  if (!Number.isFinite(sendAt)) return res.status(400).json({ error: 'send_at required' });
  if (sendAt < Date.now() - 60_000) {
    return res.status(400).json({ error: 'send_at must be in the future' });
  }
  const sched = createScheduled({
    handle: draft.handle,
    body: draft.body,
    send_at: sendAt,
    source_draft_id: draft.id,
  });
  res.status(201).json({ scheduled: enrichScheduled(sched), draft: enrichDraft(draft) });
});

/* ---------- routes: radar (per-contact memory bank) ---------- */

function enrichRadar<T extends { handle: string }>(c: T): T & { contact_name: string | null } {
  return { ...c, contact_name: getContactNameForHandle(c.handle) };
}

app.get('/api/radar/contacts', (_req, res) => {
  const contacts = listRadarContacts().map((c) => ({
    ...enrichRadar(c),
    signal_counts: countRadarSignalsByCategory(c.handle),
  }));
  res.json({ contacts });
});

app.post('/api/radar/contacts', (req, res) => {
  const handle = normalizeHandle(req.body?.handle);
  const label = typeof req.body?.label === 'string' ? req.body.label.trim() : null;
  if (!handle) return res.status(400).json({ error: 'handle required' });
  const resolvedLabel = label || getContactNameForHandle(handle);
  const c = addRadarContact(handle, resolvedLabel);
  res.status(201).json({ contact: enrichRadar(c) });
});

app.patch('/api/radar/contacts/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  if (typeof req.body?.enabled !== 'boolean')
    return res.status(400).json({ error: 'only `enabled: bool` supported here' });
  const ok = setRadarEnabled(id, req.body.enabled);
  return ok ? res.json({ ok: true }) : res.status(404).json({ error: 'not found' });
});

app.delete('/api/radar/contacts/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const ok = removeRadarContact(id);
  return ok ? res.status(204).end() : res.status(404).json({ error: 'not found' });
});

app.get('/api/radar/contacts/by-handle/:handle', (req, res) => {
  const handle = decodeURIComponent(req.params.handle ?? '');
  const contact = getRadarContact(handle);
  if (!contact) return res.status(404).json({ error: 'not on radar' });
  const signals = listRadarSignals(handle, 500);
  const counts = countRadarSignalsByCategory(handle);
  res.json({
    contact: enrichRadar(contact),
    signals,
    signal_counts: counts,
    categories: RADAR_CATEGORIES,
  });
});

app.delete('/api/radar/signals/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const ok = removeRadarSignal(id);
  return ok ? res.status(204).end() : res.status(404).json({ error: 'not found' });
});

app.put('/api/radar/contacts/by-handle/:handle/profile', (req, res) => {
  if (typeof req.body?.profile !== 'string') return res.status(400).json({ error: 'profile (string) required' });
  const handle = decodeURIComponent(req.params.handle ?? '');
  const updated = setRadarProfile(handle, req.body.profile);
  if (!updated) return res.status(404).json({ error: 'not on radar' });
  res.json({ contact: enrichRadar(updated) });
});

app.post(
  '/api/radar/contacts/by-handle/:handle/regenerate',
  asyncHandler(async (req, res) => {
    if (!requireAI(req, res)) return;
    const handle = decodeURIComponent(req.params.handle ?? '');
    const contact = getRadarContact(handle);
    if (!contact) return res.status(404).json({ error: 'not on radar' });

    const signals = listRadarSignals(handle, 500);
    if (signals.length === 0 && !contact.profile) {
      return res
        .status(400)
        .json({ error: 'no signals yet — profile cannot be generated until messages have been processed' });
    }

    // Group signals by category, recent first.
    const byCat: Record<string, Array<{ content: string; confidence: number; date_ms: number }>> = {};
    for (const s of signals) {
      (byCat[s.category] ||= []).push({
        content: s.content,
        confidence: s.confidence ?? 0.5,
        date_ms: s.extracted_at,
      });
    }
    // Cap each category at the most recent 30 to keep prompts bounded.
    for (const k of Object.keys(byCat)) byCat[k] = byCat[k]!.slice(0, 30);

    const userNotes = listNotesForHandle(handle).map((n) => n.body);
    const sender = contact.label || getContactNameForHandle(handle) || handle;

    const result = await distillRadarProfile({
      sender,
      existingProfile: contact.profile,
      signalsByCategory: byCat,
      userNotes,
    });

    const updated = setRadarProfile(handle, result.profile);
    res.json({
      contact: enrichRadar(updated!),
      model: result.model,
      usage: result.usage ?? null,
      signal_count: signals.length,
    });
  }),
);

/* ---------- routes: calendar proposals ---------- */

function enrichProposal<T extends { handle: string }>(p: T): T & { contact_name: string | null } {
  return { ...p, contact_name: getContactNameForHandle(p.handle) };
}

app.get('/api/calendar/proposals', (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const valid = ['pending', 'exported', 'dismissed'] as const;
  const filter = (valid as readonly string[]).includes(status ?? '')
    ? (status as CalendarProposalStatus)
    : undefined;
  const proposals = listCalendarProposals({ status: filter, limit: 200 }).map(enrichProposal);
  res.json({ proposals, pending: countPendingCalendarProposals() });
});

app.post('/api/calendar/proposals/:id/dismiss', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const updated = updateCalendarProposalStatus(id, 'dismissed');
  if (!updated) return res.status(404).json({ error: 'not found' });
  res.json({ proposal: enrichProposal(updated) });
});

app.delete('/api/calendar/proposals/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const ok = removeCalendarProposal(id);
  return ok ? res.status(204).end() : res.status(404).json({ error: 'not found' });
});

/** Export a calendar proposal to Calendar.app via .ics file → open. */
app.post(
  '/api/calendar/proposals/:id/export',
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id ?? '', 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const p = getCalendarProposal(id);
    if (!p) return res.status(404).json({ error: 'not found' });
    if (!p.start_ms) {
      return res
        .status(400)
        .json({ error: 'proposal has no start time — edit it first or dismiss' });
    }

    const startMs = p.start_ms;
    // Default end: +1 hour if not specified
    const endMs = p.end_ms ?? startMs + 60 * 60 * 1000;

    const ics = buildIcs({
      uid: `galt-${p.id}-${Date.now()}@local`,
      title: p.title,
      startMs,
      endMs,
      location: p.location,
      description: [p.notes, p.participants ? `Participants: ${p.participants}` : null]
        .filter(Boolean)
        .join('\n\n'),
    });

    const tmpPath = path.join(os.tmpdir(), `galt-event-${id}.ics`);
    fs.writeFileSync(tmpPath, ics, 'utf8');

    try {
      await execFileP('open', [tmpPath]);
    } catch (err) {
      return res.status(500).json({ error: `open failed: ${(err as Error).message}` });
    }

    const updated = updateCalendarProposalStatus(id, 'exported');
    res.json({ proposal: enrichProposal(updated!), ics_path: tmpPath });
  }),
);

function buildIcs(input: {
  uid: string;
  title: string;
  startMs: number;
  endMs: number;
  location: string | null;
  description: string;
}): string {
  const fmt = (ms: number): string => {
    const d = new Date(ms);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const HH = String(d.getUTCHours()).padStart(2, '0');
    const MM = String(d.getUTCMinutes()).padStart(2, '0');
    const SS = String(d.getUTCSeconds()).padStart(2, '0');
    return `${yyyy}${mm}${dd}T${HH}${MM}${SS}Z`;
  };
  const escape = (s: string) =>
    s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//galt//EN',
    'BEGIN:VEVENT',
    `UID:${input.uid}`,
    `DTSTAMP:${fmt(Date.now())}`,
    `DTSTART:${fmt(input.startMs)}`,
    `DTEND:${fmt(input.endMs)}`,
    `SUMMARY:${escape(input.title)}`,
  ];
  if (input.location) lines.push(`LOCATION:${escape(input.location)}`);
  if (input.description) lines.push(`DESCRIPTION:${escape(input.description)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

/* ---------- routes: away mode ---------- */

function enrichAway<T extends { handle: string }>(c: T): T & { contact_name: string | null } {
  return { ...c, contact_name: getContactNameForHandle(c.handle) };
}

/** Same shape as enrichAway — summon sessions also key by handle. */
function enrichSummon<T extends { handle: string }>(s: T): T & { contact_name: string | null } {
  return { ...s, contact_name: getContactNameForHandle(s.handle) };
}

app.get('/api/away/contacts', (_req, res) => {
  res.json({ contacts: listAwayContacts().map((c) => enrichAway(c)) });
});

app.post('/api/away/contacts', (req, res) => {
  const handle = normalizeHandle(req.body?.handle);
  const labelRaw = typeof req.body?.label === 'string' ? req.body.label.trim() : null;
  if (!handle) return res.status(400).json({ error: 'handle required' });
  const label = labelRaw || getContactNameForHandle(handle);
  const contact = addAwayContact(handle, label);
  pushStateSnapshot();
  res.status(201).json({ contact: enrichAway(contact) });
});

app.patch('/api/away/contacts/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  if (typeof req.body?.enabled !== 'boolean')
    return res.status(400).json({ error: 'only `enabled: bool` supported here' });
  const ok = setAwayContactEnabled(id, req.body.enabled);
  if (ok) pushStateSnapshot();
  return ok ? res.json({ ok: true }) : res.status(404).json({ error: 'not found' });
});

app.delete('/api/away/contacts/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const ok = removeAwayContact(id);
  if (ok) pushStateSnapshot();
  return ok ? res.status(204).end() : res.status(404).json({ error: 'not found' });
});

app.get('/api/away/sessions', (req, res) => {
  const activeOnly = req.query.active === 'true';
  const limit = intParam(req.query.limit, 100, 1, 500);
  res.json({
    sessions: listAwaySessions({ activeOnly, limit }).map((s) => enrichAway(s)),
    active_count: countActiveAwaySessions(),
  });
});

app.delete('/api/away/sessions/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const ended = endAwaySession(id, 'manually_ended');
  if (!ended) return res.status(404).json({ error: 'not found' });
  res.json({ session: enrichAway(ended) });
});

/* ---------- routes: auto notes (24/7 inbound triage queue) ---------- */

app.get('/api/auto-notes', (req, res) => {
  const reviewedRaw = req.query.reviewed;
  let reviewed: boolean | undefined;
  if (reviewedRaw === 'true') reviewed = true;
  else if (reviewedRaw === 'false') reviewed = false;
  const limit = intParam(req.query.limit, 200, 1, 500);
  const notes = listAutoNotes({ reviewed, limit }).map((n) => ({
    ...n,
    contact_name: getContactNameForHandle(n.handle),
  }));
  res.json({ notes, unreviewed: countUnreviewedAutoNotes() });
});

app.post('/api/auto-notes/:id/review', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const note = markAutoNoteReviewed(id);
  if (!note) return res.status(404).json({ error: 'not found' });
  void mirrorUpdateNote(note.message_guid, { reviewed_at: note.reviewed_at });
  pushStateSnapshot();
  res.json({ note: { ...note, contact_name: getContactNameForHandle(note.handle) } });
});

app.post('/api/auto-notes/review-all', (_req, res) => {
  // Snapshot the unreviewed list BEFORE the bulk update so we can mirror
  // each individually. SQLite is a single writer so reading-then-writing
  // here is correct under the existing single-process model.
  const unreviewed = listAutoNotes({ reviewed: false, limit: 500 });
  const n = markAllAutoNotesReviewed();
  const reviewedAt = Date.now();
  for (const note of unreviewed) {
    void mirrorUpdateNote(note.message_guid, { reviewed_at: reviewedAt });
  }
  pushStateSnapshot();
  res.json({ marked_reviewed: n });
});

app.delete('/api/auto-notes/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  // Look up the note BEFORE deleting so we have the message_guid for
  // the RTDB remove call.
  const before = getAutoNote(id);
  const ok = removeAutoNote(id);
  if (ok && before) {
    void mirrorDeleteNote(before.message_guid);
    pushStateSnapshot();
  }
  return ok ? res.status(204).end() : res.status(404).json({ error: 'not found' });
});

/**
 * Dry-run the note-extraction model against a hand-crafted message. Useful
 * for prompt iteration — does the extractor flag what we'd expect? Returns
 * the model's raw decision without writing to the DB.
 *
 * POST /api/auto-notes/test
 * Body: { sender: string, message: string }
 */
app.post(
  '/api/auto-notes/test',
  asyncHandler(async (req, res) => {
    if (!requireAI(req, res)) return;
    const sender = typeof req.body?.sender === 'string' ? req.body.sender : 'them';
    const messageText = typeof req.body?.message === 'string' ? req.body.message : '';
    if (!messageText) return res.status(400).json({ error: 'message required' });
    const result = await extractAutoNote({ sender, messageText });
    return res.json(result);
  }),
);

/* ---------- routes: summon sessions ---------- */

app.get('/api/summon/sessions', (req, res) => {
  const activeOnly = req.query.active === 'true';
  const limit = intParam(req.query.limit, 100, 1, 500);
  res.json({
    sessions: listSummonSessions({ activeOnly, limit }).map((s) => enrichSummon(s)),
    active_count: countActiveSummonSessions(),
  });
});

app.delete('/api/summon/sessions/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const ended = endSummonSession(id, 'manually_ended');
  if (!ended) return res.status(404).json({ error: 'not found' });
  sseBroadcast('summon.session_ended', {
    session: enrichSummon(ended),
    reason: 'manually_ended',
  });
  res.json({ session: enrichSummon(ended) });
});

/* ---------- watcher → away-mode auto-responder ---------- */

/**
 * In-memory ledger of message bodies WE just auto-sent (away mode + summon
 * mode), keyed by recipient handle. The AppleScript-driven send writes to
 * chat.db with is_from_me=1, then the watcher re-emits that row. Without
 * this ledger, the AI's own reply would either trip the "user replied →
 * end session" branch (away) or trigger a Galt-replies-to-Galt loop (summon).
 * 60s TTL is generous — Messages.app usually echoes within ~1s.
 */
const recentOurAutoSends = new Map<string, Set<string>>();
const AUTO_ECHO_TTL_MS = 60_000;

/**
 * In-memory lock for summon-mode drafts in flight, keyed by chat_id.
 * The watcher batches messages and the for-loop in onMessages emits
 * them sequentially within microseconds. Without this lock, two
 * back-to-back inbounds in the same chat would each kick off a
 * draftReply concurrently and produce two redundant Galt replies.
 * The first draft already sees the latest thread state when it queries
 * (it includes both messages), so dropping the second trigger is correct.
 */
const draftingForChat = new Set<number>();


/**
 * Humanizing delay before each away-mode auto-send. Without this, replies
 * arrive instantly — uncanny-valley territory. The delay scales with reply
 * length (longer "typing"), with random jitter so it's not robotically
 * uniform, and is clamped so very long replies don't take forever.
 *
 * Profile (50 wpm-ish):
 *   30 chars  ≈  2.0–3.5s
 *   100 chars ≈  3.5–6.5s
 *   200 chars ≈  5.5–10s
 *   500+ chars capped at 15s
 */
function naturalSendDelayMs(body: string): number {
  const charsPerSec = 33; // ~50 wpm
  const baseMs = 2000;
  const total = baseMs + (body.length / charsPerSec) * 1000;
  const jittered = total * (0.75 + Math.random() * 0.5); // ±25%
  return Math.max(1500, Math.min(15000, Math.round(jittered)));
}

/**
 * Tighter delay profile for summon mode. Galt is a friend hopping into
 * a conversation, not the user covering for themselves — should feel
 * snappy, not deliberative.
 *
 * Profile (~135 wpm):
 *   30 chars  ≈  0.35–0.55s
 *   100 chars ≈  0.9–1.4s
 *   200 chars ≈  1.7–2.5s
 *   250+ chars capped at 2.5s
 */
function summonSendDelayMs(body: string): number {
  const charsPerSec = 100;
  const baseMs = 150;
  const total = baseMs + (body.length / charsPerSec) * 1000;
  const jittered = total * (0.8 + Math.random() * 0.4); // ±20%
  return Math.max(150, Math.min(2500, Math.round(jittered)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * SYSTEM-WIDE RULE: every AI-generated message that goes out (or gets staged
 * as a draft for the user to approve) is prefixed with "Galt: " so the
 * recipient — and the user reviewing the drafts queue — can always tell
 * at a glance which messages are AI vs human-typed. The user's own typed
 * messages (Direct Send compose, manual + new draft) are NEVER prefixed.
 *
 * Applied at every AI-generation chokepoint:
 *   - away mode: greeting + continuation sends
 *   - summon mode: every reply
 */
export const GALT_PREFIX = 'Galt: ';

/**
 * Idempotent prefix application — strips any combination of leading
 * "me:" / "them:" / "Galt:" speaker labels that the model occasionally
 * leaks from the thread context, then prepends the canonical "Galt: ".
 * Safe to call multiple times on the same body without doubling.
 */
export function withGaltPrefix(body: string): string {
  let stripped = body;
  // Repeatedly strip recognized leading speaker labels — handles both
  // single leaks ("me: hello") and stacked leaks ("Galt: me: hello").
  for (let i = 0; i < 4; i++) {
    const next = stripped.replace(/^\s*(galt|me|them)\s*:\s*/i, '');
    if (next === stripped) break;
    stripped = next;
  }
  return `${GALT_PREFIX}${stripped}`;
}

function trackOurAutoSend(handle: string, body: string): void {
  let set = recentOurAutoSends.get(handle);
  if (!set) {
    set = new Set();
    recentOurAutoSends.set(handle, set);
  }
  set.add(body);
  setTimeout(() => {
    recentOurAutoSends.get(handle)?.delete(body);
  }, AUTO_ECHO_TTL_MS).unref();
}

function isOurAutoSendEcho(handle: string, body: string | null | undefined): boolean {
  if (!body) return false;
  const set = recentOurAutoSends.get(handle);
  // Membership-only — don't delete. The same body can echo multiple times
  // (e.g. messaging yourself: outgoing + incoming for the same text).
  // The TTL set in trackOurAutoSend cleans the entry eventually.
  return !!set && set.has(body);
}

/**
 * Shared AI-auto-send pipeline used by every code path that sends an
 * AI-generated message on the user's behalf (away greeting, away
 * continuation, summon reply). Encapsulates the four steps that have
 * to happen in this exact order:
 *
 *   1. apply the system-wide `Galt: ` prefix (idempotent + speaker-label-strip)
 *   2. optional humanizing delay (away or summon profile)
 *   3. re-check the abort condition AFTER the delay — caller-supplied,
 *      because what counts as "should we still send" is mode-specific
 *      (away: session not user-replied + mode still on; summon: session
 *      still active + master switch still on)
 *   4. mark the body in the echo guard, then AppleScript-send
 *
 * Returns whether the send actually went out so the caller can decide
 * whether to bump the session, broadcast SSE, etc. — those bits stay
 * with the caller because their payloads are mode-specific.
 */
async function aiAutoSend(opts: {
  handle: string;
  body: string;
  delayProfile: 'away' | 'summon' | 'off';
  abortIf?: () => boolean;
  logTag?: string;
}): Promise<{ sent: boolean; aborted: boolean; prefixedBody: string }> {
  const prefixedBody = withGaltPrefix(opts.body);
  const tag = opts.logTag ?? '[ai-send]';

  if (opts.delayProfile !== 'off') {
    const delayMs = opts.delayProfile === 'summon'
      ? summonSendDelayMs(prefixedBody)
      : naturalSendDelayMs(prefixedBody);
    console.log(`${tag} delayed ${delayMs}ms`);
    await sleep(delayMs);
  }

  if (opts.abortIf && opts.abortIf()) {
    console.log(`${tag} aborted (state changed during delay)`);
    return { sent: false, aborted: true, prefixedBody };
  }

  trackOurAutoSend(opts.handle, prefixedBody); // mark BEFORE send so the watcher echo doesn't trip the wrong handler
  await sendMessageViaAppleScript(opts.handle, prefixedBody);
  return { sent: true, aborted: false, prefixedBody };
}

/**
 * Per-turn instruction for away-mode replies. The persona used to be folded
 * into this string; it's now its own pipeline stage (wrapper_away_persona
 * in ai.ts), so this function no longer takes a persona arg. Single source
 * of truth for the away contextNote default — kept here (not in ai.ts)
 * because it composes recipientName at call time.
 */
function buildAwayContextNote(recipientName: string): string {
  const sections: string[] = [];

  sections.push(
    `You are GALT, the user's AI assistant. The user is currently away. You are covering for them in this iMessage conversation — handling routine back-and-forth so the user can catch up later. The recipient (${recipientName}) was told earlier in this thread that they're chatting with Chazz's AI; the runtime prefixes every message you send with "Galt: " so identity stays explicit. You speak as Galt, in Galt's voice (see voice profile above) — NOT as the user.`,
  );

  sections.push(
    `You are responding to: ${recipientName}. Use their name naturally when it actually fits — but don't shoehorn it. A casual reply usually has no name in it; reserve it for moments where calling someone by name adds warmth or clarity.`,
  );

  sections.push(
    "Behave like a friend's AI who's covering, not like customer service. Keep the conversation natural, varied, and alive. The recipient knows you're the AI — they don't need you to act human, but you also shouldn't make a thing of it every turn.",
  );

  sections.push(
    'Read your OWN previous replies in the thread (the "me: Galt: ..." lines) and DO NOT repeat their phrasings, openings, or hedges. Vary turn-to-turn — different opener, different rhythm, different vocabulary. If your last reply started with "yeah", don\'t start with "yeah" again. If you already used a deflection phrase once, find a different way to say it.',
  );

  sections.push(
    "Match the energy of the most recent incoming message: if they're playful, be playful; if they're terse, be terse; if they ask a real question and the thread already gives you the answer, just answer.",
  );

  sections.push(
    'When you genuinely cannot know something (specific times/places/money/promises the user has not confirmed in the thread, personal details about the user\'s day, anything only the real user can decide): defer back to the user. Examples — "no idea, I\'ll have him reach out about that" / "let me flag this so he can confirm when he\'s back" / "above my pay grade — he\'ll have to weigh in". Vary your phrasing; don\'t default to the same deflection every time.',
  );

  sections.push(
    "What you should NOT do: pretend you ARE the user; use customer-service phrasings (\"apologies for the inconvenience\", \"thank you for reaching out\", \"how can I help\"); make up commitments; sound robotic.",
  );

  sections.push('Output only the reply text. No "Galt: " prefix (the runtime adds it). No quotes, no preamble, no explanation.');

  return sections.join('\n\n');
}

/**
 * Builds the system-prompt section for SUMMON mode.
 *
 * Galt is a third voice in an ongoing conversation, not a help desk.
 * The most common failure mode for summoned LLMs is defaulting to
 * "I'm here, what can I do for you?" customer-service framing — this
 * prompt is built to actively prevent that.
 */
function buildSummonContextNote(opts: {
  userName: string;
  recipientName: string;
  triggerFromUser: boolean;
  /** True when the latest message contains the trigger phrase — the user is
   *  explicitly invoking Galt this turn. Forces a reply (SKIP forbidden). */
  isActivation: boolean;
}): string {
  const sections: string[] = [];
  const lastSpeaker = opts.triggerFromUser ? opts.userName : opts.recipientName;

  sections.push(
    `IDENTITY: You are GALT, ${opts.userName}'s AI assistant, who they summoned into this iMessage conversation. You are NOT pretending to be ${opts.userName} — you're a third voice they pulled in. Speak in your own voice (see voice profile above). NEVER claim to BE ${opts.userName}. The runtime auto-adds a "Galt: " prefix to your sent messages so identity is unambiguous — you don't need to introduce yourself.`,
  );

  sections.push(
    `YOU ARE JOINING A CONVERSATION ALREADY IN PROGRESS. Read the thread above carefully. Understand what's being discussed RIGHT NOW, the tone, where things are at. When you reply, just pick up the thread — like a friend who walked into the room and caught the last few minutes. Drop a relevant comment, add a thought, weigh in on the topic, match the energy. You are NOT being summoned to take orders. You are NOT a help desk. You are NOT customer service. You are a participant.`,
  );

  sections.push(
    `**CRITICAL — NEVER ASK ANY OF THESE PHRASES:**\n- "What's up?"\n- "What can I help with?"\n- "How can I help?"\n- "What do you need?"\n- "What should I do?"\n- "Tell me more"\n- "What are you thinking?"\n- "What can I do for you?"\n- "What do you guys want to talk about?"\n- "How can I assist?"\n- Any other variation of soliciting requests or asking what someone wants from you.\n\nThese are robot phrases. They make you sound like a chatbot. Friends who hop into a conversation don't say them — they just join the conversation that's happening.`,
  );

  sections.push(
    `WHO IS WHO IN THE THREAD ABOVE:\n- "them: ..." lines = ${opts.recipientName} (the contact in this chat)\n- "me: ..." lines (without "Galt:" prefix) = ${opts.userName} (the user who summoned you, typing as themselves)\n- "me: Galt: ..." lines = YOUR previous replies (the runtime added the "Galt:" prefix when sending)\n\nUse this to tell who said what. When ${opts.userName} types something, it's them as themselves. When you replied earlier, your turns are the "Galt:"-prefixed lines.`,
  );

  sections.push(
    `THE LATEST TURN — the message that triggered THIS draft — is from **${lastSpeaker}** (${opts.triggerFromUser ? 'the user' : 'the contact'}). Read what it ACTUALLY is and respond accordingly:\n${opts.triggerFromUser
      ? `- QUESTION OR DIRECTIVE from ${opts.userName} ("what is X?", "explain Y", "help me with Z", "look up A", "do B", "should I C?"): ANSWER OR DO IT directly. No preamble, no "great question" — just the answer or the requested action. The trigger phrase is NOT required for this — ANY question or directive ${opts.userName} types mid-session is for you. This is the most common case and the easiest to get wrong by treating it as casual chatter.\n- BARE SUMMON from ${opts.userName} ("GALT!!" alone, or naming you with no specific topic): one short on-topic line picking up wherever the thread is. Don't ask what they want.\n- CONVERSATION between ${opts.userName} and ${opts.recipientName} that doesn't need you (${opts.userName} is talking to the contact, not to you): stay light or stay out — a comment from you would just be noise.`
      : `- ${opts.recipientName} just said something. If their message invites a response from you (a question you can answer, an opinion to weigh in on, a factual claim worth correcting), respond directly. If they're addressing ${opts.userName} and there's nothing useful for you to add, SKIP. Don't elbow into a conversation that doesn't need you.`}`,
  );

  sections.push(
    `READ YOUR OWN PRIOR REPLIES (the "me: Galt: ..." lines). Two rules:\n- DO NOT repeat PHRASINGS, openings, or asks across turns. Different word, different angle. If your last reply opened with "yeah" or "haha", don't open with that again.\n- DO NOT restate the same SUBSTANCE in different words. If you've already covered a topic in a prior reply, MOVE FORWARD — add new info, escalate, ask a sharper follow-up, or stay quiet. Restating yourself with rephrased language is a failure mode the recipient WILL notice. If ${opts.userName} just re-asked or pushed back after your prior reply, that means you MISSED their actual ask the first time — re-read their original message and answer THAT directly, don't repeat what you said before in different words.`,
  );

  if (opts.isActivation) {
    sections.push(
      `MUST REPLY THIS TURN — ${opts.userName} explicitly invoked you (the trigger phrase is in the latest message). Returning SKIP is NOT allowed on this turn. If the latest message names a SPECIFIC ask, answer that. If it's a bare summon with no clear topic, drop one short on-topic line picking up wherever the thread left off — like a friend who walked into the room and caught the last few minutes. The "CRITICAL — NEVER ASK" list above already prevents help-desk phrasings; you don't need SKIP to avoid them. Produce a real, non-empty reply.`,
    );
  } else {
    sections.push(
      `WHEN TO SKIP (return SKIP literally) — only these two cases:\n- The latest turn is emoji-only / one-word ("lol", "k", "haha", "ok")\n- ${opts.userName} and ${opts.recipientName} are clearly sorting out a private logistic between just the two of them (scheduling, finalizing a transaction, an ongoing back-and-forth that's plainly not addressed to you)\n\nThat's the entire list. If you have any real take, observation, joke, or fact to contribute — REPLY, even if it's short. The "CRITICAL — NEVER ASK" list above already prevents help-desk phrasing; do NOT fall back to SKIP just to avoid sounding generic.`,
    );
  }

  sections.push(
    `WHEN TO REPLY: real questions you can answer, factual claims worth a take, decisions to weigh in on, jokes that fit, things to explain, or just a relevant comment that fits the existing conversation. ALWAYS in iMessage register — concise, often a single line. Not essay-length, not multiple paragraphs.`,
  );

  sections.push(
    `WHEN YOU GENUINELY DON'T KNOW something only ${opts.userName} can decide (their schedule, finances, commitments, personal feelings): defer briefly — "no idea, ask ${opts.userName}" / "above my pay grade" — and stop. Don't invent. Don't ramble. Don't ask follow-ups to fish for context — the context is the thread above; if it's not there, you don't know.`,
  );

  // Galt's voice profile (galt_voice_profile setting) flows through
  // draftReply's voiceProfile parameter — injected into the data-injection
  // block as "VOICE PROFILE." No need to also append it here.

  sections.push(
    opts.isActivation
      ? `OUTPUT FORMAT: just the reply text. No "Galt: " prefix (the runtime adds it). No quotes, no preamble, no explanation. SKIP is forbidden on this turn — produce real reply text.`
      : `OUTPUT FORMAT: just the reply text. No "Galt: " prefix (the runtime adds it). No quotes, no preamble, no explanation. Return SKIP literally only when one of the two SKIP cases above clearly applies.`,
  );

  return sections.join('\n\n');
}

/**
 * Fire-and-forget AI extraction. Runs 24/7 on every inbound message (mode-
 * agnostic): asks the model whether the message contains something the user
 * should personally follow up on (meet request, time-sensitive coordination,
 * decision request, etc.) and persists any matches into auto_notes.
 * Idempotent on message_guid. session_id is non-null only when an away
 * session is active for this handle — used purely for downstream linkage,
 * doesn't affect extraction behavior.
 */
async function extractAutoNoteForMessage(sessionId: number | null, msg: MessageRow): Promise<void> {
  if (!msg.text || !msg.handle || !msg.guid) {
    console.log(`[autonote] skipped (missing text/handle/guid) msg=${msg.guid ?? '?'}`);
    return;
  }
  const settings = getSettings();
  if (!settings.auto_notes_enabled) {
    console.log('[autonote] skipped (auto_notes_enabled=0)');
    return;
  }
  if (!isAIConfigured()) {
    console.log('[autonote] skipped (no openai key)');
    return;
  }
  if (autoNoteAlreadyExists(msg.guid)) {
    console.log(`[autonote] skipped (already exists) guid=${msg.guid}`);
    return;
  }
  // Per-contact opt-out. JSON shape is enforced at write-time in
  // updateSettings, so a parse failure here is unexpected — fall back to
  // empty list rather than crashing the watcher path.
  let excluded: string[] = [];
  try {
    const parsed = JSON.parse(settings.auto_notes_excluded_handles);
    if (Array.isArray(parsed)) excluded = parsed.filter((h) => typeof h === 'string');
  } catch {
    /* fall through with empty list */
  }
  if (excluded.includes(msg.handle)) {
    console.log(`[autonote] skipped (handle excluded) handle=${msg.handle}`);
    return;
  }

  try {
    const sender = msg.contact_name || msg.handle || 'them';
    const result = await extractAutoNote({ sender, messageText: msg.text });
    console.log(
      `[autonote] decision shouldNote=${result.shouldNote} category=${result.category} ` +
      `summary=${JSON.stringify((result.summary || '').slice(0, 80))} ` +
      `from=${sender} text=${JSON.stringify(msg.text.slice(0, 80))}`,
    );
    if (!result.shouldNote || !result.summary) return;

    const note = insertAutoNote({
      session_id: sessionId,
      handle: msg.handle,
      message_guid: msg.guid,
      message_rowid: msg.id,
      message_text: msg.text,
      summary: result.summary,
      category: result.category,
      reasoning: result.reasoning,
    });
    if (!note) return; // duplicate (race)

    const contactName = getContactNameForHandle(msg.handle);
    sseBroadcast('autonote.created', {
      note: { ...note, contact_name: contactName },
    });

    void mirrorAutoNote({ note, contactName, deviceId: getDeviceId() });
  } catch (err) {
    console.error('[autonote] extraction failed:', (err as Error).message);
  }
}

/**
 * Run note-triage on every inbound message regardless of mode. The model
 * itself self-gates (returns should_note=false on banter / pleasantries /
 * trivia), so we don't need an external classifier in front of it.
 *
 * Skip when an active away session exists for this handle — the away path
 * (handleAwayModeMessage) already calls extractAutoNoteForMessage with the
 * session_id, which is preferable to the null-session path here. The dedup
 * check inside extractAutoNoteForMessage means racing both paths is safe;
 * this guard just prefers the session-aware insert when one is available.
 */
async function triageInboundMessage(msg: MessageRow): Promise<void> {
  if (msg.is_from_me === 1) return;
  if (!msg.text || msg.text.trim().length === 0) return;
  if (!msg.handle) return;
  if (getActiveAwaySession(msg.handle)) return;
  await extractAutoNoteForMessage(null, msg);
}

async function handleAwayModeMessage(msg: MessageRow): Promise<void> {
  const settings = getSettings();
  if (!settings.away_mode_enabled) return;
  if (!msg.handle) return;

  // ECHO GUARD — applies to both directions. iMessage round-trips our auto-send
  // through chat.db: 1× outgoing (is_from_me=1) and, when the recipient is
  // your own handle, 1× incoming (is_from_me=0) too. Either direction matching
  // a body we just sent is our own echo and must be ignored — otherwise the
  // incoming copy retriggers the AI continuation and we loop.
  if (isOurAutoSendEcho(msg.handle, msg.text)) {
    return;
  }

  // OUTBOUND user-typed reply (echo already ruled out) → end the session.
  if (msg.is_from_me === 1) {
    const session = getActiveAwaySession(msg.handle);
    if (session) {
      const ended = endAwaySession(session.id, 'user_replied');
      if (ended) {
        console.log(`[away] session ${session.id} ended (user replied to ${msg.handle})`);
        sseBroadcast('away.session_ended', {
          session: enrichAway(ended),
          reason: 'user_replied',
        });
      }
    }
    return;
  }

  // INBOUND: only handle opted-in contacts.
  const allowed = listEnabledAwayHandles();
  if (!allowed.has(msg.handle)) return;
  if (!msg.text || msg.text.trim().length === 0) return;

  const session = getActiveAwaySession(msg.handle);

  // FIRST contact in this away period → send the canned greeting.
  if (!session) {
    // Run the user's greeting through the universal placeholder substitutor
    // so {recipientName} / {userName} expand. Most greetings have no
    // placeholders and pass through unchanged. (This is the ONLY pre-AI
    // step in away mode — the greeting is sent as a literal text on first
    // contact; subsequent replies go through the full AI pipeline below.)
    const recipientName = msg.contact_name || msg.handle || 'them';
    const greetingTemplate = (settings.away_message || '').trim();
    const greeting = applyTemplate(greetingTemplate, { recipientName, userName: 'the user' });
    if (!greeting) {
      console.warn('[away] enabled but away_message is empty — skipping greeting');
      return;
    }
    try {
      // Abort if a session was created for this handle in the meantime
      // (parallel inbound) or away mode was toggled off during the delay.
      const handle = msg.handle; // capture for closure (TS narrowing is lost in arrow fn)
      const result = await aiAutoSend({
        handle,
        body: greeting,
        delayProfile: settings.away_send_delay_enabled ? 'away' : 'off',
        abortIf: () => !!getActiveAwaySession(handle) || !getSettings().away_mode_enabled,
        logTag: `[away] greeting to ${handle}`,
      });
      if (!result.sent) return;

      const newSession = createAwaySession(msg.handle);
      console.log(`[away] greeting sent to ${msg.handle}, session ${newSession.id} opened`);
      sseBroadcast('away.greeting_sent', {
        session: enrichAway(newSession),
        message: result.prefixedBody,
      });
      // Even the FIRST message can carry a follow-up item — extract.
      void extractAutoNoteForMessage(newSession.id, msg);
    } catch (err) {
      console.error('[away] greeting send failed:', (err as Error).message);
    }
    return;
  }

  if (session.status === 'ended') return;

  // Reply cap reached → close out gracefully (no further auto-replies).
  if (session.ai_reply_count >= settings.away_max_replies_per_session) {
    endAwaySession(session.id, 'reply_cap_reached');
    sseBroadcast('away.session_ended', {
      session: enrichAway({ ...session, status: 'ended' }),
      reason: 'reply_cap_reached',
    });
    return;
  }

  if (!isAIConfigured()) {
    console.warn('[away] cannot continue conversation: OPENAI_API_KEY not configured');
    return;
  }

  // Continue the conversation: full thread context, voice profile, contact notes.
  try {
    const messagesDesc = listMessagesForChat(msg.chat_id ?? 0, 0, settings.ai_context_count);
    const thread = buildThreadFromMessages(messagesDesc);
    if (thread.length === 0) return;

    const contactNotes = listNotesForHandle(msg.handle).map((n) => n.body);
    const contactProfile = getContactProfile(msg.handle).profile;
    const recipientName = msg.contact_name || msg.handle || 'them';
    const { addressBookContext, userAvailability } = await resolveDraftContext(msg.handle);
    // User-provided override (Galt → Prompts → Away mode → "Custom prompt")
    // wins when non-empty. Pass the RAW template — draftReply substitutes
    // every {placeholder} ({recipientName}, {persona}, {messages}, etc.)
    // in one place using the universal context.
    const awayPromptOverride = settings.prompt_away_system.trim();
    const awayContextNote = awayPromptOverride
      || buildAwayContextNote(recipientName);

    const result = await draftReply({
      thread,
      // Galt is the system-wide AI voice. Pass galt_voice_profile here
      // — the recipient already sees "Galt:" on every reply, so the AI
      // should speak in Galt's voice rather than mimicking the user.
      // (Used to be settings.voice_profile; that's deprecated.)
      voiceProfile: settings.galt_voice_profile,
      contactNotes,
      contactProfile,
      addressBookContext,
      userAvailability,
      contextNote: awayContextNote,
      temperament: 'normal',
      count: 1,
      awayMode: true,
      promptOverrides: pickPromptOverrides(settings),
      templateVars: {
        recipientName,
        persona: settings.away_persona || '',
      },
    });
    const usable = result.variants.find((v) => !v.skipped && v.body.trim().length > 0);
    if (!usable) {
      console.log('[away] model returned SKIP for continuation — staying silent');
      return;
    }

    // Abort if user replied themselves during delay (session ends), or away
    // mode was toggled off, or session ended for any reason.
    const handle = msg.handle; // capture for closure (TS narrowing is lost in arrow fn)
    const sessionId = session.id;
    const send = await aiAutoSend({
      handle,
      body: usable.body,
      delayProfile: settings.away_send_delay_enabled ? 'away' : 'off',
      abortIf: () => {
        const current = getActiveAwaySession(handle);
        return !current
          || current.id !== sessionId
          || current.status === 'ended'
          || !getSettings().away_mode_enabled;
      },
      logTag: `[away] continuation to ${handle} (session ${sessionId})`,
    });
    if (!send.sent) return;

    const updated = bumpAwaySession(session.id);
    console.log(
      `[away] auto-replied to ${msg.handle} (session ${session.id}, reply ${updated?.ai_reply_count ?? '?'})`,
    );
    sseBroadcast('away.replied', {
      session: updated ? enrichAway(updated) : null,
      body: send.prefixedBody,
      thread_turns: thread.length,
      usage: result.usage ?? null,
    });
    // After replying, ask the model whether this inbound carried a follow-up
    // item the user should see when they're back.
    void extractAutoNoteForMessage(session.id, msg);
  } catch (err) {
    console.error('[away] continuation failed:', (err as Error).message);
  }
}

/* ---------- watcher → summon-mode handler ---------- */

/** Lazy idle-timeout sweep on each handler call. Ends sessions whose
 *  last_activity_at is older than summon_idle_timeout_min. */
function expireIdleSummonSessions(timeoutMin: number): void {
  const cutoff = Date.now() - timeoutMin * 60_000;
  for (const s of listSummonSessions({ activeOnly: true, limit: 500 })) {
    if (s.last_activity_at < cutoff) {
      const ended = endSummonSession(s.id, 'idle_timeout');
      if (ended) {
        console.log(`[summon] session ${s.id} ended (idle ${timeoutMin}m)`);
        sseBroadcast('summon.session_ended', {
          session: enrichSummon(ended),
          reason: 'idle_timeout',
        });
      }
    }
  }
}

async function handleSummonModeMessage(msg: MessageRow): Promise<void> {
  const settings = getSettings();
  if (!settings.summon_enabled) return;
  if (!msg.handle || msg.chat_id == null) return;

  // ECHO GUARD shared with away — same shape: AppleScript send writes to
  // chat.db with is_from_me=1, watcher re-emits, and we'd reply to our own
  // reply. Skip messages whose body matches one we just auto-sent.
  if (isOurAutoSendEcho(msg.handle, msg.text)) return;

  // Lazy idle expiry so sessions don't dangle forever between watcher events.
  expireIdleSummonSessions(settings.summon_idle_timeout_min);

  const text = msg.text || '';
  const trigger = settings.summon_trigger_phrase;
  const endPhrase = settings.summon_end_phrase.toLowerCase();

  // END PHRASE — only the user can dismiss Galt (case-insensitive substring).
  // Checked BEFORE trigger so "go away galt" can never accidentally re-summon.
  if (msg.is_from_me === 1 && text.toLowerCase().includes(endPhrase)) {
    const active = getActiveSummonSession(msg.chat_id);
    if (active) {
      const ended = endSummonSession(active.id, 'end_phrase');
      if (ended) {
        console.log(`[summon] session ${active.id} ended (end phrase from user, chat ${msg.chat_id})`);
        sseBroadcast('summon.session_ended', {
          session: enrichSummon(ended),
          reason: 'end_phrase',
        });
      }
    }
    return; // don't reply to the dismissal itself
  }

  // TRIGGER PHRASE — strict, case-sensitive substring match. User-only.
  const isTrigger = msg.is_from_me === 1 && text.includes(trigger);

  let session = getActiveSummonSession(msg.chat_id);

  if (isTrigger && !session) {
    session = createSummonSession(msg.chat_id, msg.handle);
    console.log(`[summon] session ${session.id} opened (trigger from user, chat ${msg.chat_id} → ${msg.handle})`);
    sseBroadcast('summon.session_started', { session: enrichSummon(session) });
    // Fall through — Galt drafts a reply to the trigger message.
  } else if (isTrigger && session) {
    // Already active — treat as "weigh in on this message" re-summon.
    console.log(`[summon] re-trigger in active session ${session.id}`);
  }

  // No active session → nothing to do. (Inbound messages from the contact
  // when the user has NOT summoned Galt are not auto-replied to in summon
  // mode — that's away mode's job.)
  if (!session) return;

  // Touch session activity (whether we end up replying or skipping).
  touchSummonSession(session.id);

  // Reply cap reached → close out gracefully.
  if (session.ai_reply_count >= settings.summon_max_replies_per_session) {
    const ended = endSummonSession(session.id, 'reply_cap_reached');
    if (ended) {
      sseBroadcast('summon.session_ended', {
        session: enrichSummon(ended),
        reason: 'reply_cap_reached',
      });
    }
    return;
  }

  if (!isAIConfigured()) {
    console.warn('[summon] cannot reply: OpenAI key not configured');
    return;
  }

  // Don't reply to our own outbound (echo guard already handled the chat.db
  // round-trip case, but a user-typed message that happens to MATCH something
  // we said wouldn't be in the echo set — that path returns early via
  // isOurAutoSendEcho above. We rely on the model's SKIP capability for
  // judgment calls about whether to speak vs stay quiet.)

  if (!text.trim()) return; // attachment-only or empty message → nothing to reply to

  // Concurrency lock: if we're already drafting for this chat, drop this
  // trigger. The in-flight draft will see ALL recent messages (including
  // this one) when it queries the thread — second trigger is redundant.
  if (draftingForChat.has(msg.chat_id)) {
    console.log(`[summon] dropping concurrent trigger for chat ${msg.chat_id} (draft already in flight)`);
    return;
  }
  draftingForChat.add(msg.chat_id);

  // Thread context, voice profile, contact context, and the summon system note.
  try {
    const messagesDesc = listMessagesForChat(msg.chat_id, 0, settings.ai_context_count);
    const thread = buildThreadFromMessages(messagesDesc);
    if (thread.length === 0) return;

    const contactNotes = listNotesForHandle(msg.handle).map((n) => n.body);
    const contactProfile = getContactProfile(msg.handle).profile;
    // Address book + calendar context — same shape as the regular draft
    // path and away mode use. Galt-as-third-voice should know who they're
    // talking to and (when relevant) the user's availability.
    const { addressBookContext, userAvailability } = await resolveDraftContext(msg.handle);
    const recipientName = msg.contact_name || msg.handle || 'them';
    // The user's display name from contacts. Falls back to "the user" so
    // Galt has SOMETHING to call them rather than going nameless.
    const userName = (() => {
      // First-party self-name isn't tracked anywhere structured. Use a
      // generic "the user" — Galt's prompt can ask the model to use first
      // names if voice profile has them.
      return 'the user';
    })();

    // User-provided override (Galt → Prompts → Summon mode) wins when
    // non-empty. Pass the RAW template — draftReply substitutes every
    // {placeholder} ({userName}, {recipientName}, {messages}, etc.) in
    // one place using the universal context.
    const customPrompt = settings.summon_system_prompt.trim();
    const contextNote = customPrompt
      || buildSummonContextNote({
          userName,
          recipientName,
          triggerFromUser: msg.is_from_me === 1,
          isActivation: isTrigger,
        });

    const result = await draftReply({
      thread,
      // Galt's voice (the system-wide AI voice). All AI calls use this
      // — away, summon, manual. (The user's old voice_profile concept
      // was retired; see CLAUDE.md.)
      voiceProfile: settings.galt_voice_profile,
      contactNotes,
      contactProfile,
      addressBookContext,
      userAvailability,
      contextNote,
      temperament: 'normal',
      count: 1,
      promptOverrides: pickPromptOverrides(settings),
      templateVars: { userName, recipientName },
    });

    const usable = result.variants.find((v) => !v.skipped && v.body.trim().length > 0);
    if (!usable) {
      if (isTrigger) {
        console.warn(`[summon] session ${session.id} — model returned SKIP on an activation/trigger turn despite prompt forbidding it (model fault — retrigger or inspect prompt)`);
      } else {
        console.log(`[summon] session ${session.id} — model returned SKIP for this turn (staying quiet)`);
      }
      return;
    }

    // Abort if Galt was dismissed during the typing delay (end-phrase typed,
    // session manually ended from dashboard, master switch flipped off).
    // Uses the summon delay profile (faster than away — friend dropping in,
    // not user covering for themselves).
    const handle = msg.handle; // capture for closure (TS narrowing is lost in arrow fn)
    const chatId = msg.chat_id;
    const sessionId = session.id;
    const send = await aiAutoSend({
      handle,
      body: usable.body,
      delayProfile: settings.away_send_delay_enabled ? 'summon' : 'off',
      abortIf: () => {
        const current = getActiveSummonSession(chatId);
        return !current || current.id !== sessionId || !getSettings().summon_enabled;
      },
      logTag: `[summon] session ${sessionId}`,
    });
    if (!send.sent) return;

    const updated = bumpSummonSession(session.id);
    console.log(
      `[summon] auto-replied in session ${session.id} (chat ${msg.chat_id}, reply ${updated?.ai_reply_count ?? '?'})`,
    );
    sseBroadcast('summon.replied', {
      session: updated ? enrichSummon(updated) : null,
      body: send.prefixedBody,
      thread_turns: thread.length,
      usage: result.usage ?? null,
    });
  } catch (err) {
    console.error('[summon] reply failed:', (err as Error).message);
  } finally {
    draftingForChat.delete(msg.chat_id);
  }
}

/* ---------- watcher → monitor evaluator ---------- */

async function evaluateMessageAgainstRules(msg: MessageRow): Promise<void> {
  if (msg.is_from_me === 1) return;
  if (!msg.text || msg.text.trim().length === 0) return;
  if (!isAIConfigured()) return;

  const flagRules = listEnabledMonitorRules('flag');
  for (const rule of flagRules) {
    if (!ruleMatchesScope(rule, msg)) continue;
    try {
      const result = await evaluateRuleAgainstMessage({
        rulePrompt: rule.prompt,
        sender: msg.contact_name || msg.handle || 'unknown',
        messageText: msg.text,
      });
      if (!result.match) continue;
      const flag = insertFlag({
        rule_id: rule.id,
        message_guid: msg.guid,
        message_rowid: msg.id,
        chat_id: msg.chat_id ?? 0,
        handle: msg.handle ?? '',
        text: msg.text,
        reasoning: result.reasoning,
        confidence: result.confidence,
      });
      if (!flag) continue;
      sseBroadcast('flag.new', {
        flag: { ...flag, contact_name: getContactNameForHandle(flag.handle) },
        rule_name: rule.name,
        confidence: result.confidence,
      });
    } catch (err) {
      console.error(`[monitor:flag] rule ${rule.id} eval failed:`, (err as Error).message);
    }
  }
}

async function evaluateMessageForCalendar(msg: MessageRow): Promise<void> {
  if (msg.is_from_me === 1) return;
  if (!msg.text || msg.text.trim().length === 0) return;
  if (!isAIConfigured()) return;
  if (!msg.guid || calendarProposalAlreadyExists(msg.guid)) return;

  const calRules = listEnabledMonitorRules('calendar');
  if (calRules.length === 0) return;

  // First matching scope wins — one extraction call per message regardless of how many calendar rules match.
  const matchingRule = calRules.find((r) => ruleMatchesScope(r, msg));
  if (!matchingRule) return;

  try {
    const sender = msg.contact_name || msg.handle || 'unknown';
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const result = await extractCalendarEvent({
      sender,
      messageText: msg.text,
      nowIso: new Date().toISOString(),
      timezone: tz,
    });
    if (!result.is_event) return;

    const startMs = result.start_iso ? Date.parse(result.start_iso) : null;
    const endMs = result.end_iso ? Date.parse(result.end_iso) : null;

    const proposal = insertCalendarProposal({
      source_msg_guid: msg.guid,
      message_rowid: msg.id,
      chat_id: msg.chat_id ?? 0,
      handle: msg.handle ?? '',
      title: result.title || `Event from ${sender}`,
      start_ms: Number.isFinite(startMs as number) ? (startMs as number) : null,
      end_ms: Number.isFinite(endMs as number) ? (endMs as number) : null,
      location: result.location,
      participants: result.participants,
      notes: result.notes,
      confidence: result.confidence,
      reasoning: result.reasoning,
      source_rule_id: matchingRule.id,
    });
    if (!proposal) return;

    sseBroadcast('calendar.proposal', {
      proposal: { ...proposal, contact_name: getContactNameForHandle(proposal.handle) },
    });
  } catch (err) {
    console.error('[monitor:calendar] extract failed:', (err as Error).message);
  }
}

async function evaluateMessageForRadar(msg: MessageRow): Promise<void> {
  if (msg.is_from_me === 1) return;
  if (!msg.text || msg.text.trim().length === 0) return;
  if (!isAIConfigured()) return;
  if (!msg.handle) return;

  const radarHandles = listEnabledRadarHandles();
  if (!radarHandles.has(msg.handle)) return;
  if (radarSignalAlreadyProcessed(msg.handle, msg.guid)) return;

  try {
    const sender = msg.contact_name || msg.handle || 'unknown';
    const result = await extractRadarSignals({ sender, messageText: msg.text });
    if (result.signals.length === 0) return;

    insertRadarSignals(
      result.signals.map((s) => ({
        handle: msg.handle!,
        message_guid: msg.guid,
        message_rowid: msg.id,
        chat_id: msg.chat_id ?? 0,
        category: s.category as RadarCategory,
        content: s.content,
        confidence: s.confidence,
        source_text: msg.text,
      })),
    );
    sseBroadcast('radar.signals', {
      handle: msg.handle,
      contact_name: getContactNameForHandle(msg.handle),
      count: result.signals.length,
      categories: result.signals.map((s) => s.category),
    });
  } catch (err) {
    console.error('[radar] extract failed:', (err as Error).message);
  }
}

function ruleMatchesScope(rule: MonitorRule, msg: MessageRow): boolean {
  if (rule.scope_type === 'all') return true;
  if (rule.scope_type === 'unknown') return msg.contact_name === null;
  if (rule.scope_type === 'contact') {
    // Normalize both sides — msg.handle is already canonical (from chat.db),
    // but rule.scope_handle may have been stored before ingest-side
    // normalization landed.
    return normalizeHandle(rule.scope_handle) === normalizeHandle(msg.handle);
  }
  return false;
}

// Subscribe the monitor evaluator(s) to the watcher AFTER the SSE listener.
messageWatcher.onMessages((messages: MessageRow[]) => {
  for (const m of messages) {
    void evaluateMessageAgainstRules(m);
    void evaluateMessageForCalendar(m);
    void evaluateMessageForRadar(m);
    // Note triage on every inbound message, regardless of mode. Skips itself
    // when an away session is active (that path triages with a session_id).
    void triageInboundMessage(m);
    // away mode handles both incoming (auto-respond) and outgoing (user-replied → end session).
    void handleAwayModeMessage(m);
    // summon mode: trigger phrase opens a session, end phrase closes it,
    // active sessions get Galt-as-a-third-voice replies.
    void handleSummonModeMessage(m);
  }
});

/* ---------- scheduler tick: send due messages ---------- */

const SCHEDULER_TICK_MS = 30_000;
const sendingNow = new Set<number>();

async function schedulerTick(): Promise<void> {
  let due: ReturnType<typeof listDueScheduled>;
  try {
    due = listDueScheduled();
  } catch (err) {
    console.error('[scheduler] tick query failed:', (err as Error).message);
    return;
  }
  for (const s of due) {
    if (sendingNow.has(s.id)) continue;
    sendingNow.add(s.id);
    try {
      await sendMessageViaAppleScript(s.handle, s.body, {
        service: s.service === 'SMS' ? 'SMS' : 'iMessage',
      });
      const updated = updateScheduledStatus(s.id, 'sent');
      console.log(`[scheduler] sent #${s.id} → ${s.handle}`);
      sseBroadcast('scheduled.sent', { scheduled: updated ? enrichScheduled(updated) : null });
    } catch (err) {
      const msg = (err as Error).message;
      const updated = updateScheduledStatus(s.id, 'failed', msg);
      console.error(`[scheduler] FAILED #${s.id} → ${s.handle}: ${msg}`);
      sseBroadcast('scheduled.failed', { scheduled: updated ? enrichScheduled(updated) : null, error: msg });
    } finally {
      sendingNow.delete(s.id);
    }
  }
}

const schedulerInterval = setInterval(() => {
  void schedulerTick();
}, SCHEDULER_TICK_MS);
schedulerInterval.unref();
// Run once on boot in case anything is overdue at startup.
void schedulerTick();

/* ---------- static frontend ---------- */

app.use(express.static(config.webDir, { extensions: ['html'] }));

/* ---------- error handler ---------- */

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: (err as Error).message ?? 'internal error' });
};
app.use(errorHandler);

/* ---------- boot ---------- */

const server = app.listen(config.port, config.host, () => {
  console.log(`galt listening on http://${config.host}:${config.port}`);
  // Eagerly init both DBs so failures surface at boot, not on first request.
  try {
    getChatDb();
    console.log(`  chat.db OK   (${config.chatDbPath})`);
  } catch (err) {
    console.warn(`  chat.db FAIL (${config.chatDbPath}): ${(err as Error).message}`);
    console.warn('  → grant Full Disk Access to your runner in System Settings.');
  }
  try {
    getAppDb();
    console.log(`  app.db  OK   (${config.appDbPath})`);
  } catch (err) {
    console.warn(`  app.db  FAIL (${config.appDbPath}): ${(err as Error).message}`);
  }
  try {
    preloadContacts();
  } catch (err) {
    console.warn(`  contacts FAIL: ${(err as Error).message}`);
  }
  try {
    messageWatcher.start();
    console.log(`  watcher: started (chat.db-wal)`);
  } catch (err) {
    console.warn(`  watcher: ${(err as Error).message}`);
  }
  // Push initial state snapshot so the remote console reflects the live
  // server immediately on boot, not only after the first user mutation.
  void pushStateSnapshotNow();
  // Start the RTDB command listener so the remote console can push
  // intents back to this Mac.
  startCommandListener();
});

function shutdown(signal: string) {
  console.log(`\n${signal} received, shutting down...`);
  clearInterval(schedulerInterval);
  stopCommandListener();
  messageWatcher.stop();
  for (const c of sseClients) {
    try {
      c.end();
    } catch {
      /* noop */
    }
  }
  sseClients.clear();
  server.close(() => {
    closeChatDb();
    closeAppDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
