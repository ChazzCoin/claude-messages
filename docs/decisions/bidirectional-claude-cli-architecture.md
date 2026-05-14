# Bidirectional Claude CLI Tunnel — Target Architecture

**Status:** Decision recorded; tasks filed
**Date:** 2026-05-13
**Phase:** 8.5 — Galt CLI Tunnel & Permission Hardening
**Related tasks:** TASK-080 (hooks), TASK-081 (bidirectional + permission modes)

---

## TL;DR

Galt's current Claude CLI integration is **uni-directional**: every COSS
follow-up spawns a fresh `claude -p` subprocess with `--session-id` for
resume. That works but pays a ~1–2s cold-start tax per turn (MCP re-init,
tool catalog reload, system prompt re-apply) and gives no mid-stream
control.

The target architecture adds a **bidirectional** path for
session-shaped workloads (COSS global + per-repo) without removing the
per-turn path used by short, one-shot tasks (deploy, spec, repo task
runs). Routing is by task type at the command router seam — **two
execution models, on purpose**.

Three pieces of supporting work land alongside the unlock:

1. `.claude/settings.json` **hooks** as a deterministic gate layer
   (TASK-080) — ships first, independent of subprocess work; reduces the
   blast radius of `--dangerously-skip-permissions` immediately.
2. A **protocol adapter** isolates Galt's event schema from the
   reverse-engineered NDJSON shape of the CLI (insurance against
   undocumented format changes).
3. A **session supervisor** owns long-lived subprocess lifecycle:
   crash recovery, turn-limit rotation, stdin-write for follow-ups and
   permission approvals.

---

## Static component map

```
┌────────────────────────────────────────────────────────────────────┐
│  Companion PWA — https://galt-messages.web.app                     │
│  ────────────────────────────────────────────────────────          │
│  COSS sheet (sessions) │ COA sheet (task stream) │ Home cards      │
│  Permission approval banner (NEW)                                  │
└────────────────────────────────┬───────────────────────────────────┘
                                 │  Firebase JS SDK (v12)
┌────────────────────────────────▼───────────────────────────────────┐
│  Firebase Realtime Database  (project: msb-logistics)              │
│  ────────────────────────────────────────────────────────          │
│   /commands/<id>           command bus  (req → result)             │
│   /state                   settings + watched + sessions snapshot  │
│   /notes/<guid>            auto-notes feed                         │
│   /tasks/<id>              task row mirror                         │
│   /tasks/<id>/events/<n>   stream events  (NEW granularity)        │
│   /repos/<id>              repo snapshots                          │
│   /permission_requests/<id>   pending approvals  (NEW)             │
└────────────────────────────────┬───────────────────────────────────┘
                                 │  firebase-admin (server-side)
┌────────────────────────────────▼───────────────────────────────────┐
│  Backend  (LaunchAgent — /Users/chazzromeo/ChazzCoin/claude-       │
│   messages, runs as user, Node 22 via nvm)                         │
│  ────────────────────────────────────────────────────────          │
│                                                                    │
│   ┌─────────────────────┐    ┌─────────────────────────────┐      │
│   │ HTTP (Express)      │    │ Firebase listeners          │      │
│   │ - web/ static       │    │ - /commands → dispatch      │      │
│   │ - /api/*            │    │ - /permission_requests/ack  │ NEW  │
│   └──────────┬──────────┘    └────────────────┬────────────┘      │
│              │                                │                    │
│              └───────────┬────────────────────┘                    │
│                          │                                         │
│                ┌─────────▼──────────┐                              │
│                │ Command router    │                               │
│                └──┬──────────────┬─┘                               │
│                   │              │                                 │
│                   │ short tasks  │ session tasks                   │
│                   │              │                                 │
│       ┌───────────▼──────┐   ┌───▼─────────────────────────┐      │
│       │ Per-turn runner  │   │ Session Supervisor (NEW)    │      │
│       │ (existing)       │   │                             │      │
│       │                  │   │ - Map<session_id, Handle>   │      │
│       │ start_repo_task  │   │ - spawn / resume            │      │
│       │ spec_task        │   │ - crash detect + replay     │      │
│       │ create_repo_task │   │ - turn-limit rotation       │      │
│       │ create_repo_phase│   │ - stdin write API           │      │
│       │                  │   │                             │      │
│       │ one shot, exits  │   │ COSS-global + per-repo      │      │
│       └────────┬─────────┘   └────────────┬────────────────┘      │
│                │                          │                        │
│                │ spawn fresh per send     │ keep alive across      │
│                │ stdin: 'ignore'          │ many sends             │
│                │                          │ stdin/stdout: 'pipe'   │
│                ▼                          ▼                        │
│       ┌─────────────────────────────────────────────────┐         │
│       │ Protocol Adapter (NEW — single isolation layer) │         │
│       │ ─────────────────────────────────────────────   │         │
│       │ NDJSON (reverse-engineered CLI shape)           │         │
│       │             ↕                                   │         │
│       │ GaltStreamEvent (our types — stable)            │         │
│       │                                                 │         │
│       │ Permission-request events → /permission_requests│         │
│       │ Approval responses        → child.stdin.write() │         │
│       └────────────────────┬────────────────────────────┘         │
│                            │                                       │
│              ┌─────────────▼──────────────────┐                   │
│              │ Event Persister                │                   │
│              │ ───────────────────────────    │                   │
│              │ SQLite (source of truth)       │                   │
│              │   task_events: every event     │                   │
│              │ RTDB mirror at boundaries:     │                   │
│              │   - tool_use start             │                   │
│              │   - tool_result                │                   │
│              │   - text-block end             │                   │
│              │   - result / error             │                   │
│              │ (NOT per NDJSON line)          │                   │
│              └──────────────┬─────────────────┘                   │
│                             │                                      │
│                             ▼                                      │
│       ┌─────────────────────────────────────────────────┐         │
│       │ SQLite — data/app.db (source of truth)          │         │
│       │ tasks │ task_events │ repo_sessions │ ...        │         │
│       └─────────────────────────────────────────────────┘         │
└────────────────────────────────┬───────────────────────────────────┘
                                 │ subprocess.spawn
                                 ▼
┌────────────────────────────────────────────────────────────────────┐
│  Claude CLI processes                                              │
│  ────────────────────────────────────────────────────────          │
│                                                                    │
│   PER-TURN (deploy, spec, start_repo_task):                        │
│   claude -p PROMPT --output-format stream-json                     │
│        --session-id <uuid>  --worktree NAME                        │
│        --permission-mode acceptEdits  --max-turns 30               │
│        --allowedTools "..."                                        │
│   stdio: ['ignore', 'pipe', 'pipe']   → exits on result event      │
│                                                                    │
│   LONG-LIVED (COSS global + per-repo, NEW):                        │
│   claude -p '' --output-format stream-json                         │
│        --input-format  stream-json    ← the unlock                 │
│        --session-id <uuid>                                         │
│        --permission-mode default      ← never bypass               │
│        --allowedTools "..."                                        │
│   stdio: ['pipe', 'pipe', 'pipe']                                  │
│   stays alive across many user turns; rotated by supervisor        │
│   when --max-turns approaches                                      │
└────────────────────────────────┬───────────────────────────────────┘
                                 │ before any tool fires
                                 ▼
┌────────────────────────────────────────────────────────────────────┐
│  .claude/settings.json hooks  (TASK-080)                           │
│  ────────────────────────────────────────────────────────          │
│  PreToolUse:                                                       │
│    Bash         → audit log every invocation (to logs/audit.log)   │
│    Write/Edit   → block paths outside .git/worktrees/ or repo root │
│    mcp__github  → require gh auth status check before push         │
│  PostToolUse:                                                      │
│    Bash         → if rc != 0, mirror failure event to RTDB         │
│                                                                    │
│  Independent of subprocess model. Survives bidirectional swap.     │
└────────────────────────────────┬───────────────────────────────────┘
                                 │ if hook approves, tool runs against:
                                 ▼
┌────────────────────────────────────────────────────────────────────┐
│  Local machine resources                                           │
│  chat.db (RO) │ AddressBook │ git worktrees │ gh CLI │ Messages.app│
│  Calendar.app │ MCP servers │ deploy hosts (SSH/VPN)               │
└────────────────────────────────────────────────────────────────────┘
```

---

## Hot path — bidirectional COSS send (post-TASK-081)

```
User    Companion       RTDB             Backend                      Claude CLI
 │          │             │                  │                            │
 │  type    │             │                  │                            │
 │  + Send  │             │                  │                            │
 ├─────────▶│             │                  │                            │
 │          │ sendCommand │                  │                            │
 │          │  global_    │                  │                            │
 │          │  claude_task│                  │                            │
 │          ├────────────▶│                  │                            │
 │          │             │  child_added     │                            │
 │          │             ├─────────────────▶│                            │
 │          │             │                  │ Supervisor.lookup(         │
 │          │             │                  │   sessionId)               │
 │          │             │                  │                            │
 │          │             │                  │ alive ─► stdin.write       │
 │          │             │                  │           {"type":"user",  │
 │          │             │                  │            "content":"…"}  │
 │          │             │                  ├───────────────────────────▶│
 │          │             │                  │                            │ thinks
 │          │             │                  │ ◀─── stream-json events ───┤
 │          │             │                  │                            │
 │          │             │                  │ adapter → GaltEvent        │
 │          │             │                  │                            │
 │          │             │ /tasks/<id>/     │                            │
 │          │             │   events/<n>     │ persister: SQLite +        │
 │          │             │ (boundaries)     │   mirror at tool/text      │
 │          │             │◀─────────────────┤   block ends               │
 │          │  snapshot   │                  │                            │
 │          │◀────────────┤                  │                            │
 │ see card │             │                  │                            │
 │ stream   │             │                  │                            │
 │◀─────────┤             │                  │                            │
 │          │             │                  │                            │
 │          │             │                  │ ◀── permission_request ────┤
 │          │             │                  │     Bash: "git push..."    │
 │          │             │                  │                            │
 │          │             │ /permission_     │                            │
 │          │             │  requests/<id>   │                            │
 │          │             │◀─────────────────┤                            │
 │          │ approval    │                  │                            │
 │          │  banner     │                  │                            │
 │◀─────────┤             │                  │                            │
 │          │             │                  │                            │
 │ tap      │             │                  │                            │
 │ Approve  │             │                  │                            │
 ├─────────▶│             │                  │                            │
 │          │ approve_perm│                  │                            │
 │          ├────────────▶│                  │                            │
 │          │             ├─────────────────▶│                            │
 │          │             │                  │ stdin.write(               │
 │          │             │                  │   {"type":"perm_approve",  │
 │          │             │                  │    "id":"..."})            │
 │          │             │                  ├───────────────────────────▶│
 │          │             │                  │                            │ hook fires
 │          │             │                  │                            │   (audit Bash)
 │          │             │                  │                            │ tool runs
 │          │             │                  │ ◀── tool_result event ─────┤
 │          │             │                  │                            │ thinks → text
 │          │             │                  │ ◀── text-block events ─────┤
 │          │             │ events ...       │                            │
 │          │             │◀─────────────────┤                            │
 │          │ render      │                  │                            │
 │          │  text       │                  │                            │
 │◀─────────┤             │                  │                            │
 │          │             │                  │                            │
 │   ── subprocess STAYS ALIVE for next send (no re-spawn cost) ──        │
```

---

## Per-turn flow (preserved for short tasks)

```
User taps "Run" on a task spec
  → start_repo_task command
  → Per-turn runner spawns FRESH subprocess
  → claude exits after result event
  → onComplete callback: git push + gh pr create
  → PR card appears in repo rail
```

Different shape because there's nothing to keep alive. Spawn → exit →
done. The hooks layer fires identically for both paths.

---

## What changed vs. today

| Area                    | Today                                       | After TASK-081                                |
|-------------------------|---------------------------------------------|-----------------------------------------------|
| COSS send               | spawn per turn (`--session-id` resume)      | stdin write to live process                   |
| First-token latency     | ~1–2s cold start each turn                  | ~200ms after first turn                       |
| Mid-turn interrupt      | only `kill -9`                              | send cancel NDJSON, graceful                  |
| Permission boundary     | `--dangerously-skip-permissions` flat       | per-task-type mode + UI approvals             |
| Session rotation        | implicit on process exit                    | explicit supervisor handoff                   |
| Crash recovery          | retry button on `failed`                    | resume from last `session_id`                 |
| Protocol coupling       | NDJSON shape leaks into runner              | adapter is single isolation layer             |
| Tool-call audit         | none                                        | hook writes audit log per Bash                |
| Mirror granularity      | every event line                            | tool-call + text-block boundaries             |

---

## What stayed the same

- **Frontend rendering surface** (COSS, COA, Home cards) — same data
  model, same DOM, no router change.
- **RTDB as the only client-facing transport** — companion never talks
  to backend directly.
- **SQLite as source of truth** — RTDB is mirror, not master. Every
  event hits SQLite first.
- **Per-turn pattern for short tasks** (`start_repo_task`, `spec_task`,
  `create_repo_task`, `create_repo_phase`) — preserved as the right tool
  for one-shot work. Bidirectional offers nothing there.
- **LaunchAgent + `./bin/deploy` operational story** — no daemon shape
  change. Multiple long-lived child processes are still children of one
  Node parent.

**Two execution models, on purpose**, routed by task type at the
command-router seam. Not a migration; a fork.

---

## Decision rationale

### Why hooks first (TASK-080 before TASK-081)

Three reasons:

1. **Asymmetric leverage.** No architectural commitment, ships in a
   week, reduces blast radius of `--dangerously-skip-permissions`
   immediately. Independent of every other piece of work in this doc.
2. **Hooks survive the subprocess-model swap.** Whether a process is
   per-turn or long-lived, hooks fire the same way. Writing them now
   means the bidirectional work doesn't have to think about gate logic
   at all.
3. **Defensible posture during TASK-081.** While we're still flat-
   `--dangerously-skip-permissions`, deterministic Bash + Write/Edit
   gates give us audit + path-scope guarantees that don't depend on the
   model behaving.

### Why one task for bidirectional + permission modes (not two)

The natural surface for per-tool approval prompts in a headless agent
is a `permission_request` event on stdout with a response written back
to stdin. That **is** the bidirectional channel. Permission modes and
bidirectional are coupled by design, not by accident. Shipping
bidirectional first with `--dangerously-skip-permissions` still on would
ship the new path in a worse security posture than the old one — net
negative until the second task lands. One task forces the right
sequencing.

### Why event schema first (inside TASK-081)

The reverse-engineered nature of `--input-format stream-json` means
its NDJSON shape is **insurance** territory, not contract. If Anthropic
changes it, long-lived sessions break in ways that per-turn
`--session-id` resume doesn't (per-turn re-handshakes every call).

Defining Galt's own `GaltStreamEvent` type first — and isolating the
NDJSON↔Galt translation in a single adapter — means the rest of the
stack (persister, mirror, supervisor, UI) is stable across CLI
protocol drift.

### Why two execution models forever

Some task types have **no upside** from bidirectional:

| Task type         | Shape         | Pattern  | Rationale                             |
|-------------------|---------------|----------|---------------------------------------|
| `start_repo_task` | single prompt | per-turn | No follow-up; spawn → exit is right   |
| `spec_task`       | single prompt | per-turn | Same                                  |
| `create_repo_task`| single prompt | per-turn | Same                                  |
| `create_repo_phase`| single prompt| per-turn | Same                                  |
| `repo_claude_task`| conversational| **bidi** | COSS pill → many turns → bidi wins    |
| `global_claude_task`| conversational| **bidi** | COSS Galt pill → same                 |
| `galt_chat`       | OpenAI direct | N/A      | Doesn't use Claude CLI at all         |

Per-turn isn't legacy; it's the right primitive for short work. Both
patterns coexist as first-class.

### Why RTDB mirror at tool-call + text-block boundaries (not every NDJSON line)

Three options were on the table:

- **Every NDJSON line.** Token-by-token render in the UI; 50–200 RTDB
  writes per turn. Too chatty; quota concerns; mostly noise.
- **Terminal events only.** Effectively current behavior; defeats the
  point of bidirectional (no live stream).
- **Tool-call + text-block boundaries** (chosen). ~5–10 writes per
  turn. UI renders coherent timeline: "thinking → ran Bash → wrote file
  → said this." Streamy-feeling without being chatty.

The companion's render layer is built around discrete events with
identity, not a token stream. The chosen granularity matches that
shape.

### Why a session supervisor (separate from the runner)

The per-turn runner's mental model is **fire-and-forget**: spawn,
stream, exit, persist final state. That doesn't survive the move to
long-lived processes because there's no "exit" boundary to anchor on.
Two new responsibilities show up:

1. **Crash recovery.** Per-turn = `null` result → status `'failed'`.
   Bidirectional, if the subprocess dies mid-tool-call, we have partial
   event log in SQLite, no `result` event, no clean way to know if the
   model's last action committed (e.g. a Bash that ran `git push`
   server-side before the parent died). The supervisor detects via
   `child.on('close')` with non-zero exit + no terminal event, writes a
   `crashed` status with last seen `session_id`, exposes a "resume from
   last good state" action that spawns fresh with `--resume <sid>` and
   a synthetic prompt summarizing what's known.
2. **Session rotation.** When `--max-turns` approaches in a long-lived
   process, "rotate" means: close stdin (signal "no more turns"), drain
   stdout to a `result` event, spawn replacement subprocess with a
   *new* session_id, transfer the active COSS pill's binding to it. UI
   must render that as continuity, not as "your session was killed."

Both responsibilities live in the same layer because both are about
"this subprocess's lifecycle is more interesting than the runner
contract allows."

---

## Out of scope

- **Replacing the per-turn pattern.** It's preserved on purpose.
- **Migrating `galt_chat`** away from OpenAI to Claude CLI. Separate
  decision, separate task.
- **Multi-host execution** (deploy hosts vs. dev hosts). The
  per-task-type permission mode story is hostname-agnostic. When/if
  multi-host lands, it routes at the command-router seam, no
  architectural change needed.
- **Hook scripts in Python/Go.** Bash is sufficient for everything
  TASK-080 covers. Cross-language is a later concern.
- **Mid-stream model swap** (Sonnet → Opus etc. during a session).
  CLI doesn't support it cleanly; out of scope.

---

## Open questions / risks

- **`--input-format stream-json` is reverse-engineered.** Anthropic
  may change the NDJSON shape. Mitigation: protocol adapter as
  isolation layer (TASK-081 acceptance criterion).
- **Memory growth in long-lived processes.** Sessions that accumulate
  large context will hit memory pressure before they hit `--max-turns`.
  No mitigation in TASK-081; surface in metrics, address if observed.
- **Hook script portability.** TASK-080 ships Bash hooks. If we later
  want them to run identically on a non-macOS host, rewrite needed.
  Not a concern for current single-host setup.
- **stdin write race conditions.** If two browser tabs send to the
  same COSS pill simultaneously, both writes hit stdin. CLI ordering
  is FIFO so it's not corrupt, but the model sees two user messages
  in a row. Address in TASK-081 by serializing per session_id at the
  supervisor.

---

## References

- TASK-080 — `.claude/settings.json` hooks for defense in depth
- TASK-081 — Bidirectional Claude CLI tunnel + permission modes
- `server/integrations/claude-cli.ts:452` — current `stdio: ['ignore', ...]`
  that closes off stdin
- `server/task-runner.ts:248` — current max-turn rotation logic
  (per-turn shape)
- `server/firebase-commands.ts:325` — `repo_claude_task` case
- `server/firebase-commands.ts:361` — `global_claude_task` case
- `frontend/galt-messages/js/actions.js:372` — COSS send handler
- `docs/decisions/quick-action-pattern.md` — existing pattern doc
  (companion-side quick actions)

---

*This decision doc is the source of truth for the target architecture.
Tasks ground their acceptance criteria here; if a task wants to deviate,
update this doc first.*
