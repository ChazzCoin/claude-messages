// RTDB mirror for tasks. Companion + web subscribe to /tasks/<id>
// to see live progress on long-running operations (Claude CLI
// delegations today; future heavy ops slot in unchanged).
//
// Wire shape:
//   /tasks/<id>            — full task row (mirrored from app.db)
//   /tasks/<id>/events/<k> — events stream, keys monotonic
//
// We never read these on the backend — they're write-only from
// here. app.db is the canonical store; clients can also fall back
// to HTTP polling /api/tasks/<id> if RTDB is offline.

import { getMirrorDb } from './firebase.js';
import type { TaskRow, TaskEventRow } from './db/app.js';
import { config } from './config.js';

/** Serialize a TaskRow for RTDB. RTDB rejects `undefined` and treats
 *  null differently from missing — we explicitly stringify so neither
 *  surfaces as a write error. */
function serializeTask(t: TaskRow): Record<string, unknown> {
  return {
    id: t.id,
    type: t.type,
    status: t.status,
    input: t.input,
    source_chat_msg_id: t.source_chat_msg_id ?? null,
    created_at: t.created_at,
    started_at: t.started_at ?? null,
    finished_at: t.finished_at ?? null,
    result: t.result ?? null,
    error: t.error ?? null,
    session_id: t.session_id ?? null,
    model: t.model ?? null,
    total_cost_usd: t.total_cost_usd ?? null,
    num_turns: t.num_turns ?? null,
  };
}

/** Push the full task row to /tasks/<id>. Idempotent overwrite. */
export async function mirrorTask(t: TaskRow): Promise<void> {
  if (!config.firebase.mirrorEnabled) return;
  const db = getMirrorDb();
  if (!db) return;
  try {
    // Use update() so we don't blow away the /events subtree when
    // re-pushing the task row.
    await db.ref(`/tasks/${t.id}`).update(serializeTask(t));
  } catch (err) {
    console.warn(`[firebase-tasks] mirrorTask failed (${t.id}): ${(err as Error).message}`);
  }
}

/** Append one event under /tasks/<id>/events/<auto_id>. Event id from
 *  the DB row is included so clients can dedup if they receive the
 *  same event twice (rare, but possible on listener restart). */
export async function mirrorTaskEvent(ev: TaskEventRow): Promise<void> {
  if (!config.firebase.mirrorEnabled) return;
  const db = getMirrorDb();
  if (!db) return;
  try {
    await db.ref(`/tasks/${ev.task_id}/events`).push({
      id: ev.id,
      kind: ev.kind,
      data: ev.data ?? null,
      ts: ev.ts,
    });
  } catch (err) {
    console.warn(`[firebase-tasks] mirrorTaskEvent failed (task=${ev.task_id}): ${(err as Error).message}`);
  }
}

export interface TaskPr {
  url:       string;
  number:    number;
  title:     string;
  body:      string;
  branch:    string;
  repo_id:   number;
  repo_name: string;
  state:     'open' | 'merged' | 'closed';
}

/** Push PR metadata onto /tasks/<id>/pr. Called after gh pr create
 *  and again after merge/close to update the state field. */
export async function mirrorTaskPr(taskId: string, pr: TaskPr): Promise<void> {
  if (!config.firebase.mirrorEnabled) return;
  const db = getMirrorDb();
  if (!db) return;
  try {
    await db.ref(`/tasks/${taskId}/pr`).set(pr);
    console.log(`[firebase-tasks] PR #${pr.number} mirrored onto task ${taskId}`);
  } catch (err) {
    console.warn(`[firebase-tasks] mirrorTaskPr failed (${taskId}): ${(err as Error).message}`);
  }
}

/** Wipe a task from RTDB. Used for cleanup of old tasks; not called
 *  on normal flow. */
export async function removeMirroredTask(taskId: string): Promise<void> {
  if (!config.firebase.mirrorEnabled) return;
  const db = getMirrorDb();
  if (!db) return;
  try {
    await db.ref(`/tasks/${taskId}`).remove();
  } catch (err) {
    console.warn(`[firebase-tasks] removeMirroredTask failed (${taskId}): ${(err as Error).message}`);
  }
}
