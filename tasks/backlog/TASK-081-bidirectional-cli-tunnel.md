# TASK-081 — Bidirectional Claude CLI Tunnel + Permission Modes

**Phase:** 8.5 — Galt CLI Tunnel & Permission Hardening
**Status:** FULL SPEC
**Depends on:** TASK-080 (hooks land first for defensible posture during WIP)
**Related:** TASK-079 (COSS wiring — same surface, different layer)

---

## What

Replace COSS / global-Claude-session sends from per-turn subprocess
spawns with a **long-lived, bidirectional `claude -p` subprocess** that
accepts follow-up turns via NDJSON written to stdin. Per-turn tasks
(`start_repo_task`, `spec_task`, `create_repo_task`, `create_repo_phase`)
stay on the existing runner — two execution models, on purpose, routed
by task type.

Five tightly-coupled pieces land together because they have a coherent
delivery contract: you cannot ship any one without the others giving
worse-than-current behavior.

1. **`GaltStreamEvent` schema** — Galt's own internal event types, not
   the CLI's. Stable across CLI NDJSON shape changes.
2. **Protocol adapter** — single isolation layer between the
   reverse-engineered NDJSON shape and Galt's event types. Insurance
   against undocumented format changes.
3. **Session supervisor** — owns long-lived subprocess lifecycle:
   crash recovery, turn-limit rotation, stdin write API, FIFO
   serialization per `session_id`.
4. **Permission modes per task type** + **stdin approval channel** —
   replaces flat `--dangerously-skip-permissions` with per-task-type
   modes; UI approval requests round-trip through RTDB and back to
   subprocess stdin.
5. **RTDB mirror granularity at tool-call + text-block boundaries** —
   not every NDJSON line. SQLite remains source of truth at full
   resolution.

Together these unlock:

- COSS first-token latency drops from ~1–2s (cold start per turn) to
  ~200ms (already warm).
- Mid-stream interrupt becomes graceful (cancel NDJSON, not `kill -9`).
- Per-tool approval becomes a real surface in the companion UI.
- Audit / scope-of-blast posture improves (no more flat
  `--dangerously-skip-permissions` on COSS).

---

## Why

Current state: `server/integrations/claude-cli.ts:452` spawns with
`stdio: ['ignore', 'pipe', 'pipe']` — stdin closed. Every COSS follow-up
spawns a **fresh subprocess** that uses `--session-id` to resume
context. That works, but pays three costs:

1. **Cold start tax per turn.** MCP servers re-init, tool catalog
   reloads, system prompt re-applies. Felt as the ~1–2s gap before
   first token on each send.
2. **No mid-stream interrupt.** Can't say "wait, stop, change
   direction." Only `kill -9`.
3. **No true tunnel.** The "two-way communication tunnel" the user
   asked for is literally `--input-format stream-json` + open stdin —
   that's the architectural unlock.

The full target architecture, decision rationale, and component map
live in `docs/decisions/bidirectional-claude-cli-architecture.md`.
This task implements it.

---

## Scope

**In scope:**

### 0. Test framework scaffolding (prerequisite within this task)

The adapter (step 2) is the first piece of Galt code that needs real
unit tests rather than typecheck + manual boot. CLAUDE.md's note —
"When the watcher + AI layers land, add Vitest" — was always pointing
at this moment. Setup happens *inside* this task because:

- The first real test is the adapter's NDJSON fixture suite (this task).
- A separate "set up testing" task with no consumer would be theoretical.
- The bidirectional path is the first place where a regression in
  parsing silently corrupts state instead of breaking visibly.

Concretely:

- Add `vitest` + `@types/node` dev dependencies (pinned to current
  major).
- `vitest.config.ts` at repo root — ESM, NodeNext resolution, matches
  `tsconfig.json` module config.
- `npm test` script (Vitest in run mode) and `npm test -- --watch`
  for dev.
- One worked example covering the adapter (steps 2 acceptance criteria).
- CLAUDE.md updated: "Test infrastructure" section now points at Vitest
  and explains the fixture-based pattern.
- `./bin/deploy` is unchanged — typecheck remains the deploy gate;
  tests are a separate `npm test` invocation. Adding tests to deploy
  gate is a follow-up decision, not part of this task.

### 1. `GaltStreamEvent` schema

- New file `server/integrations/galt-stream-events.ts` defining
  Galt's internal event union. Fields stable, not coupled to CLI
  NDJSON.
- Event kinds (working list — adjust during impl if needed):
  `init`, `text_block_start`, `text_delta`, `text_block_end`,
  `tool_use`, `tool_result`, `permission_request`, `usage_delta`,
  `result`, `stderr`, `crashed`.
- Each event carries `session_id`, `task_id` (if known),
  `sequence_n` (monotonic per-task).

### 2. Protocol adapter

- New file `server/integrations/claude-cli-adapter.ts`.
- Exports `parseCliLine(line: string): GaltStreamEvent | null` —
  the only function that knows the CLI's NDJSON shape.
- Exports `encodeUserTurn(text: string): string` and
  `encodePermissionDecision(id: string, approved: boolean):
  string` — the only functions that know how to write to CLI stdin.
- Existing parsing in `claude-cli.ts:480` (`parseStreamJsonLine`)
  gets factored out into this adapter. No behavior change for the
  per-turn path during this step — just refactor.
- Adapter has its own unit tests against captured NDJSON fixtures
  (one fixture per event kind).

### 3. Session supervisor

- New file `server/session-supervisor.ts`.
- Class `SessionSupervisor` with:
  - `getOrStart(sessionId: string, config: SessionConfig): Handle`
    — returns a live handle, spawning a fresh subprocess if not
    already alive.
  - `Handle.sendTurn(text: string): Promise<void>` — serializes
    write through a per-handle queue (no interleaved writes on
    the same stdin).
  - `Handle.sendPermissionDecision(id, approved): Promise<void>`.
  - `Handle.events: AsyncIterable<GaltStreamEvent>`.
  - `Handle.cancel(): void` — SIGTERM, then SIGKILL after 2s.
- Crash recovery:
  - On `child.on('close')` with non-zero exit + no terminal
    event: write `crashed` status, persist `last_seen_session_id`,
    drop from live map.
  - Companion shows "session crashed — resume?" CTA. On tap, supervisor
    spawns fresh with `--resume <session_id>` and a synthetic
    "continuing prior session" prompt.
- Turn-limit rotation:
  - Supervisor counts `num_turns` from `usage_delta` events. At
    `max_turns - 1`, marks the handle "rotating", drains current
    in-flight turn to its `result` event, gracefully closes stdin,
    rotates the `repo_sessions` UUID via existing
    `resetRepoSession(repoId)` helper, spawns replacement with new
    session_id, emits `session_rotated` event so UI shows
    continuity.
- FIFO serialization: writes to `stdin` go through a per-handle
  Promise chain. Concurrent `sendTurn` calls queue, don't
  interleave.

### 4. Permission modes + stdin approval channel

- Per-task-type config table in `server/firebase-commands.ts`:

  | Task type            | Permission mode     | Path                  |
  |----------------------|---------------------|-----------------------|
  | `start_repo_task`    | `acceptEdits`       | per-turn (existing)   |
  | `spec_task`          | `acceptEdits`       | per-turn (existing)   |
  | `create_repo_task`   | `acceptEdits`       | per-turn              |
  | `create_repo_phase`  | `acceptEdits`       | per-turn              |
  | `repo_claude_task`   | `default`           | **bidirectional**     |
  | `global_claude_task` | `default`           | **bidirectional**     |

- `--dangerously-skip-permissions` removed everywhere.
  `--permission-mode` passed explicitly based on task type.
- Permission request events flow:
  CLI stdout → adapter → `permission_request` event → write to
  `/permission_requests/<request_id>` in RTDB → companion subscribes
  and renders approval banner → user taps → companion writes to
  `/commands/<id>` with `type: approve_permission` / `deny_permission`
  → backend dispatcher routes to supervisor →
  `Handle.sendPermissionDecision(id, approved)` →
  adapter encodes NDJSON → stdin write.
- New companion components:
  `frontend/galt-messages/js/components/permission-banner.js`
  — renders pending request, Approve / Deny buttons. Auto-dismisses
  on result.

### 5. RTDB mirror granularity

- Event persister persists **every** event to SQLite
  `task_events` (no behavior change).
- Mirror to RTDB only at boundaries:
  - `init`
  - `text_block_end` (the full text block, not deltas)
  - `tool_use` start
  - `tool_result`
  - `permission_request`
  - `result`
  - `crashed`
  - `session_rotated`
- `text_delta` events stay in SQLite only. UI re-renders from
  `text_block_end` mirror, not from deltas.
- Companion's `renderTaskCard` updated accordingly: removes any
  per-delta rendering paths (if present); renders from the
  boundary events.

### 6. Migration / routing

- `firebase-commands.ts::dispatch`:
  - `repo_claude_task` and `global_claude_task` cases route to
    `sessionSupervisor.getOrStart(...).sendTurn(text)` instead of
    `startClaudeTask({...})`.
  - All other task types unchanged.
- `claudeCliStreamer.start(...)` (per-turn) keeps working as-is.
  No code removal, just diverted callers.
- `task-runner.ts` unchanged for per-turn case.

**Out of scope (explicit):**

- Replacing per-turn for `start_repo_task` / `spec_task` /
  `create_repo_task` / `create_repo_phase`. They stay per-turn forever.
- Migrating `galt_chat` from OpenAI to Claude CLI. Separate decision.
- Multi-host routing (deploy hosts vs dev hosts). Per-task-type
  permission mode is hostname-agnostic; multi-host is a later
  routing concern.
- Auth on `/permission_requests/*` (RTDB rules are wide-open today;
  separate hardening task).
- Memory pressure mitigation for long-running sessions. Add metrics,
  address if observed.
- Sonnet → Opus mid-session swap. CLI doesn't support cleanly.
- Token-by-token rendering in the UI. We chose tool-call + text-block
  granularity.
- Removing `parseStreamJsonLine` callers in the per-turn path beyond
  what step 2 above requires — refactor only as needed for the
  adapter extraction.

---

## Files expected to change

### New

- `vitest.config.ts` — test runner config (root)
- `server/integrations/galt-stream-events.ts` — event schema
- `server/integrations/claude-cli-adapter.ts` — NDJSON↔Galt
  translation
- `server/integrations/claude-cli-adapter.test.ts` — fixture-based
  unit tests
- `server/session-supervisor.ts` — long-lived subprocess manager
- `frontend/galt-messages/js/components/permission-banner.js`
- `tests/fixtures/cli-stream/*.ndjson` — captured CLI output
  fixtures (one per event kind)

### Modified

- `package.json` — `vitest` + `@types/node` dev deps; `test` script
- `tsconfig.json` — only if Vitest config needs a `types` adjustment
- `server/integrations/claude-cli.ts`
  - Factor `parseStreamJsonLine` out into the adapter
  - Per-turn `start(...)` keeps `stdio: ['ignore', 'pipe', 'pipe']`
  - Remove `--dangerously-skip-permissions`; add `--permission-mode`
    parameter
- `server/firebase-commands.ts`
  - `repo_claude_task` and `global_claude_task` route to supervisor
  - New cases: `approve_permission`, `deny_permission`
  - Per-task-type permission-mode config table
- `server/firebase-state.ts` — add live session count to
  `/state` snapshot
- `server/firebase-tasks.ts` — adjust mirror to fire only on
  boundary events (granularity decision)
- `server/index.ts` — wire supervisor into boot/shutdown
- `server/db/app.ts` — possibly add `crashed_at` column to `tasks`
  if not already present; add `last_seen_session_id` field
- `frontend/galt-messages/js/state.js` —
  `/permission_requests/<id>` subscription
- `frontend/galt-messages/js/actions.js` — `approve-permission` /
  `deny-permission` handlers
- `frontend/galt-messages/js/render.js` — `renderPermissionBanner`
  hookup; remove any per-delta rendering paths
- `frontend/galt-messages/index.html` — banner mount point
- `frontend/galt-messages/styles.css` — banner styling
- `CLAUDE.md` — update Conventions section with the two-path
  routing rule
- `tasks/PHASES.md` — Phase 8.5 entry references this task
- `docs/decisions/bidirectional-claude-cli-architecture.md` —
  update with any decisions that shifted during implementation

---

## Acceptance criteria

### Test framework scaffolding (step 0)

1. **`npm test` runs.** Exits 0 when all tests pass, exits non-zero
   on any failure. ESM resolution matches `tsconfig.json` (no
   `Cannot find module` errors from extension-less imports).
2. **`npm test -- --watch` works** for dev iteration.
3. **CLAUDE.md "Test infrastructure" section** points at Vitest and
   describes the fixture pattern. No stale "no framework yet" text
   remains.
4. **`./bin/deploy` unchanged.** Typecheck stays the deploy gate.
   Tests run separately via `npm test`. (Adding tests to the deploy
   gate is explicitly a follow-up, not this task.)

### Adapter isolation (step 2)

5. **Single point of CLI shape knowledge.** `grep -r
   "parseStreamJsonLine\|stream-json\|NDJSON shape"` in `server/`
   returns matches **only** in
   `server/integrations/claude-cli-adapter.ts` and its test file.
6. **Adapter fixture coverage.** One fixture file per event kind
   under `tests/fixtures/cli-stream/`. `npm test` passes 100% on
   adapter unit tests.
7. **Per-turn path unchanged.** `start_repo_task` and `spec_task`
   work end-to-end after the refactor. Diff in their event log
   shape is zero against a captured baseline.

### Session supervisor (step 3)

8. **Long-lived subprocess.** Sending three COSS messages in a row
   spawns **one** subprocess (verify via `ps aux | grep claude`
   between messages — same PID across the three sends).
9. **First-token latency.** Time-to-first-token on the second and
   third sends is < 500ms. (First send is still cold; that's
   acceptable.)
10. **Crash recovery.** Manually `kill -9` the subprocess mid-turn.
    Task transitions to `crashed` status within 5s. Companion shows
    "session crashed — resume?" CTA. Tapping it spawns a fresh
    subprocess with `--resume <session_id>`. The model picks up
    coherent context.
11. **Turn-limit rotation.** Force a session to `max_turns - 1`
    (e.g. with `--max-turns 5` test config). On the rotation turn,
    subprocess gracefully exits, replacement spawns with new
    `session_id`, companion shows the COSS pill as continuous (no
    error toast). Old session_id is no longer in `repo_sessions`.
12. **FIFO write serialization.** Open two browser tabs to the
    same COSS pill. Trigger sends from both in the same second.
    Both succeed; backend logs show writes serialized (no
    `EPIPE` or interleaved-write errors).

### Permission modes (step 4)

13. **No `--dangerously-skip-permissions` anywhere.** `grep -r
    "dangerously-skip"` in `server/` returns zero matches.
14. **Permission-mode flag per task type.** Inspect a running
    `claude` subprocess's args (via `ps -aux` or proc args dump);
    confirm `--permission-mode <mode>` matches the config table.
15. **Approval round-trip.** Trigger a COSS prompt that requires a
    `Write` to a file inside the repo (mode = `default` means it
    will ask). Companion shows approval banner with the file path.
    Tap Approve. Banner dismisses. Write completes. File on disk
    matches.
16. **Deny round-trip.** Same setup, tap Deny instead. CLI
    receives the denial NDJSON, emits a `tool_result` with
    `is_error: true`, model gracefully handles it ("OK, I'll skip
    that step"). No retry-loop.
17. **Approval timeout.** Don't tap anything for 60s. Banner
    auto-dismisses with a "timed out — denying" toast. Subprocess
    receives a synthetic deny.

### Mirror granularity (step 5)

18. **Boundary-only mirroring.** Capture RTDB writes during a
    typical COSS turn (10 tool calls). Total writes to
    `/tasks/<id>/events/*` ≤ 25 (init + 10 tool_use + 10
    tool_result + 2–3 text blocks + result). Not 200+.
19. **SQLite still full-resolution.** `select count(*) from
    task_events where task_id = '<same task>'` ≥ 200 (every
    text_delta persisted).
20. **UI renders coherent timeline.** COA card for the same task
    shows: thinking text → tool_use → tool_result → next text
    block, in order, no flicker, no missing fragments.

### Migration (step 6)

21. **Per-turn tasks still work.** Sanity smoke: trigger one
    `start_repo_task`, one `spec_task`, one `create_repo_task` —
    all complete end-to-end with no regression.
22. **Two paths visible in logs.** With a per-turn task and a
    COSS task both active, `logs/galt.out.log` shows
    `[claude-cli] start ...` for the per-turn and
    `[session-supervisor] spawn / write ...` for the COSS. Easy
    to tell which path handled which task.

### General

23. **`npm run typecheck` clean.**
24. **`./bin/deploy` clean.** Service comes up green; new errors
    in `logs/galt.err.log` post-deploy = zero.
25. **Hooks from TASK-080 still fire on both paths.** Bash
    audit-log lines appear for both per-turn and bidirectional
    subprocesses.

---

## References

- `docs/decisions/bidirectional-claude-cli-architecture.md` — full
  architectural context (read this first)
- `server/integrations/claude-cli.ts:452` — current `stdio` shape
- `server/integrations/claude-cli.ts:480` — `parseStreamJsonLine`
  (factored out into adapter)
- `server/task-runner.ts:248` — current per-turn rotation logic
  (becomes the supervisor's responsibility in long-lived mode)
- `server/firebase-commands.ts:325` — `repo_claude_task` case
  (routes change here)
- `server/firebase-commands.ts:361` — `global_claude_task` case
  (same)
- `frontend/galt-messages/js/actions.js:372` — COSS send handler
  (no change; the backend reroutes)
- TASK-080 — hooks (lands first)

---

## Test plan

### Pre-impl: fixture capture

Before writing any adapter code, capture **one NDJSON fixture per
CLI event kind** by running `claude -p "test" --output-format
stream-json --verbose` against a scratch directory and saving stdout
to `tests/fixtures/cli-stream/<kind>.ndjson`. These fixtures are
the contract.

### Adapter unit tests

Per event kind, assert:
- `parseCliLine(<line>)` returns the expected `GaltStreamEvent`
  shape.
- Unknown event kinds return `null` (not throw).
- Malformed JSON returns `null`.

### Supervisor unit tests

Mock the subprocess. Assert:
- `sendTurn` writes correctly-encoded NDJSON to stdin.
- Concurrent `sendTurn` calls serialize (second waits for first
  to drain).
- `child.on('close')` without a terminal event → handle goes to
  `crashed`.
- Turn-limit rotation triggers at `max_turns - 1`, not at
  `max_turns`.

### E2E manual

1. **Cold COSS first send.** Time-to-first-token ≤ 2s.
2. **Warm COSS second send.** Time-to-first-token ≤ 500ms.
   Subprocess PID unchanged.
3. **Approval banner.** Triggered, approved, write succeeds.
4. **Denial.** Banner denied, model handles gracefully.
5. **Crash recovery.** Kill subprocess mid-turn, see CTA, resume,
   model picks up.
6. **Rotation.** Force max-turn boundary, replacement spawns,
   UI shows continuity.
7. **Per-turn smoke.** `start_repo_task` end-to-end. PR opens.
   No regression.
8. **Mirror granularity.** Capture RTDB writes during a 10-tool
   turn. Count ≤ 25.
9. **Hook compatibility.** Bash audit-log lines appear from
   bidirectional subprocess.

---

## Manual verification

1. `ps -ax | grep claude` between three COSS sends — same PID.
2. `wc -l logs/audit.log` increases by N lines, where N = Bash
   invocations across all paths.
3. Companion approval banner renders with file path; not just
   "Permission required."
4. `grep -r "dangerously-skip" server/` returns zero.

---

## Open questions / risks

- **NDJSON shape drift.** `--input-format stream-json` is
  reverse-engineered. Mitigation: protocol adapter as isolation
  layer (acceptance criterion 1). When/if it breaks, fix is
  scoped to one file.
- **Memory growth in long-lived processes.** Sessions that
  accumulate large context will hit memory pressure before
  `--max-turns`. No mitigation in this task; add `process.memoryUsage`
  to `/state` snapshot so we see it.
- **stdin write race conditions.** Two browser tabs sending
  simultaneously. Mitigation: per-handle FIFO queue
  (acceptance criterion 8).
- **Permission timeout policy.** 60s chosen for auto-deny — is
  that the right default? Adjustable per task type? Decision:
  60s default, no per-task override in this task; revisit if
  users complain.
- **`/permission_requests/*` RTDB rules.** Today rules are wide
  open. The path is exposed to anyone who knows the project ID.
  Same security posture as the rest of the companion. Don't
  ship public-facing without locking the rules first — separate
  task.
- **Subprocess restart on `./bin/deploy`.** When the LaunchAgent
  restarts, all live sessions die. Companion needs to render
  these as `crashed` with a resume CTA, not silently re-spawn.
  Behavior matches the crash-recovery path.
- **`/api/internal/bash-failure` from TASK-080** must continue
  to work post-this-task. Bidirectional subprocess inherits the
  same hooks; verify in acceptance 21.
- **Subprocess timeout under bidirectional.** Per-turn has a
  15-minute timeout (`task-runner.ts:157`). Bidirectional is
  long-lived by design — what's the equivalent? Decision: no
  total-lifetime timeout. Each *turn* gets 15 minutes from the
  first event after `sendTurn` to the corresponding `result`.
  If a turn hangs, supervisor sends a cancel NDJSON, escalates
  to SIGTERM if still hung.

---

## Blocker notes

(Agent fills this in if it gets stuck. Leave empty when creating.)

---

**Definition of done:**

- All acceptance criteria checked
- Adapter unit tests passing
- E2E manual steps 1–9 above pass
- `./bin/deploy` clean, no new errors in `logs/galt.err.log`
- `docs/decisions/bidirectional-claude-cli-architecture.md`
  updated to reflect any decisions that shifted during impl
- `CLAUDE.md` updated under "Conventions" with the two-path
  routing rule
- `tasks/PHASES.md` Phase 8.5 entry complete
- PR opened, linked from this file, ready for human review
