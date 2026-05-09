import { getMaxMessageRowid, listRecentMessages, type MessageRow } from './db/messages.js';
import { getState, setState } from './db/app.js';

/**
 * Poll chat.db for new messages. Originally used fs.watch on chat.db-wal,
 * but that's unreliable on macOS — SQLite checkpoints recreate the WAL
 * file (inode changes), and FDA-protected filesystem events under
 * ~/Library/Messages/ behave inconsistently across machines. Symptom:
 * watcher boots cleanly, isRunning() returns true, but never emits — and
 * every message-driven feature (away, summon, auto-notes, radar, flags)
 * silently dies. Polling at 1.5s is essentially free (one indexed
 * MAX(ROWID) query per tick) and feels live at human typing speed.
 *
 * Last-seen ROWID is persisted in app.db so restarts don't reprocess
 * history.
 */

const STATE_KEY_LAST_ROWID = 'watcher.last_message_rowid';
const POLL_INTERVAL_MS = 1500;

type Listener = (msgs: MessageRow[]) => void;

export class MessageWatcher {
  private pollTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<Listener>();
  private lastRowid = 0;
  private started = false;

  isRunning(): boolean {
    return this.started;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    const persisted = getState(STATE_KEY_LAST_ROWID);
    this.lastRowid = persisted ? parseInt(persisted, 10) : getMaxMessageRowid();
    if (!persisted) setState(STATE_KEY_LAST_ROWID, String(this.lastRowid));

    this.pollTimer = setInterval(() => this.drain(), POLL_INTERVAL_MS);
    // Don't keep the event loop alive just for the watcher — let the
    // HTTP server / Firebase listener decide when to exit.
    this.pollTimer.unref?.();
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.started = false;
  }

  onMessages(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private drain() {
    try {
      const rawMax = getMaxMessageRowid();
      if (rawMax <= this.lastRowid) return;

      const fresh = listRecentMessages(this.lastRowid, 200);
      // Advance the watermark off the RAW max so tapbacks don't get re-processed
      // every poll (listRecentMessages filters them out of the returned list).
      this.lastRowid = rawMax;
      setState(STATE_KEY_LAST_ROWID, String(rawMax));

      if (fresh.length === 0) return;
      const ascending = fresh.slice().reverse();
      for (const fn of this.listeners) {
        try {
          fn(ascending);
        } catch (err) {
          console.error('[watcher] listener error', err);
        }
      }
    } catch (err) {
      console.error('[watcher] drain failed', err);
    }
  }
}

export const messageWatcher = new MessageWatcher();
