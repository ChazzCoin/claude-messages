// Firebase Realtime Database mirror.
//
// SQLite is the source of truth. Every export here is fire-and-forget —
// a failed mirror NEVER blocks the local feature path. If init fails (no
// creds, network unreachable at startup, etc.), the mirror lazy-disables
// and stops trying for the rest of the process lifetime.
//
// Auth: applicationDefault() resolves to the service account JSON at
// ~/.config/gcloud/application_default_credentials.json (project
// msb-logistics, default Compute SA, Editor role). No secrets file in
// the repo.
//
// RTDB layout under the galt-messages instance:
//   /notes/<message_guid>      auto-notes feed (read-only on frontend)
//   /state                     live snapshot of settings + contacts +
//                              health, written on boot and after every
//                              mutation. Single key — single-user app.
//   /commands/<auto_id>        intents pushed by the frontend; the
//                              listener in firebase-commands.ts picks
//                              them up, applies locally, writes a
//                              result, then deletes the entry.

import { initializeApp, applicationDefault, type App } from 'firebase-admin/app';
import { getDatabase, type Database } from 'firebase-admin/database';
import { config } from './config.js';
import type { AutoNote } from './db/app.js';

let _app: App | null = null;
let _disabled = false;

function getApp(): App | null {
  if (_disabled) return null;
  if (_app) return _app;
  if (!config.firebase.mirrorEnabled) {
    _disabled = true;
    console.log('[firebase] mirror disabled (FIREBASE_MIRROR_ENABLED=false)');
    return null;
  }
  try {
    // projectId is required for FCM Messaging — ADC user credentials
    // (from `gcloud auth application-default login`) don't carry a
    // project id, only service-account JSONs do. RTDB works without
    // it because we pass databaseURL explicitly; Messaging has no
    // equivalent fallback and fails with "Unable to detect a
    // Project Id" if we don't pin it here.
    _app = initializeApp({
      credential: applicationDefault(),
      databaseURL: config.firebase.databaseUrl,
      projectId: 'msb-logistics',
    });
    console.log(`[firebase] init ok dbUrl=${config.firebase.databaseUrl} projectId=msb-logistics`);
    return _app;
  } catch (err) {
    _disabled = true;
    console.error('[firebase] init failed — mirror disabled for this process:', (err as Error).message);
    return null;
  }
}

/** Returns the shared RTDB handle, or null if mirror is disabled.
 *  Used by firebase-state.ts and firebase-commands.ts so they all share
 *  the same App / connection. */
export function getMirrorDb(): Database | null {
  const app = getApp();
  return app ? getDatabase(app) : null;
}

export function isFirebaseEnabled(): boolean {
  return getApp() !== null;
}

export interface MirrorAutoNoteInput {
  note: AutoNote;
  contactName: string | null;
  deviceId: string;
}

export async function mirrorAutoNote(input: MirrorAutoNoteInput): Promise<void> {
  const db = getMirrorDb();
  if (!db) return;
  const { note, contactName, deviceId } = input;

  const payload = {
    schema_version: 1,
    device_id: deviceId,
    source: 'auto_note' as const,
    source_local_id: note.id,
    source_message_guid: note.message_guid,
    source_message_rowid: note.message_rowid,
    source_message_text: config.firebase.includeMessageText ? note.message_text : null,
    handle: note.handle,
    contact_name: contactName,
    summary: note.summary,
    category: note.category,
    reasoning: note.reasoning,
    created_at: note.created_at,
    updated_at: note.created_at,
    reviewed_at: note.reviewed_at,
    deleted_at: null,
  };

  // RTDB key = message_guid. Apple's GUIDs are uppercase hex + hyphens —
  // RTDB-safe and globally unique, so re-mirroring is idempotent even if
  // the local app.db is wiped and re-built.
  const key = note.message_guid;

  try {
    await db.ref(`/notes/${key}`).set(payload);
    console.log(`[firebase-mirror] note set noteId=${note.id} key=${key} category=${note.category}`);
  } catch (err) {
    console.error(`[firebase-mirror] note set failed noteId=${note.id} key=${key}:`, (err as Error).message);
  }
}

/** Patch an existing /notes/<guid> entry — used after review/unreview to
 *  flip reviewed_at + bump updated_at without re-sending the full payload.
 *  No-op if the mirror node doesn't exist (RTDB .update creates fields,
 *  which is what we want — reconverges with the current local state). */
export async function mirrorUpdateNote(
  messageGuid: string,
  patch: Partial<{ reviewed_at: number | null; summary: string; category: string }>,
): Promise<void> {
  const db = getMirrorDb();
  if (!db) return;
  try {
    await db.ref(`/notes/${messageGuid}`).update({
      ...patch,
      updated_at: Date.now(),
    });
    console.log(`[firebase-mirror] note update key=${messageGuid} fields=${Object.keys(patch).join(',')}`);
  } catch (err) {
    console.error(`[firebase-mirror] note update failed key=${messageGuid}:`, (err as Error).message);
  }
}

/** Hard-delete a /notes/<guid> entry — used when the local note is
 *  removed via DELETE /api/auto-notes/:id. */
export async function mirrorDeleteNote(messageGuid: string): Promise<void> {
  const db = getMirrorDb();
  if (!db) return;
  try {
    await db.ref(`/notes/${messageGuid}`).remove();
    console.log(`[firebase-mirror] note delete key=${messageGuid}`);
  } catch (err) {
    console.error(`[firebase-mirror] note delete failed key=${messageGuid}:`, (err as Error).message);
  }
}

/** Overwrite the /state key with a full snapshot. Call after every
 *  settings/contacts mutation and once at boot. The frontend subscribes
 *  to /state and re-renders on every change. */
export async function mirrorState(payload: Record<string, unknown>): Promise<void> {
  const db = getMirrorDb();
  if (!db) return;
  try {
    await db.ref('/state').set(payload);
    console.log(`[firebase-mirror] state set updated_at=${payload.updated_at}`);
  } catch (err) {
    console.error('[firebase-mirror] state set failed:', (err as Error).message);
  }
}
