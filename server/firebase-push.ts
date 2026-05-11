// Firebase Cloud Messaging push sender.
//
// Sends web push notifications to the companion PWA via the
// firebase-admin Messaging SDK. Reads registered FCM tokens from
// the same RTDB this project already uses (/devices/<auto_id>),
// which the companion writes to when the user enables notifications.
//
// Token lifecycle:
//   - Companion requests permission, calls getToken(), pushes the
//     token to /commands with type=register_device_token.
//   - firebase-commands.ts dispatches it here via saveDeviceToken,
//     which persists to /devices.
//   - When sendPushToAll() fires, we read /devices, send to each
//     token, and prune any tokens the FCM API reports as invalid
//     (the device was uninstalled / token rotated / etc.).
//
// Auth: shares the same Application Default Credentials path the
// rest of the mirror uses — no new setup. messaging() is part of
// the same firebase-admin App that firebase.ts already initializes.
//
// Fire-and-forget by design: a failed push NEVER blocks the local
// feature path that triggered it. Errors log and move on.

import type { Reference } from 'firebase-admin/database';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';
import { getMirrorDb } from './firebase.js';

/** Per-device record stored at /devices/<auto_id>. */
interface DeviceRecord {
  token: string;
  /** Browser UA string + platform hint, captured at registration time. */
  user_agent?: string;
  /** Unix ms — when this device first registered. */
  registered_at: number;
  /** Unix ms — last successful push (or null if never). */
  last_pushed_at?: number | null;
  /** Last error from FCM (e.g. "registration-token-not-registered").
   *  When present + non-null on a fresh read, we know this token is
   *  dead and skip it (sendPushToAll auto-prunes). */
  last_error?: string | null;
}

let _messaging: Messaging | null = null;
function getFcm(): Messaging | null {
  if (_messaging) return _messaging;
  const db = getMirrorDb();
  if (!db) return null;
  // firebase-admin's Messaging takes the same App that initialized
  // the Database — they share auth.
  _messaging = getMessaging();
  return _messaging;
}

/* ============================================================
   Token persistence
   ============================================================ */

/** Save a device token to RTDB. Idempotent on (token) — if the same
 *  token is registered again, we update the existing record's
 *  registered_at + clear last_error. */
export async function saveDeviceToken(input: {
  token: string;
  user_agent?: string;
}): Promise<{ device_id: string }> {
  const db = getMirrorDb();
  if (!db) throw new Error('mirror disabled — cannot save device token');
  const devicesRef = db.ref('/devices');

  // Look for an existing record with this token (idempotency).
  const snap = await devicesRef.orderByChild('token').equalTo(input.token).limitToFirst(1).once('value');
  let deviceId: string | null = null;
  snap.forEach((child) => {
    deviceId = child.key;
    return true; // stop iteration
  });

  const record: DeviceRecord = {
    token: input.token,
    user_agent: input.user_agent,
    registered_at: Date.now(),
    last_error: null,
  };

  if (deviceId) {
    // Update existing
    await devicesRef.child(deviceId).update({
      user_agent: record.user_agent ?? null,
      registered_at: record.registered_at,
      last_error: null,
    });
    return { device_id: deviceId };
  }

  // New record — let RTDB generate the key
  const newRef = devicesRef.push();
  await newRef.set(record);
  return { device_id: newRef.key! };
}

/** Remove a device by id. Used by an unregister command. */
export async function removeDevice(deviceId: string): Promise<void> {
  const db = getMirrorDb();
  if (!db) return;
  await db.ref(`/devices/${deviceId}`).remove();
}

/** Remove a device by its FCM token (used when FCM tells us a token
 *  is no longer valid). */
async function removeDeviceByToken(token: string): Promise<void> {
  const db = getMirrorDb();
  if (!db) return;
  const snap = await db.ref('/devices').orderByChild('token').equalTo(token).limitToFirst(1).once('value');
  const updates: Record<string, null> = {};
  snap.forEach((child) => {
    updates[`/devices/${child.key}`] = null;
    return false;
  });
  if (Object.keys(updates).length > 0) await db.ref().update(updates);
}

/* ============================================================
   Push send
   ============================================================ */

export interface PushPayload {
  title: string;
  body: string;
  /** Optional structured data the SW can use (e.g. note_id to
   *  deep-link). Stays in payload.data, not payload.notification. */
  data?: Record<string, string>;
  /** Optional URL the user lands on when they tap the notification.
   *  When present, included in payload.data.click_action; the SW
   *  reads it on notificationclick. */
  click_url?: string;
}

export interface PushSendResult {
  sent: number;
  failed: number;
  pruned: number;
  errors: string[];
}

/** Send a push notification to every registered device. Returns a
 *  summary; logs failures. Fire-and-forget at the caller — never
 *  blocks the feature path that triggered the send. */
export async function sendPushToAll(payload: PushPayload): Promise<PushSendResult> {
  const result: PushSendResult = { sent: 0, failed: 0, pruned: 0, errors: [] };

  const fcm = getFcm();
  const db = getMirrorDb();
  if (!fcm || !db) {
    console.warn('[push] mirror disabled — skipping push');
    return result;
  }

  // Pull all registered devices.
  const snap = await db.ref('/devices').once('value');
  const devicesByKey: Record<string, DeviceRecord> = snap.val() || {};
  const entries = Object.entries(devicesByKey);
  if (entries.length === 0) {
    console.log('[push] no devices registered — push skipped');
    return result;
  }

  // Build per-device messages so we can correlate failures back to
  // the right RTDB key for pruning.
  for (const [key, dev] of entries) {
    if (!dev?.token) continue;
    try {
      const data: Record<string, string> = { ...(payload.data || {}) };
      if (payload.click_url) data.click_action = payload.click_url;

      await fcm.send({
        token: dev.token,
        notification: { title: payload.title, body: payload.body },
        data,
        webpush: {
          fcmOptions: payload.click_url ? { link: payload.click_url } : undefined,
        },
      });
      result.sent++;
      // Bump last_pushed_at, clear any prior error.
      void db.ref(`/devices/${key}`).update({
        last_pushed_at: Date.now(),
        last_error: null,
      });
    } catch (err) {
      const code = (err as { code?: string }).code || (err as Error).message;
      result.failed++;
      result.errors.push(`device ${key}: ${code}`);
      // FCM tells us when a token is unrecoverable — prune those.
      const dead = ['messaging/registration-token-not-registered', 'messaging/invalid-argument', 'messaging/invalid-registration-token'];
      if (dead.includes(code)) {
        try {
          await removeDeviceByToken(dev.token);
          result.pruned++;
          console.log(`[push] pruned dead token (${code}) device=${key}`);
        } catch (e) {
          console.error('[push] prune failed:', (e as Error).message);
        }
      } else {
        // Soft error — keep the device but record what went wrong.
        void db.ref(`/devices/${key}/last_error`).set(code);
      }
    }
  }

  console.log(`[push] sent ${result.sent}, failed ${result.failed}, pruned ${result.pruned}`);
  return result;
}
