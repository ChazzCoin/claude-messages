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
  listSentMessages,
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
  // away notes
  listAwayNotes,
  insertAwayNote,
  awayNoteAlreadyExists,
  markAwayNoteReviewed,
  markAllAwayNotesReviewed,
  removeAwayNote,
  countUnreviewedAwayNotes,
  type MonitorScopeType,
  type MonitorKind,
  type MonitorRule,
  type ScheduledStatus,
  type RadarCategory,
  type CalendarProposalStatus,
  type AwaySession,
} from './db/app.js';
import { sendMessageViaAppleScript } from './send.js';
import { messageWatcher } from './watcher.js';
import {
  listAllContacts,
  listContactsWithHandles,
  preloadContacts,
  reloadContacts,
  getContactNameForHandle,
  normalizeHandle,
} from './db/contacts.js';
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
  generateVoiceProfile,
  buildThreadFromMessages,
  summarizeThread,
  evaluateRuleAgainstMessage,
  extractRadarSignals,
  distillRadarProfile,
  extractCalendarEvent,
  extractAwayNote,
  TEMPERAMENTS,
  type Temperament,
} from './ai.js';

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
    server: 'imsg-ai',
    version: '0.1.0',
    chat_db: { path: config.chatDbPath, ok: chatDbOk, error: chatDbError },
    app_db: { path: config.appDbPath },
    openai_configured: isAIConfigured(),
    openai_model: effectiveModel(),
    openai_key_source: apiKeySource(),
    watcher_running: messageWatcher.isRunning(),
    away_mode_enabled: !!getSettings().away_mode_enabled,
    away_active_sessions: countActiveAwaySessions(),
    away_unreviewed_notes: countUnreviewedAwayNotes(),
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
  res.json({ settings: redactSettingsForResponse(getSettings()), bounds: SETTING_BOUNDS });
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

/**
 * POST /api/ai/draft
 * Body: {
 *   chat_id,
 *   context_count?: 1..100  (default = settings.ai_context_count)
 *   context_note?: string   (optional user hint for THIS draft)
 *   temperament?: enum      (defaults to "normal"; see TEMPERAMENTS)
 *   count?: 1..5            (number of variants to generate; default 1)
 *   save?: boolean          (auto-save to drafts queue when count == 1, default true.
 *                            When count > 1, returns variants without auto-saving.)
 * }
 *
 * Always returns { variants: [{body, skipped}], source_msg_guid, ... }.
 * When count == 1 and save is true, also persists the saved Draft row.
 */
app.post(
  '/api/ai/draft',
  asyncHandler(async (req, res) => {
    if (!requireAI(req, res)) return;

    const chatId = parseInt(req.body?.chat_id, 10);
    if (!Number.isFinite(chatId)) return res.status(400).json({ error: 'chat_id required' });

    const settings = getSettings();
    const ccRaw = parseInt(req.body?.context_count, 10);
    const contextCount = Number.isFinite(ccRaw)
      ? Math.max(1, Math.min(SETTING_BOUNDS.ai_context_count.max, ccRaw))
      : settings.ai_context_count;

    const contextNote =
      typeof req.body?.context_note === 'string' && req.body.context_note.trim().length > 0
        ? req.body.context_note.trim()
        : undefined;

    const tempRaw = typeof req.body?.temperament === 'string' ? req.body.temperament : '';
    const temperament: Temperament = (TEMPERAMENTS as readonly string[]).includes(tempRaw)
      ? (tempRaw as Temperament)
      : 'normal';

    const variantRaw = parseInt(req.body?.count, 10);
    const variantCount = Number.isFinite(variantRaw) ? Math.max(1, Math.min(5, variantRaw)) : 1;

    const save = req.body?.save !== false && variantCount === 1; // never auto-save when caller asked for multiple

    const messagesDesc = listMessagesForChat(chatId, 0, contextCount);
    if (messagesDesc.length === 0) {
      return res.status(400).json({ error: `chat ${chatId} has no messages` });
    }

    const sourceMsg = messagesDesc.find((m) => m.is_from_me === 0 && (m.text ?? '').trim() !== '');
    if (!sourceMsg) {
      return res
        .status(400)
        .json({ error: 'no incoming message in the recent window — nothing to reply to' });
    }

    const thread = buildThreadFromMessages(messagesDesc);
    if (thread.length === 0) {
      return res
        .status(400)
        .json({ error: 'no decodable text in the recent window (attachments only?)' });
    }

    // Look up recipient handle now so we can also pull per-contact notes.
    const chatDb = getChatDb();
    const chatRow = chatDb
      .prepare('SELECT chat_identifier FROM chat WHERE ROWID = ?')
      .get(chatId) as { chat_identifier: string } | undefined;
    if (!chatRow) return res.status(404).json({ error: `chat ${chatId} not found` });

    const contactNotes = listNotesForHandle(chatRow.chat_identifier).map((n) => n.body);
    const contactProfile = getContactProfile(chatRow.chat_identifier).profile;

    const result = await draftReply({
      thread,
      contextNote,
      voiceProfile: settings.voice_profile,
      contactNotes,
      contactProfile,
      temperament,
      count: variantCount,
    });

    const usage = result.usage ?? null;
    const usableVariants = result.variants.filter((v) => !v.skipped && v.body.trim().length > 0);

    let draftRecord = null;
    if (save && usableVariants.length > 0) {
      const tokenLine = usage
        ? `tokens: ${usage.prompt_tokens}+${usage.completion_tokens}`
        : 'tokens: ?';
      const tempLine = temperament !== 'normal' ? ` · temperament: ${temperament}` : '';
      const noteLine = contextNote ? ` · note: ${JSON.stringify(contextNote)}` : '';
      const profileLine = settings.voice_profile ? ' · voice-profile: applied' : '';
      const memoryLine = contactNotes.length > 0 ? ` · contact-notes: ${contactNotes.length}` : '';
      const contactProfileLine = contactProfile ? ' · contact-profile: applied' : '';
      draftRecord = createDraft({
        source_msg_guid: sourceMsg.guid,
        chat_id: chatId,
        handle: chatRow.chat_identifier,
        body: usableVariants[0]!.body,
        reasoning: `AI · model=${result.model} · context=${thread.length} turns · ${tokenLine}${profileLine}${contactProfileLine}${tempLine}${memoryLine}${noteLine}`,
      });
    }

    return res.json({
      variants: result.variants,
      skipped: usableVariants.length === 0,
      thread_turns: thread.length,
      source_msg_guid: sourceMsg.guid,
      handle: chatRow.chat_identifier,
      contact_name: getContactNameForHandle(chatRow.chat_identifier),
      chat_id: chatId,
      temperament,
      voice_profile_applied: !!settings.voice_profile,
      contact_notes_applied: contactNotes.length,
      contact_profile_applied: !!contactProfile,
      model: result.model,
      usage,
      draft: enrichDraft(draftRecord),
    });
  }),
);

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

/**
 * POST /api/ai/voice-profile/regenerate
 * Body: { sample_count?: 50..2000, user_context?: string }
 * Reads the user's most recent sent messages from chat.db, optionally
 * blends with the existing voice_profile setting, runs the AI, and
 * persists the result. Returns the updated profile + sample stats.
 */
app.post(
  '/api/ai/voice-profile/regenerate',
  asyncHandler(async (req, res) => {
    if (!requireAI(req, res)) return;

    const settings = getSettings();
    const sampleRaw = parseInt(req.body?.sample_count, 10);
    const { min, max } = SETTING_BOUNDS.voice_profile_sample_count;
    const sampleCount = Number.isFinite(sampleRaw)
      ? Math.max(min, Math.min(max, sampleRaw))
      : settings.voice_profile_sample_count;

    const userContext =
      typeof req.body?.user_context === 'string'
        ? req.body.user_context
        : settings.voice_profile_user_context;

    const sentDesc = listSentMessages(sampleCount);
    const samples = sentDesc
      .map((m) => m.text ?? '')
      .filter((t) => t.trim().length > 0)
      .reverse(); // chronological for the prompt

    if (samples.length === 0) {
      return res
        .status(400)
        .json({ error: 'no sent messages found in chat.db — cannot generate a voice profile' });
    }

    const result = await generateVoiceProfile({
      existing: settings.voice_profile,
      userContext,
      samples,
    });

    const updatedAt = Date.now();
    const updated = updateSettings({
      voice_profile: result.profile,
      voice_profile_sample_count: sampleCount,
      voice_profile_user_context: userContext,
      voice_profile_updated_at: updatedAt,
    });

    return res.json({
      settings: updated,
      sample_count: result.sampleCount,
      model: result.model,
      usage: result.usage ?? null,
    });
  }),
);

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
      uid: `imsg-ai-${p.id}-${Date.now()}@local`,
      title: p.title,
      startMs,
      endMs,
      location: p.location,
      description: [p.notes, p.participants ? `Participants: ${p.participants}` : null]
        .filter(Boolean)
        .join('\n\n'),
    });

    const tmpPath = path.join(os.tmpdir(), `imsg-ai-event-${id}.ics`);
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
    'PRODID:-//imsg-ai//EN',
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

app.get('/api/away/contacts', (_req, res) => {
  res.json({ contacts: listAwayContacts().map((c) => enrichAway(c)) });
});

app.post('/api/away/contacts', (req, res) => {
  const handle = normalizeHandle(req.body?.handle);
  const labelRaw = typeof req.body?.label === 'string' ? req.body.label.trim() : null;
  if (!handle) return res.status(400).json({ error: 'handle required' });
  const label = labelRaw || getContactNameForHandle(handle);
  res.status(201).json({ contact: enrichAway(addAwayContact(handle, label)) });
});

app.patch('/api/away/contacts/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  if (typeof req.body?.enabled !== 'boolean')
    return res.status(400).json({ error: 'only `enabled: bool` supported here' });
  const ok = setAwayContactEnabled(id, req.body.enabled);
  return ok ? res.json({ ok: true }) : res.status(404).json({ error: 'not found' });
});

app.delete('/api/away/contacts/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const ok = removeAwayContact(id);
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

/* ---------- routes: away notes ---------- */

app.get('/api/away/notes', (req, res) => {
  const reviewedRaw = req.query.reviewed;
  let reviewed: boolean | undefined;
  if (reviewedRaw === 'true') reviewed = true;
  else if (reviewedRaw === 'false') reviewed = false;
  const limit = intParam(req.query.limit, 200, 1, 500);
  const notes = listAwayNotes({ reviewed, limit }).map((n) => ({
    ...n,
    contact_name: getContactNameForHandle(n.handle),
  }));
  res.json({ notes, unreviewed: countUnreviewedAwayNotes() });
});

app.post('/api/away/notes/:id/review', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const note = markAwayNoteReviewed(id);
  if (!note) return res.status(404).json({ error: 'not found' });
  res.json({ note: { ...note, contact_name: getContactNameForHandle(note.handle) } });
});

app.post('/api/away/notes/review-all', (_req, res) => {
  const n = markAllAwayNotesReviewed();
  res.json({ marked_reviewed: n });
});

app.delete('/api/away/notes/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const ok = removeAwayNote(id);
  return ok ? res.status(204).end() : res.status(404).json({ error: 'not found' });
});

/* ---------- watcher → away-mode auto-responder ---------- */

/**
 * In-memory ledger of message bodies the away pipeline just auto-sent, keyed
 * by recipient handle. The AppleScript-driven send writes to chat.db with
 * is_from_me=1, then the watcher re-emits that row. Without this ledger, the
 * AI's own reply would trip the "user replied → end session" branch and the
 * next inbound message would fire a fresh greeting. 60s TTL is generous —
 * Messages.app usually echoes within ~1s.
 */
const recentAwayAutoSends = new Map<string, Set<string>>();
const AWAY_ECHO_TTL_MS = 60_000;

function trackAwayAutoSend(handle: string, body: string): void {
  let set = recentAwayAutoSends.get(handle);
  if (!set) {
    set = new Set();
    recentAwayAutoSends.set(handle, set);
  }
  set.add(body);
  setTimeout(() => {
    recentAwayAutoSends.get(handle)?.delete(body);
  }, AWAY_ECHO_TTL_MS).unref();
}

function isAwayEcho(handle: string, body: string | null | undefined): boolean {
  if (!body) return false;
  const set = recentAwayAutoSends.get(handle);
  // Membership-only — don't delete. The same body can echo multiple times
  // (e.g. messaging yourself: outgoing + incoming for the same text).
  // The TTL set in trackAwayAutoSend cleans the entry eventually.
  return !!set && set.has(body);
}

function buildAwayContextNote(persona: string, recipientName: string): string {
  const sections: string[] = [];

  sections.push(
    `You are responding to: ${recipientName}. Use their name naturally when it actually fits the conversation — but DON'T shoehorn it. Don't address them by name in every message; that gets robotic fast. A casual reply usually has no name in it at all; reserve it for moments where calling someone by name actually adds warmth or clarity (e.g. opening a slightly serious thought, getting their attention, checking in). When their name does fit, use it the way the user normally would — first name, in the user's case.`,
  );

  sections.push(
    "You are continuing this iMessage conversation while the user is away — they've turned on \"away mode\" and the contact has ALREADY been told (in the greeting message earlier in this thread) that they're chatting with the user's AI. Don't re-announce that fact unless they explicitly ask.",
  );

  sections.push(
    "Behave like a friend who's covering — not like customer service. Keep the conversation natural, varied, and alive.",
  );

  sections.push(
    "Read your OWN previous replies in the thread (the 'me:' lines that already exist) and DO NOT repeat their phrasings, openings, or hedges. Vary turn-to-turn — different opener, different rhythm, different vocabulary. If your last reply started with 'yeah', don't start with 'yeah' again. If you already used a deflection phrase once, find a different way to say it.",
  );

  sections.push(
    "Match the energy of the most recent incoming message: if they're playful, be playful; if they're terse, be terse; if they ask a real question and the thread already gives you the answer, just answer.",
  );

  sections.push(
    'When you genuinely cannot know something (specific times/places/money/promises the user has not confirmed in the thread, personal details about the user\'s day, anything only the real user can decide): deflect IN THE USER\'S VOICE. Examples — "lol no idea, you\'ll have to wait on him for that" / "lemme have him hit you when he\'s up" / "that one\'s above my pay grade haha". Do NOT say "let me check with him" every time — that\'s the butler reflex; vary it. Only deflect when you actually need to.',
  );

  sections.push(
    "What you should NOT do: re-announce being AI every turn; use customer-service phrasings ('apologies for the inconvenience', 'thank you for reaching out'); make up commitments; sound robotic or formal beyond the user's baseline.",
  );

  if (persona && persona.trim()) {
    sections.push(
      `EXTRA GUIDANCE FROM THE USER FOR HOW YOU SHOULD BEHAVE WHILE COVERING (apply this on top of the voice profile — these are explicit personality instructions for away mode):\n"""\n${persona.trim()}\n"""`,
    );
  }

  sections.push('Output only the reply text. No quotes, no preamble, no explanation.');

  return sections.join('\n\n');
}

/**
 * Fire-and-forget AI extraction: when an inbound message comes in during an
 * away session, ask the model whether it's something the user should follow
 * up on personally (meet request, discussion topic, etc.) and persist any
 * matches into away_notes. Idempotent on message_guid.
 */
async function extractAwayNoteForMessage(sessionId: number | null, msg: MessageRow): Promise<void> {
  if (!msg.text || !msg.handle || !msg.guid) return;
  if (!isAIConfigured()) return;
  if (awayNoteAlreadyExists(msg.guid)) return;

  try {
    const sender = msg.contact_name || msg.handle || 'them';
    const result = await extractAwayNote({ sender, messageText: msg.text });
    if (!result.shouldNote || !result.summary) return;

    const note = insertAwayNote({
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

    sseBroadcast('away.note_created', {
      note: { ...note, contact_name: getContactNameForHandle(msg.handle) },
    });
  } catch (err) {
    console.error('[away:note] extraction failed:', (err as Error).message);
  }
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
  if (isAwayEcho(msg.handle, msg.text)) {
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
    const greeting = (settings.away_message || '').trim();
    if (!greeting) {
      console.warn('[away] enabled but away_message is empty — skipping greeting');
      return;
    }
    try {
      trackAwayAutoSend(msg.handle, greeting); // mark BEFORE send so the echo race doesn't end the session
      await sendMessageViaAppleScript(msg.handle, greeting);
      const newSession = createAwaySession(msg.handle);
      console.log(`[away] greeting sent to ${msg.handle}, session ${newSession.id} opened`);
      sseBroadcast('away.greeting_sent', {
        session: enrichAway(newSession),
        message: greeting,
      });
      // Even the FIRST message can carry a follow-up item — extract.
      void extractAwayNoteForMessage(newSession.id, msg);
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
    const result = await draftReply({
      thread,
      voiceProfile: settings.voice_profile,
      contactNotes,
      contactProfile,
      contextNote: buildAwayContextNote(settings.away_persona, recipientName),
      temperament: 'normal',
      count: 1,
    });
    const usable = result.variants.find((v) => !v.skipped && v.body.trim().length > 0);
    if (!usable) {
      console.log('[away] model returned SKIP for continuation — staying silent');
      return;
    }

    trackAwayAutoSend(msg.handle, usable.body); // mark BEFORE send so the echo race doesn't end the session
    await sendMessageViaAppleScript(msg.handle, usable.body);
    const updated = bumpAwaySession(session.id);
    console.log(
      `[away] auto-replied to ${msg.handle} (session ${session.id}, reply ${updated?.ai_reply_count ?? '?'})`,
    );
    sseBroadcast('away.replied', {
      session: updated ? enrichAway(updated) : null,
      body: usable.body,
      thread_turns: thread.length,
      usage: result.usage ?? null,
    });
    // After replying, ask the model whether this inbound carried a follow-up
    // item the user should see when they're back.
    void extractAwayNoteForMessage(session.id, msg);
  } catch (err) {
    console.error('[away] continuation failed:', (err as Error).message);
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
    // away mode handles both incoming (auto-respond) and outgoing (user-replied → end session).
    void handleAwayModeMessage(m);
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
  console.log(`imsg-ai listening on http://${config.host}:${config.port}`);
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
});

function shutdown(signal: string) {
  console.log(`\n${signal} received, shutting down...`);
  clearInterval(schedulerInterval);
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
