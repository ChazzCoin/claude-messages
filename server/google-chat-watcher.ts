// Google Chat watcher — polls watched spaces for new messages at a fixed
// interval, then fans out to registered listeners (same pattern as
// MessageWatcher for iMessage).
//
// Poll interval is 30s (conservative — Chat API has no published rate limit
// but polling too aggressively burns quota and risks 429s).
//
// Watermarks: last-seen message createTime per space, persisted in
// gchat_spaces.last_message_time so restarts don't reprocess history.

import {
  listWatchedSpaces,
  updateGChatSpaceWatermark,
  type GChatSpaceRow,
} from './db/app.js';
import { googleChat, type GChatMessage } from './integrations/google-chat.js';

const POLL_INTERVAL_MS = 30_000;

type GChatListener = (messages: GChatMessage[], space: GChatSpaceRow) => void;

export class GoogleChatWatcher {
  private pollTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<GChatListener>();
  private started = false;
  private polling = false;    // guard against overlapping polls

  isRunning(): boolean {
    return this.started;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // Run immediately on start, then on interval.
    void this.drain();
    this.pollTimer = setInterval(() => void this.drain(), POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
    console.log('[gchat-watcher] started (30s poll)');
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.started = false;
    console.log('[gchat-watcher] stopped');
  }

  /** Register a listener. Returns an unsubscribe function. */
  onMessages(fn: GChatListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private async drain(): Promise<void> {
    if (this.polling) return;   // skip tick if previous one is still running
    this.polling = true;
    try {
      const spaces = listWatchedSpaces();
      if (spaces.length === 0) return;

      for (const space of spaces) {
        await this.pollSpace(space);
      }
    } catch (err) {
      console.error('[gchat-watcher] drain error:', (err as Error).message);
    } finally {
      this.polling = false;
    }
  }

  private async pollSpace(space: GChatSpaceRow): Promise<void> {
    try {
      const messages = await googleChat.listMessages(
        space.name,
        space.last_message_time ?? undefined,
      );
      if (messages.length === 0) return;

      // Advance watermark to the newest message's createTime.
      const newest = messages[messages.length - 1]!;
      updateGChatSpaceWatermark(space.name, newest.createTime);

      console.log(
        `[gchat-watcher] ${messages.length} new message(s) in ${space.display_name || space.name}`,
      );

      for (const fn of this.listeners) {
        try {
          fn(messages, space);
        } catch (err) {
          console.error('[gchat-watcher] listener error:', (err as Error).message);
        }
      }
    } catch (err) {
      // Don't crash the whole watcher if one space fails (auth error,
      // space deleted, network hiccup).
      console.warn(
        `[gchat-watcher] poll failed for ${space.name}: ${(err as Error).message}`,
      );
    }
  }
}

export const googleChatWatcher = new GoogleChatWatcher();
