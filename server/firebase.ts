// Firebase Realtime Database mirror for auto_notes.
//
// SQLite is the source of truth. This module is a strict downstream
// mirror — fire-and-forget after a successful local insert. A failed
// mirror NEVER blocks the local feature path. If init fails (no creds,
// network unreachable at startup, etc.), the mirror lazy-disables and
// stops trying for the rest of the process lifetime.
//
// Auth: applicationDefault() resolves to the service account JSON at
// ~/.config/gcloud/application_default_credentials.json (project
// msb-logistics, default Compute SA, Editor role). No secrets file in
// the repo.

import { initializeApp, applicationDefault, type App } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
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
    _app = initializeApp({
      credential: applicationDefault(),
      databaseURL: config.firebase.databaseUrl,
    });
    console.log(`[firebase] init ok dbUrl=${config.firebase.databaseUrl}`);
    return _app;
  } catch (err) {
    _disabled = true;
    console.error('[firebase] init failed — mirror disabled for this process:', (err as Error).message);
    return null;
  }
}

export interface MirrorAutoNoteInput {
  note: AutoNote;
  contactName: string | null;
  deviceId: string;
}

export async function mirrorAutoNote(input: MirrorAutoNoteInput): Promise<void> {
  const app = getApp();
  if (!app) return;
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
    await getDatabase(app).ref(`/notes/${key}`).set(payload);
    console.log(`[firebase-mirror] ok noteId=${note.id} key=${key} category=${note.category}`);
  } catch (err) {
    console.error(`[firebase-mirror] failed noteId=${note.id} key=${key}:`, (err as Error).message);
  }
}
