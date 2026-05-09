// State snapshot builder for the RTDB /state mirror.
//
// Pulls the user-visible bits of settings + watched contacts + health
// into a single payload and pushes it to /state. Called from boot and
// after every relevant mutation in server/index.ts. Fire-and-forget.
//
// Single key, no device partitioning — galt is single-user / single-
// device. If that ever changes, swap the path to /state/<device_id> and
// add device_id selection on the frontend.

import { getSettings, listAwayContacts, countUnreviewedAutoNotes, getDeviceId, getAiUsageStats } from './db/app.js';
import {
  countActiveAwaySessions,
  countActiveSummonSessions,
} from './db/app.js';
import { getContactNameForHandle } from './db/contacts.js';
import { mirrorState } from './firebase.js';
import { config } from './config.js';
import { isAIConfigured, effectiveModel } from './ai.js';
import { getChatDb } from './db/messages.js';
import { messageWatcher } from './watcher.js';

const SERVER_VERSION = '0.1.0';
const STARTED_AT = Date.now();

interface WatchedContact {
  id: number;
  handle: string;
  label: string | null;
  enabled: boolean;
  contact_name: string | null;
}

interface AiUsageBucket {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

interface StateSnapshot {
  schema_version: 1;
  device_id: string;
  updated_at: number;
  settings: {
    summon_enabled: boolean;
    away_mode_enabled: boolean;
    away_message: string;
    galt_voice_profile: string;
    auto_notes_enabled: boolean;
  };
  watched_contacts: WatchedContact[];
  health: {
    server: 'galt';
    version: string;
    started_at: number;
    chat_db_ok: boolean;
    chat_db_error: string | null;
    openai_configured: boolean;
    watcher_running: boolean;
    away_active_sessions: number;
    summon_active_sessions: number;
    auto_unreviewed_notes: number;
  };
  ai: {
    provider: 'openai';
    model: string;
    today: AiUsageBucket;
    last_30d: AiUsageBucket;
    all_time: AiUsageBucket;
  };
}

function buildSnapshot(): StateSnapshot {
  const s = getSettings();

  let chatDbOk = false;
  let chatDbError: string | null = null;
  try {
    getChatDb().prepare('SELECT 1').get();
    chatDbOk = true;
  } catch (err) {
    chatDbError = (err as Error).message;
  }

  const watched: WatchedContact[] = listAwayContacts().map((c) => ({
    id: c.id,
    handle: c.handle,
    label: c.label,
    enabled: !!c.enabled,
    contact_name: getContactNameForHandle(c.handle),
  }));

  const usage = getAiUsageStats();

  return {
    schema_version: 1,
    device_id: getDeviceId(),
    updated_at: Date.now(),
    settings: {
      summon_enabled: !!s.summon_enabled,
      away_mode_enabled: !!s.away_mode_enabled,
      away_message: s.away_message,
      galt_voice_profile: s.galt_voice_profile,
      auto_notes_enabled: !!s.auto_notes_enabled,
    },
    watched_contacts: watched,
    health: {
      server: 'galt',
      version: SERVER_VERSION,
      started_at: STARTED_AT,
      chat_db_ok: chatDbOk,
      chat_db_error: chatDbError,
      openai_configured: isAIConfigured(),
      watcher_running: messageWatcher.isRunning(),
      away_active_sessions: countActiveAwaySessions(),
      summon_active_sessions: countActiveSummonSessions(),
      auto_unreviewed_notes: countUnreviewedAutoNotes(),
    },
    ai: {
      provider: 'openai',
      model: effectiveModel(),
      today: usage.today,
      last_30d: usage.last_30d,
      all_time: usage.all_time,
    },
  };
}

/** Build a fresh snapshot and push to /state. Fire-and-forget. Errors
 *  are logged inside mirrorState; nothing here throws. Coalesces rapid
 *  bursts (settings save → contact add → setting save) into one push
 *  per ~150ms via a trailing-edge debounce. */
let _pendingTimer: NodeJS.Timeout | null = null;
let _lastPushAt = 0;
const COALESCE_MS = 150;

export function pushStateSnapshot(): void {
  if (!config.firebase.mirrorEnabled) return;
  if (_pendingTimer) return;
  // Trailing-edge: schedule a push, swallow further calls until it fires.
  _pendingTimer = setTimeout(() => {
    _pendingTimer = null;
    _lastPushAt = Date.now();
    try {
      const snapshot = buildSnapshot();
      void mirrorState(snapshot as unknown as Record<string, unknown>);
    } catch (err) {
      console.error('[firebase-state] snapshot build failed:', (err as Error).message);
    }
  }, COALESCE_MS);
  if (_pendingTimer.unref) _pendingTimer.unref();
}

/** Synchronous snapshot push — bypasses the debounce. Used at boot and
 *  during shutdown where we want the state on the wire immediately. */
export async function pushStateSnapshotNow(): Promise<void> {
  if (!config.firebase.mirrorEnabled) return;
  if (_pendingTimer) {
    clearTimeout(_pendingTimer);
    _pendingTimer = null;
  }
  _lastPushAt = Date.now();
  try {
    const snapshot = buildSnapshot();
    await mirrorState(snapshot as unknown as Record<string, unknown>);
  } catch (err) {
    console.error('[firebase-state] snapshot build failed:', (err as Error).message);
  }
}

export function lastStatePushAt(): number {
  return _lastPushAt;
}
