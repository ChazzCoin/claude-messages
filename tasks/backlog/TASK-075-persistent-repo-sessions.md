# TASK-075 — Persistent Repo Sessions

**Phase:** 8 — Persistent Claude Sessions & Action System
**Status:** FULL SPEC

---

## What

Every registered repo gets one long-lived Claude session, identified by a
UUID stored in a new `repo_sessions` table. When a user sends a task for
a repo, the backend looks up (or creates) that repo's session UUID and
passes it as `--session-id` to the Claude CLI. The session accumulates
context across tasks so Claude already knows the codebase by the second
call.

Max-turn rollover: when a task hits the turn limit, the runner detects it,
rotates the repo's session UUID (so future tasks start fresh), and marks
the task status as `context_limit` rather than `failed` — no red error
card, just a clean stop. Summarization/continuation is explicitly out of
scope for this task.

---

## Why

Right now every `quick_claude` call spawns a cold Claude process. Claude
re-reads `CLAUDE.md`, re-discovers the project layout, and has no memory of
what it just did. A persistent session removes the cold-start tax, improves
cache hit rates, and makes follow-up tasks coherent without the user having
to re-explain context.

---

## Acceptance criteria

1. `getOrCreateRepoSession(repoId)` returns a stable UUID across calls.
   Calling it 10 times for the same repo returns the same UUID.
2. `resetRepoSession(repoId)` returns a new UUID and the old one is gone
   from the DB.
3. A `repo_claude_task` command dispatched with a known `repo_id` starts a
   Claude task with `--session-id <that UUID>` visible in the process args
   (verify via logs).
4. `reset_repo_session` command resets the session and confirms with
   `{ ok: true, new_session_id: <uuid> }`.
5. `/state` RTDB push includes `repo_sessions: [{ id, name, session_id, last_used, task_count }]`.
6. A task that hits max_turns finishes with `status = 'context_limit'`,
   the repo's session_id is rotated, and the next task for that repo gets
   a fresh UUID.
7. A task that fails for a non-turn-limit reason still shows `status = 'failed'`
   (no regression).
8. `npm run typecheck` passes clean after changes.

---

## Files expected to change

### `server/db/app.ts`

**WHAT:** Add `repo_sessions` table to `migrate()`. Add four functions:
`getOrCreateRepoSession`, `touchRepoSession`, `resetRepoSession`,
`getRepoSessions`.

```sql
CREATE TABLE IF NOT EXISTS repo_sessions (
  repo_id     INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  session_id  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  last_used   INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  task_count  INTEGER NOT NULL DEFAULT 0
);
```

```typescript
export function getOrCreateRepoSession(repoId: number): string {
  const db = getAppDb();
  const existing = db.prepare(
    'SELECT session_id FROM repo_sessions WHERE repo_id = ?'
  ).get(repoId) as { session_id: string } | undefined;
  if (existing) return existing.session_id;
  const id = randomUUID();
  db.prepare(
    'INSERT INTO repo_sessions (repo_id, session_id) VALUES (?, ?)'
  ).run(repoId, id);
  return id;
}

export function touchRepoSession(repoId: number): void {
  getAppDb().prepare(
    `UPDATE repo_sessions
     SET last_used = strftime('%s', 'now') * 1000,
         task_count = task_count + 1
     WHERE repo_id = ?`
  ).run(repoId);
}

export function resetRepoSession(repoId: number): string {
  const db = getAppDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO repo_sessions (repo_id, session_id)
     VALUES (?, ?)
     ON CONFLICT(repo_id) DO UPDATE SET
       session_id = excluded.session_id,
       created_at = strftime('%s', 'now') * 1000,
       last_used  = strftime('%s', 'now') * 1000,
       task_count = 0`
  ).run(repoId, id);
  return id;
}

export function getRepoSessions(): Array<{ repo_id: number; session_id: string; last_used: number; task_count: number }> {
  return getAppDb().prepare(
    'SELECT repo_id, session_id, last_used, task_count FROM repo_sessions ORDER BY last_used DESC'
  ).all() as Array<{ repo_id: number; session_id: string; last_used: number; task_count: number }>;
}
```

**WHY:** Source of truth for persistent session IDs. All task dispatch
paths call into these functions; no UUID is generated ad-hoc elsewhere.

---

### `server/task-runner.ts`

**WHAT:** Three changes:

1. Extend `ClaudeTaskInput` with `session_id?: string` and `repo_id?: number`.
2. Pass `session_id` through to `claudeCliStreamer.start()` (it already
   accepts `sessionId` in `ChatTurnOpts`).
3. After the stream loop, detect max-turns condition and rotate session:

```typescript
// Detect: is_error AND numTurns is at or near max_turns cap.
// The CLI exits with is_error=true when --max-turns is exceeded.
const maxTurns = input.max_turns ?? 30;
const hitTurnLimit = sawError && numTurns !== null && numTurns >= maxTurns - 1;

if (hitTurnLimit && input.repo_id) {
  resetRepoSession(input.repo_id);  // rotate for next task
  persistTaskUpdate(task.id, {
    status: 'context_limit',
    result: resultText || 'turn limit reached — session rotated',
    session_id: sessionId,
    model,
    total_cost_usd: totalCostUsd,
    num_turns: numTurns,
  });
  return;
}
```

Also add `'context_limit'` to the `status` enum in `createTask` / `updateTask`
CHECK constraint. Currently `status IN ('queued', 'running', 'succeeded',
'failed', 'cancelled')` → add `'context_limit'`.

**WHY:** Without this, a max-turns stop looks like an error in the UI and
the session remains stale for subsequent tasks.

---

### `server/firebase-commands.ts`

**WHAT:** Add two new cases to the `dispatch` switch.

**`repo_claude_task`** — the primary entry point for all repo-scoped
conversational tasks:

```typescript
case 'repo_claude_task': {
  const repoId = typeof p.repo_id === 'number' ? p.repo_id : NaN;
  if (!Number.isFinite(repoId)) throw new Error('repo_id required');
  const text = typeof p.text === 'string' ? p.text.trim() : '';
  if (!text) throw new Error('text required');

  const repo = getRepo(repoId);
  if (!repo) throw new Error(`repo ${repoId} not found`);
  if (!repo.active) throw new Error(`repo ${repo.name} is inactive`);

  const sessionId = getOrCreateRepoSession(repoId);
  touchRepoSession(repoId);

  const task = startClaudeTask({
    task:       text,
    working_dir: repo.local_path,
    session_id:  sessionId,
    max_turns:   50,
    repo_id:     repoId,
  });
  return { ok: true, task_id: task.id };
}
```

**`reset_repo_session`** — lets the user or a UI button force a fresh
context for a repo:

```typescript
case 'reset_repo_session': {
  const repoId = typeof p.repo_id === 'number' ? p.repo_id : NaN;
  if (!Number.isFinite(repoId)) throw new Error('repo_id required');
  const newId = resetRepoSession(repoId);
  void pushStateSnapshot();
  return { ok: true, new_session_id: newId };
}
```

**WHY:** These are the only two entry points for the new session system.
All existing task dispatch paths (`start_repo_task`, `spec_task`, etc.)
remain unchanged — they use fresh sessions per task since they spawn
worktrees and open PRs.

---

### `server/firebase-state.ts`

**WHAT:** Include repo sessions in the `/state` snapshot. In the
`buildStateSnapshot()` function, add:

```typescript
import { getRepoSessions } from './db/app.js';
import { listRepos } from './db/app.js';

// Inside buildStateSnapshot():
const sessions = getRepoSessions();
const repoNameMap = Object.fromEntries(
  listRepos().map((r) => [r.id, r.name])
);
snapshot.repo_sessions = sessions.map((s) => ({
  id:         s.repo_id,
  name:       repoNameMap[s.repo_id] ?? String(s.repo_id),
  session_id: s.session_id,
  last_used:  s.last_used,
  task_count: s.task_count,
}));
```

**WHY:** The companion needs the repo list + session metadata to populate
the repo selector (TASK-078) and display session info in the settings
panel or repo page.

---

## Test plan

1. **Cold start:** Delete the `repo_sessions` table row for a repo.
   Call `repo_claude_task` — verify a new row is inserted and the task
   starts (check RTDB `/tasks/<id>` flips to `running`).
2. **Continuity:** Send two `repo_claude_task` calls for the same repo.
   Confirm both tasks share the same `session_id` (visible in task rows).
3. **Reset:** Call `reset_repo_session`. Confirm old session_id is gone.
   Send another task — confirm new session_id is used.
4. **Max-turn rollover:** Set `max_turns: 2` and a multi-step prompt.
   Confirm task ends with `status = 'context_limit'`, repo gets a new
   session_id, and the companion card shows a non-error state.
5. **Regular failure:** Kill the Claude binary mid-task. Confirm status
   is `failed`, not `context_limit`, and session is NOT rotated.
6. **`/state` check:** After calling `repo_claude_task`, push state and
   verify `repo_sessions` array appears in RTDB `/state`.

---

## Open questions / risks

- **`status` CHECK constraint is in SQLite.** Adding `'context_limit'` to
  the enum requires a migration guard. `ALTER TABLE` can't change a
  CHECK constraint — need to `DROP + RECREATE` the `tasks` table or use a
  defensive CREATE approach. Simplest: drop the CHECK constraint entirely
  (SQLite doesn't enforce them at the column level anyway when added
  inline). Verify existing migration strategy before touching this.
- **`session_id` in `ClaudeTaskInput.input` JSON:** The `input` column in
  `tasks` stores a JSON blob. `session_id` is not currently in that blob.
  It doesn't need to be persisted there — it's only needed at spawn time.
  Don't add it to the stored input unless a future resume use case requires
  it.
- **Concurrent tasks on the same session:** The Claude CLI doesn't prevent
  two processes from using the same `--session-id` simultaneously. With
  persistent sessions, if the user fires two repo tasks at once, both land
  on the same session and their transcripts interleave. For now, document
  this as a known limitation. A per-repo queue is the fix but is out of
  scope here.
