import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getMaxMessageRowid, listRecentMessages, type MessageRow } from './db/messages.js';
import { getState, setState } from './db/app.js';

/**
 * Watch chat.db-wal for write events and emit any new messages whose
 * ROWID exceeds the last-seen value. The last-seen value is persisted
 * in app.db so restarts don't reprocess history.
 *
 * V0 wiring: started by index.ts when ENABLE_WATCHER=1 (off by default).
 * V1 step 2 will route emitted messages into the rule engine + AI
 * classifier and the live SSE stream to the browser.
 */

const STATE_KEY_LAST_ROWID = 'watcher.last_message_rowid';
const DEBOUNCE_MS = 250;

type Listener = (msgs: MessageRow[]) => void;

export class MessageWatcher {
  private fsw: FSWatcher | null = null;
  private listeners = new Set<Listener>();
  private debounceTimer: NodeJS.Timeout | null = null;
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

    const walPath = path.join(path.dirname(config.chatDbPath), 'chat.db-wal');
    try {
      this.fsw = watch(walPath, () => this.scheduleDrain());
    } catch (err) {
      console.warn(
        `[watcher] could not watch ${walPath}: ${(err as Error).message}. ` +
          `Watcher disabled. Grant Full Disk Access if this is permission-related.`,
      );
      this.started = false;
    }
  }

  stop(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.fsw?.close();
    this.fsw = null;
    this.started = false;
  }

  onMessages(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private scheduleDrain() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.drain(), DEBOUNCE_MS);
  }

  private drain() {
    try {
      const fresh = listRecentMessages(this.lastRowid, 200);
      if (fresh.length === 0) return;
      const maxId = Math.max(...fresh.map((m) => m.id));
      this.lastRowid = maxId;
      setState(STATE_KEY_LAST_ROWID, String(maxId));
      // Watcher returns DESC; emit in ascending order so listeners process oldest-first.
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
