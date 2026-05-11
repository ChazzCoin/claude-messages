// Command bus: the frontend (Firebase-hosted PWA) writes intents to
// /commands/<auto_id>; this listener picks them up, dispatches via the
// same internal helpers used by the local HTTP routes, writes a result
// back, and deletes the command after a short grace window.
//
// All commands are idempotent — they set values, not deltas — so a
// listener restart that replays the same command is safe.
//
// SQLite remains the source of truth. After every applied command we
// push a fresh /state snapshot so the frontend re-renders against the
// live server, not against its optimistic local state.

import type { DataSnapshot, Reference } from 'firebase-admin/database';
import {
  updateSettings,
  endAllActiveAwaySessions,
  endAllActiveSummonSessions,
  addAwayContact,
  removeAwayContact,
  setAwayContactEnabled,
  getSettings,
  markAutoNoteReviewed,
  markAllAutoNotesReviewed,
  removeAutoNote,
  getAutoNote,
  listAutoNotes,
} from './db/app.js';
import { getContactNameForHandle, normalizeHandle } from './db/contacts.js';
import { getMirrorDb, mirrorUpdateNote, mirrorDeleteNote } from './firebase.js';
import { pushStateSnapshot, pushStateSnapshotNow } from './firebase-state.js';
import { saveDeviceToken, removeDevice, sendPushToAll } from './firebase-push.js';
import { chatTurn, type ChatTurnMessage } from './ai/galt-chat.js';

interface CommandResult {
  ok: boolean;
  error?: string;
  data?: unknown;
  processed_at: number;
}

interface RawCommand {
  type?: string;
  payload?: Record<string, unknown>;
  requested_at?: number;
  result?: CommandResult;
}

const GRACE_BEFORE_DELETE_MS = 5_000;

let _started = false;
let _ref: Reference | null = null;

/** Register the /commands listener. Idempotent — calling twice is a
 *  no-op. Safe to call before Firebase init returns null; the inner
 *  getMirrorDb() will lazy-disable if creds are missing. */
export function startCommandListener(): void {
  if (_started) return;
  const db = getMirrorDb();
  if (!db) {
    console.log('[firebase-commands] mirror disabled — listener not started');
    return;
  }
  _started = true;
  _ref = db.ref('/commands');

  _ref.on('child_added', (snap) => {
    void processCommand(snap).catch((err) => {
      console.error('[firebase-commands] processCommand crashed:', (err as Error).message);
    });
  });

  console.log('[firebase-commands] listener started on /commands');
}

export function stopCommandListener(): void {
  if (_ref) {
    _ref.off();
    _ref = null;
  }
  _started = false;
}

async function processCommand(snap: DataSnapshot): Promise<void> {
  const id = snap.key;
  if (!id) return;
  const raw = snap.val() as RawCommand | null;

  // Skip entries we already wrote a result onto. Happens when the
  // listener restarts and replays children that were processed but not
  // yet deleted. We still re-apply (idempotent), but don't double-write
  // the result/delete-timer.
  if (raw && raw.result) {
    console.log(`[firebase-commands] skip already-processed id=${id}`);
    return;
  }

  console.log(`[firebase-commands] recv id=${id} type=${raw?.type}`);

  let result: CommandResult;
  try {
    const data = await dispatch(raw ?? {});
    result = { ok: true, data, processed_at: Date.now() };
  } catch (err) {
    result = { ok: false, error: (err as Error).message, processed_at: Date.now() };
    console.error(`[firebase-commands] dispatch failed id=${id}:`, (err as Error).message);
  }

  // Push fresh state regardless of success — failure modes can still
  // shift state (e.g. settings rejected after partial work — none of
  // ours do that today, but cheap insurance).
  pushStateSnapshot();

  try {
    await snap.ref.child('result').set(result);
  } catch (err) {
    console.error(`[firebase-commands] write result failed id=${id}:`, (err as Error).message);
  }

  // Grace window so the frontend has time to read the result, then
  // garbage-collect the command. Don't await — the listener should
  // free up to process the next child_added immediately.
  setTimeout(() => {
    snap.ref.remove().catch((err: Error) => {
      console.error(`[firebase-commands] delete failed id=${id}:`, err.message);
    });
  }, GRACE_BEFORE_DELETE_MS).unref();
}

/** Whitelist + validate + apply. Throws on unknown type or bad payload —
 *  the caller wraps that into a structured error result. */
async function dispatch(cmd: RawCommand): Promise<unknown> {
  const type = typeof cmd.type === 'string' ? cmd.type : '';
  const p = (cmd.payload ?? {}) as Record<string, unknown>;

  switch (type) {
    case 'set_summon_enabled': {
      const enabled = !!p.enabled;
      const before = getSettings();
      const after = updateSettings({ summon_enabled: enabled ? 1 : 0 });
      if (before.summon_enabled && !enabled) {
        const ended = endAllActiveSummonSessions('globally_disabled');
        if (ended > 0) console.log(`[firebase-commands] ended ${ended} summon session(s) on remote disable`);
      }
      return { summon_enabled: !!after.summon_enabled };
    }

    case 'set_away_enabled': {
      const enabled = !!p.enabled;
      const before = getSettings();
      const after = updateSettings({ away_mode_enabled: enabled ? 1 : 0 });
      if (before.away_mode_enabled && !enabled) {
        const ended = endAllActiveAwaySessions('away_mode_disabled');
        if (ended > 0) console.log(`[firebase-commands] ended ${ended} away session(s) on remote disable`);
      }
      return { away_mode_enabled: !!after.away_mode_enabled };
    }

    case 'set_away_message': {
      const text = typeof p.text === 'string' ? p.text : '';
      const after = updateSettings({ away_message: text });
      return { away_message: after.away_message };
    }

    // 'set_voice_profile' (the old user voice profile) was retired when
    // Galt became the system-wide AI voice. Companion clients calling
    // this command on this build get an error and should switch to
    // set_galt_voice_profile.

    case 'set_galt_voice_profile': {
      const text = typeof p.text === 'string' ? p.text : '';
      const after = updateSettings({ galt_voice_profile: text });
      return { galt_voice_profile: after.galt_voice_profile };
    }

    case 'set_auto_notes_enabled': {
      const enabled = !!p.enabled;
      const after = updateSettings({ auto_notes_enabled: enabled ? 1 : 0 });
      return { auto_notes_enabled: !!after.auto_notes_enabled };
    }

    case 'add_watched_contact': {
      const handleRaw = typeof p.handle === 'string' ? p.handle : '';
      const handle = normalizeHandle(handleRaw);
      if (!handle) throw new Error('handle required');
      const labelRaw = typeof p.label === 'string' ? p.label.trim() : '';
      const label = labelRaw || getContactNameForHandle(handle);
      const contact = addAwayContact(handle, label);
      return {
        contact: {
          ...contact,
          enabled: !!contact.enabled,
          contact_name: getContactNameForHandle(contact.handle),
        },
      };
    }

    case 'remove_watched_contact': {
      const id = typeof p.id === 'number' ? p.id : NaN;
      if (!Number.isFinite(id)) throw new Error('id required');
      const ok = removeAwayContact(id);
      if (!ok) throw new Error('contact not found');
      return { removed_id: id };
    }

    case 'set_watched_contact_enabled': {
      const id = typeof p.id === 'number' ? p.id : NaN;
      if (!Number.isFinite(id)) throw new Error('id required');
      const enabled = !!p.enabled;
      const ok = setAwayContactEnabled(id, enabled);
      if (!ok) throw new Error('contact not found');
      return { id, enabled };
    }

    case 'mark_note_reviewed': {
      const id = typeof p.id === 'number' ? p.id : NaN;
      if (!Number.isFinite(id)) throw new Error('id required');
      const note = markAutoNoteReviewed(id);
      if (!note) throw new Error('note not found');
      void mirrorUpdateNote(note.message_guid, { reviewed_at: note.reviewed_at });
      return { id: note.id, reviewed_at: note.reviewed_at };
    }

    case 'mark_all_notes_reviewed': {
      const unreviewed = listAutoNotes({ reviewed: false, limit: 500 });
      const n = markAllAutoNotesReviewed();
      const reviewedAt = Date.now();
      for (const note of unreviewed) {
        void mirrorUpdateNote(note.message_guid, { reviewed_at: reviewedAt });
      }
      return { marked_reviewed: n };
    }

    case 'delete_note': {
      const id = typeof p.id === 'number' ? p.id : NaN;
      if (!Number.isFinite(id)) throw new Error('id required');
      const before = getAutoNote(id);
      const ok = removeAutoNote(id);
      if (!ok || !before) throw new Error('note not found');
      void mirrorDeleteNote(before.message_guid);
      return { removed_id: id };
    }

    case 'refresh_state': {
      // Force a fresh /state push without changing any local data.
      // Used by the frontend on connect / pull-to-refresh to make sure
      // it's seeing the current snapshot instead of a stale RTDB cache.
      await pushStateSnapshotNow();
      return { refreshed_at: Date.now() };
    }

    case 'register_device_token': {
      // Companion registers an FCM token after the user grants
      // notification permission. Idempotent on the token itself —
      // re-registering the same token updates the existing record.
      const token = typeof p.token === 'string' ? p.token.trim() : '';
      if (!token) throw new Error('token required');
      const ua = typeof p.user_agent === 'string' ? p.user_agent : undefined;
      const out = await saveDeviceToken({ token, user_agent: ua });
      return { device_id: out.device_id };
    }

    case 'unregister_device_token': {
      // Companion unregisters when the user disables notifications.
      // Accepts either device_id (preferred) or raw token.
      const deviceId = typeof p.device_id === 'string' ? p.device_id : '';
      if (!deviceId) throw new Error('device_id required');
      await removeDevice(deviceId);
      return { removed_id: deviceId };
    }

    case 'galt_chat': {
      // Direct chat between the user and Galt (Phase 1: no tools).
      // Flow:
      //   1. Append the incoming user message to /galt_chat/messages.
      //   2. Pull the last N messages (including the one we just
      //      appended) for context.
      //   3. Call chatTurn() — OpenAI generates Galt's reply.
      //   4. Append Galt's reply to /galt_chat/messages.
      //   5. Return both message ids so the companion can correlate.
      const text = typeof p.text === 'string' ? p.text.trim() : '';
      if (!text) throw new Error('text required');

      const db = getMirrorDb();
      if (!db) throw new Error('mirror disabled — chat unavailable');

      const messagesRef = db.ref('/galt_chat/messages');
      const userMsgRef = messagesRef.push();
      await userMsgRef.set({
        role: 'user',
        text,
        ts: Date.now(),
      });

      // Pull the most recent N messages as context. RTDB
      // limitToLast() works because keys are timestamp-ordered.
      const HISTORY_LIMIT = 30;
      const snap = await messagesRef.limitToLast(HISTORY_LIMIT).once('value');
      const history: ChatTurnMessage[] = [];
      snap.forEach((child) => {
        const v = child.val();
        if (v && typeof v.text === 'string' && (v.role === 'user' || v.role === 'galt')) {
          history.push({ role: v.role, text: v.text });
        }
        return false;
      });

      const result = await chatTurn(history);

      const galtMsgRef = messagesRef.push();
      await galtMsgRef.set({
        role: 'galt',
        text: result.reply,
        ts: Date.now(),
        model: result.model,
        usage: result.usage ?? null,
      });

      return {
        user_message_id: userMsgRef.key,
        galt_message_id: galtMsgRef.key,
        reply: result.reply,
      };
    }

    case 'galt_chat_clear': {
      // Wipe the entire chat history. Useful when the user wants to
      // start fresh. No backup; this is a destructive intent.
      const db = getMirrorDb();
      if (!db) throw new Error('mirror disabled');
      await db.ref('/galt_chat/messages').remove();
      return { cleared: true };
    }

    case 'send_test_push': {
      // Smoke test from the Settings sheet — sends a one-shot push
      // to every registered device. Returns the per-device result
      // count so the UI can confirm delivery worked.
      const title = (typeof p.title === 'string' && p.title.trim()) || 'Galt test';
      const body = (typeof p.body === 'string' && p.body.trim()) || 'Push notifications are working.';
      const result = await sendPushToAll({ title, body, click_url: 'https://galt-messages.web.app' });
      return result;
    }

    case 'get_note_source': {
      // Fetch the full source message for an auto-note on demand. Bypass
      // FIREBASE_MIRROR_INCLUDE_MESSAGE_TEXT — that flag controls what
      // gets *persisted* on the open /notes mirror; this is an
      // authenticated request-response over the command bus, returning
      // the cached row from the local app.db.
      const id = typeof p.id === 'number' ? p.id : NaN;
      if (!Number.isFinite(id)) throw new Error('id required');
      const note = getAutoNote(id);
      if (!note) throw new Error('note not found');
      return {
        id: note.id,
        handle: note.handle,
        contact_name: getContactNameForHandle(note.handle),
        message_guid: note.message_guid,
        message_text: note.message_text,
        summary: note.summary,
        category: note.category,
        created_at: note.created_at,
      };
    }

    default:
      throw new Error(`unknown command type: ${type || '(missing)'}`);
  }
}
