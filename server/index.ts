import express from 'express';
import type { ErrorRequestHandler, Request, Response, NextFunction } from 'express';
import { config } from './config.js';
import {
  getChatDb,
  closeChatDb,
  listChats,
  listMessagesForChat,
  listRecentMessages,
} from './db/messages.js';
import {
  getAppDb,
  closeAppDb,
  listWatched,
  addWatched,
  removeWatched,
  listRules,
  addRule,
  setRuleEnabled,
  removeRule,
  listDrafts,
  getDraft,
  updateDraftStatus,
  createDraft,
  getSettings,
  updateSettings,
  SETTING_BOUNDS,
} from './db/app.js';
import { sendMessageViaAppleScript } from './send.js';
import { messageWatcher } from './watcher.js';
import {
  isAIConfigured,
  classifyIncoming,
  draftReply,
  buildThreadFromMessages,
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
    openai_configured: !!config.openai.apiKey,
    openai_model: config.openai.model,
    watcher_running: messageWatcher.isRunning(),
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

/* ---------- routes: watched contacts (app.db) ---------- */

app.get('/api/watched', (_req, res) => {
  res.json({ watched: listWatched() });
});

app.post('/api/watched', (req, res) => {
  const handle = typeof req.body?.handle === 'string' ? req.body.handle.trim() : '';
  const label = typeof req.body?.label === 'string' ? req.body.label.trim() : null;
  if (!handle) return res.status(400).json({ error: 'handle required' });
  return res.status(201).json({ watched: addWatched(handle, label || null) });
});

app.delete('/api/watched/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const ok = removeWatched(id);
  return ok ? res.status(204).end() : res.status(404).json({ error: 'not found' });
});

/* ---------- routes: rules (app.db) ---------- */

app.get('/api/rules', (_req, res) => {
  res.json({ rules: listRules() });
});

app.post('/api/rules', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const pattern = typeof req.body?.pattern === 'string' ? req.body.pattern : '';
  const flags = typeof req.body?.flags === 'string' ? req.body.flags : 'i';
  if (!name || !pattern) return res.status(400).json({ error: 'name and pattern required' });
  try {
    return res.status(201).json({ rule: addRule(name, pattern, flags) });
  } catch (err) {
    return res.status(400).json({ error: `invalid regex: ${(err as Error).message}` });
  }
});

app.patch('/api/rules/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  if (typeof req.body?.enabled !== 'boolean')
    return res.status(400).json({ error: 'only `enabled: bool` supported here' });
  const ok = setRuleEnabled(id, req.body.enabled);
  return ok ? res.json({ ok: true }) : res.status(404).json({ error: 'not found' });
});

app.delete('/api/rules/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const ok = removeRule(id);
  return ok ? res.status(204).end() : res.status(404).json({ error: 'not found' });
});

/* ---------- routes: drafts (app.db + AppleScript send) ---------- */

app.get('/api/drafts', (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const valid = ['pending', 'sent', 'discarded', 'edited'] as const;
  const filter = (valid as readonly string[]).includes(status ?? '')
    ? (status as (typeof valid)[number])
    : undefined;
  res.json({ drafts: listDrafts(filter) });
});

app.post('/api/drafts', (req, res) => {
  const chatId = parseInt(req.body?.chat_id, 10);
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  let handle = typeof req.body?.handle === 'string' ? req.body.handle.trim() : '';
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
  return res.status(201).json({ draft });
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
    return res.json({ draft: updated });
  }),
);

app.post('/api/drafts/:id/discard', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const draft = getDraft(id);
  if (!draft) return res.status(404).json({ error: 'not found' });
  return res.json({ draft: updateDraftStatus(id, 'discarded') });
});

/* ---------- routes: settings ---------- */

app.get('/api/settings', (_req, res) => {
  res.json({ settings: getSettings(), bounds: SETTING_BOUNDS });
});

app.put('/api/settings', (req, res) => {
  try {
    const settings = updateSettings(req.body ?? {});
    res.json({ settings, bounds: SETTING_BOUNDS });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/* ---------- routes: AI (classification + draft generation) ---------- */

function requireAI(_req: Request, res: Response): boolean {
  if (!isAIConfigured()) {
    res.status(503).json({
      error: 'AI features unavailable: OPENAI_API_KEY is not set in .env. Add it and restart.',
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
 * Body: { chat_id, context_count?: 1..50 (default 10), save?: boolean (default true) }
 *
 * Pulls the last N messages from the chat (DESC), builds a chronological
 * thread, and asks the model to draft a reply to the most recent
 * incoming message. When `save` is true, persists the draft into the
 * approval queue with the source message's guid.
 */
app.post(
  '/api/ai/draft',
  asyncHandler(async (req, res) => {
    if (!requireAI(req, res)) return;

    const chatId = parseInt(req.body?.chat_id, 10);
    if (!Number.isFinite(chatId)) return res.status(400).json({ error: 'chat_id required' });

    const ccRaw = parseInt(req.body?.context_count, 10);
    const fallbackCount = getSettings().ai_context_count;
    const contextCount = Number.isFinite(ccRaw)
      ? Math.max(1, Math.min(SETTING_BOUNDS.ai_context_count.max, ccRaw))
      : fallbackCount;

    const save = req.body?.save !== false; // default true

    const contextNote =
      typeof req.body?.context_note === 'string' && req.body.context_note.trim().length > 0
        ? req.body.context_note.trim()
        : undefined;

    const messagesDesc = listMessagesForChat(chatId, 0, contextCount);
    if (messagesDesc.length === 0) {
      return res.status(400).json({ error: `chat ${chatId} has no messages` });
    }

    // Most recent incoming message becomes the "source" for the draft record.
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

    const result = await draftReply({ thread, contextNote });

    if (result.skipped || !result.body) {
      return res.json({
        skipped: true,
        thread,
        model: result.model,
        usage: result.usage ?? null,
      });
    }

    let draftRecord = null;
    if (save) {
      const chatDb = getChatDb();
      const chatRow = chatDb
        .prepare('SELECT chat_identifier FROM chat WHERE ROWID = ?')
        .get(chatId) as { chat_identifier: string } | undefined;
      if (!chatRow) return res.status(404).json({ error: `chat ${chatId} not found` });

      const tokenLine = result.usage
        ? `tokens: ${result.usage.prompt_tokens}+${result.usage.completion_tokens}`
        : 'tokens: ?';
      const noteLine = contextNote ? ` · note: ${JSON.stringify(contextNote)}` : '';
      draftRecord = createDraft({
        source_msg_guid: sourceMsg.guid,
        chat_id: chatId,
        handle: chatRow.chat_identifier,
        body: result.body,
        reasoning: `AI · model=${result.model} · context=${thread.length} turns · ${tokenLine}${noteLine}`,
      });
    }

    return res.json({
      skipped: false,
      body: result.body,
      thread,
      model: result.model,
      usage: result.usage ?? null,
      draft: draftRecord,
    });
  }),
);

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
});

function shutdown(signal: string) {
  console.log(`\n${signal} received, shutting down...`);
  server.close(() => {
    closeChatDb();
    closeAppDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
