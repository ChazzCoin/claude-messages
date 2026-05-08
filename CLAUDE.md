# CLAUDE.md

Working context for Claude Code sessions on this repo. Read this
before making non-trivial changes.

> This file is **project-specific**. It overrides and extends the
> generic foundation in `.claude/task-rules.md`. Update the
> placeholders below for this project. The kit's `/sync` will never
> overwrite this file — it's yours to evolve.

## 🪡 Auto-loaded primitives

Claude Code follows `@`-imports here. The kit ships a set of small
primitive files that should be loaded on every session — leave the
imports below in place unless you've removed the corresponding
file. Delete a line if the file isn't used in this project.

@.claude/welcome.md
@.claude/pact.md
@.claude/mode.md
@.claude/bookmarks.md
@.claude/wont-do.md
@docs/notes/INDEX.md

*Why each one:*
- **`welcome.md`** — first-thing context: where you left off, what's
  in flight. Auto-updated by `/handoff`.
- **`pact.md`** — your working-relationship preferences with Claude.
  Portable across repos.
- **`mode.md`** — currently-active work mode (a *drive*, not a
  filter). Only present when a mode is active.
- **`bookmarks.md`** — curated `path:line` pointers for fast
  orientation.
- **`wont-do.md`** — anti-feature list. Stops relitigating closed
  conversations.
- **`docs/notes/INDEX.md`** — rolling index of `/lessons` notes.

## What this is

`galt` (project codename — was `imsg-ai`) — a single-user, local-only iMessage assistant. Reads
`~/Library/Messages/chat.db` directly (no copy, no sync), routes
incoming messages through a two-tier filter (regex + OpenAI
classification), drafts replies for watched contacts and trigger
patterns, and sends them via AppleScript only after explicit human
approval. Web UI is served from the same Node process at
`http://127.0.0.1:3000`.

The audience is one user (the repo owner). No auth, no TLS, no
multi-user, no cloud deploy. Every design call assumes the box runs
on the owner's Mac and stays there.

**One downstream cloud mirror exists.** `auto_notes` rows are mirrored
to a Firebase Realtime Database (`galt-messages` instance, project
`msb-logistics`) on insert, fire-and-forget, with the raw inbound
`message_text` redacted to `null` by default. SQLite remains the
source of truth. The mirror is for centrally viewing the AI follow-up
queue from a small mobile-designed website hosted at the same Firebase
project. RTDB rules are wide-open during dev — **lock them before
shipping the public frontend**, see "Pause points" below.

## Platform

**Platform:** `web` (Node backend + browser frontend, both local)

A note on the kit's platform prefixes: `web-task-rules.md` was
written for browser-served bundles (React/Vite/etc.). This project
is a Node server that serves a static frontend, so most of that
file is advisory rather than binding. Universal `task-rules.md`
applies.

## Tech stack

- **Runtime:** Node.js ≥ 20 (native fetch, ESM, `fs.watch`)
- **Language:** TypeScript 5 (ESM, `NodeNext`)
- **Dev runner:** `tsx` (no build step in dev — runs `.ts` directly)
- **Server:** Express 4
- **Databases:**
  - `~/Library/Messages/chat.db` — Apple's SQLite, opened
    **read-only**. Never written to.
  - `data/app.db` — project-owned SQLite for drafts, watched
    contacts, rules, and watcher state.
- **SQLite driver:** `better-sqlite3` (synchronous, fast, simple)
- **AI:** `openai` SDK, default model `gpt-4o-mini` (configurable)
- **Send path:** AppleScript via `osascript` shelled out from the
  backend. No npm dep.
- **Watcher:** `node:fs.watch` on `chat.db-wal`.
- **Firebase mirror:** `firebase-admin` SDK writes `auto_notes` to a
  Realtime Database instance (`galt-messages`) under project
  `msb-logistics`. Auth via Application Default Credentials at
  `~/.config/gcloud/application_default_credentials.json` — no creds
  file in the repo. Lazy-init, fire-and-forget. See `server/firebase.ts`.

## Commands

| Purpose | Command |
|---|---|
| **Build** | `npm run build` (tsc → `dist/`) |
| **Run / dev** | `npm run dev` (tsx watch — no build needed) |
| **Test (verification gate)** | `npm run typecheck` (no test framework yet — typecheck + boot is the gate) |
| **Test (focused / watched)** | n/a |
| **Test (parade — final review)** | manual: `npm run dev` + click through `http://127.0.0.1:3000` |
| **Deploy** | n/a (local-only) |
| **Rollback** | `git revert <sha>` |
| **Dependency audit** | `npm audit` |

> **Verification gate (foundation):** `npm run typecheck` returns
> clean **and** `npm run dev` boots without throwing. When real test
> coverage shows up (V1 step 2+), this section gets updated.

## Toolchain pinning

- Node ≥ 20 (no `.nvmrc` yet — add when needed)
- macOS only — AppleScript send and `chat.db` location are Apple-
  specific.

## Folder layout

```
claude-messages/                  # repo root (project name: galt)
├── server/                       # Node/TS backend
│   ├── index.ts                  # Express app, routes, boot/shutdown
│   ├── config.ts                 # env + path resolution
│   ├── db/
│   │   ├── messages.ts           # read-only chat.db reader
│   │   └── app.ts                # app.db (drafts, watched, rules, state)
│   ├── attributedbody.ts         # naive typedstream → text fallback
│   ├── watcher.ts                # fs.watch on chat.db-wal
│   ├── send.ts                   # AppleScript wrapper (Messages.app)
│   └── ai.ts                     # OpenAI client + classify/draft stubs
├── web/                          # static frontend (artifact HTML lives here)
│   └── index.html                # placeholder until artifact drop-in
├── data/                         # gitignored — app.db lives here
├── tasks/                        # PHASES, ROADMAP, AUDIT, backlog/active/done
├── docs/                         # decisions, postmortems, notes, audits, …
├── .claude/                      # kit skills, rules, primitives, modes
├── package.json
├── tsconfig.json
└── CLAUDE.md                     # this file
```

## Schema ownership

This project mirrors **two** schemas, neither of which it owns:

1. **Apple's `chat.db` schema.** Field names (`message.text`,
   `message.attributedBody`, `message.handle_id`, `message.date`,
   `chat_message_join.chat_id`, etc.) are byte-identical to Apple's.
   Never invent or rename. The reader (`server/db/messages.ts`) is
   the single point of contact — if a column or table reference
   needs to change, change it there. Apple may evolve the schema
   across macOS releases; treat unknown columns as a blocker.

2. **OpenAI API schema** — straightforward, owned upstream by
   OpenAI. The wrapper in `server/ai.ts` is the contact point.

This project **owns** its own schema in `data/app.db`. Migrations
live inline in `server/db/app.ts::migrate()`. Add a new table /
column by editing that function — it's idempotent (`CREATE TABLE IF
NOT EXISTS`, etc.).

## Schema registry

- **chat.db queries** — all SQL against Apple's database lives in
  `server/db/messages.ts`. Don't sprinkle `db.prepare(...)` calls
  for `chat.db` elsewhere.
- **app.db queries** — all SQL against the project's own database
  lives in `server/db/app.ts`. Same rule.

## Gated files (project-specific extensions)

In addition to the kit's generic gated-file list:

- `server/db/messages.ts` — touching the chat.db reader has cross-
  cutting impact. Schema misreads = silent data wrongness.
- `server/send.ts` — the AppleScript wrapper. Bad escaping here
  could send a malformed message to the wrong person.
- Anything under `~/Library/Messages/` — **read-only**. Never write.

## Local dev

```bash
# 1. install
npm install

# 2. one-time macOS permissions (System Settings → Privacy & Security):
#    - Full Disk Access → enable for your Terminal/runner
#      (required to read chat.db)
#    - Automation → Messages → enable for your Terminal/runner
#      (required for AppleScript send; first send triggers prompt)

# 3. config
cp .env.example .env
# edit .env if you need OpenAI features (V1 step 3+)

# 4. run
npm run dev
# → http://127.0.0.1:3000
```

## Environment variables

See `.env.example`. All are optional for V0:

- `PORT` (default `3000`), `HOST` (default `127.0.0.1`)
- `CHAT_DB_PATH` (default `~/Library/Messages/chat.db`) — override
  for local testing against a fixture DB
- `APP_DB_PATH` (default `./data/app.db`)
- `OPENAI_API_KEY` — required once V1 step 3 (classification) lands
- `OPENAI_MODEL` (default `gpt-4o-mini`)
- `FIREBASE_MIRROR_ENABLED` (default `true`) — `false` to disable the
  RTDB mirror without touching code. Mirror also lazy-disables itself
  if `applicationDefault()` can't resolve credentials at first call.
- `FIREBASE_DB_URL` (default `https://galt-messages.firebaseio.com/`)
- `FIREBASE_MIRROR_INCLUDE_MESSAGE_TEXT` (default `false`) — when
  `true`, writes the raw inbound iMessage body to RTDB alongside the
  AI-extracted summary. Off by default; turn on only if you need the
  raw text in the central viewer.

## Test infrastructure

No framework yet. The verification gate is `npm run typecheck` plus
a manual boot. When the watcher + AI layers land, add Vitest with
fixture-based tests against a tiny synthetic `chat.db`.

**Test/task pairing:** n/a until tests exist.

## Deploy

**Local-only macOS deploy via `launchd`.** No Docker — Docker won't
work for this app (chat.db is a macOS-specific path; AppleScript /
`osascript` and Messages.app don't exist in a Linux container; macOS
Automation permissions are per-process and don't survive
containerization). The right shape is a per-user `LaunchAgent`.

```bash
# one-time, after npm install + .env populated
./bin/install                         # writes ~/Library/LaunchAgents/com.chazzromeo.galt.plist
                                      # then launchctl load -w (auto-starts at login)
./bin/status                          # confirm it booted + /api/health responding

# day-to-day
./bin/restart                         # after pulling code changes
./bin/logs                            # tail stdout+stderr (Ctrl-C to exit)
./bin/stop / ./bin/start              # manual stop/start

# tear down
./bin/uninstall                       # unload + remove from LaunchAgents
```

**Plist details:** `launchd/com.chazzromeo.galt.plist.template`
defines a LaunchAgent (per-user, NOT a LaunchDaemon — daemons run as
root and lose access to your Full Disk Access + Automation grants).
`bin/install` substitutes the absolute project path into the template
and installs to `~/Library/LaunchAgents/`. `RunAtLoad=true` means it
starts at login; `KeepAlive` restarts on crash but not on clean exit
(so `bin/stop` actually stops it). Logs go to `logs/galt.{out,err}
.log` — gitignored.

**Wrapper script (`bin/run`)** sources nvm, honors `.nvmrc`, runs
`npm install` if `node_modules` is missing, then `exec npm run serve`
(which is `tsx server/index.ts` — no file-watcher, this is a service).

**Permissions — IMPORTANT, this trips people up.** macOS attributes
Full Disk Access **per-binary**. The FDA grant on your Terminal
applies to Terminal-spawned processes; it does NOT inherit to
launchd-spawned processes. After `bin/install`, the service runs Node
directly under `launchd`, so chat.db / AddressBook / chat.db-wal reads
fail with `EPERM` until you also grant FDA to the specific Node binary
the LaunchAgent uses.

`bin/install` prints the exact path to add. Roughly:

1. Open System Settings → Privacy & Security → Full Disk Access
2. Click `+`. In the file picker, press ⌘⇧G and paste the node path
   from `bin/install`'s output (e.g.
   `/Users/chazzromeo/.nvm/versions/node/v22.22.2/bin/node`).
3. `./bin/restart` and `./bin/status` — `chat.db ok` should flip to
   True.

If you upgrade Node via nvm, the path changes and you'll need to
re-grant. To avoid that churn, point the LaunchAgent at a stable Node
path (Homebrew `/opt/homebrew/bin/node`) — would require editing the
wrapper to skip nvm.

**Automation → Messages** is a separate grant. The first time the
service attempts an AppleScript send (away-mode auto-reply, draft
approve, scheduled send), macOS prompts; grant once and it persists.

**To dev locally with hot-reload while the service is also installed:**
`./bin/stop`, then `npm run dev`, then `./bin/start` when done.
Both can't bind port 3000 simultaneously.

## Operations cheat sheet

The dashboard runs as a launchd-managed background service. After the
one-time install, day-to-day management is one of these scripts. **Both
Claude and the human operator should use the same commands** — there's
no "Claude path" vs "manual path."

### Everyday loop (most common)

| intent | command |
|---|---|
| **Make my recent code edits live** (server or web) | `./bin/deploy` |
| **Watch logs live** (Ctrl-C to exit) | `./bin/logs` |
| **One-shot health check** | `./bin/status` |
| **Force a contacts re-read** (after iCloud sync) | `./bin/reload-contacts` |

`./bin/deploy` is the keystone. It typechecks first, fails fast on
errors, restarts the service via `launchctl kickstart -k`, waits for
the new process to come up, prints status, and surfaces only NEW
errors written to the log since this deploy started (so stale prior
errors don't pollute the output).

### Service control

| intent | command |
|---|---|
| Stop (will auto-restart on crash unless uninstalled) | `./bin/stop` |
| Start (after stop) | `./bin/start` |
| Restart in-place (zero-downtime swap) | `./bin/restart` |
| Hot-reload mode for active development | `./bin/stop && npm run dev` (Ctrl-C to exit, then `./bin/start`) |

### One-time setup / teardown

| intent | command |
|---|---|
| Install LaunchAgent (auto-start at login) | `./bin/install` |
| Remove LaunchAgent | `./bin/uninstall` |
| Force fresh `npm install` | `rm -rf node_modules && npm install` |

### When something's wrong

| symptom | diagnostic |
|---|---|
| dashboard not loading | `./bin/status` first |
| `chat.db FAIL: EPERM` | macOS Full Disk Access for the Node binary — see Deploy section above |
| `EADDRINUSE :3000` | another process owns port 3000: `lsof -i :3000` |
| AI features 503 | `OPENAI_API_KEY` missing in `.env` — fix and `./bin/restart` |
| service won't stay up | `./bin/logs` then look at `galt.err.log` |

### What's where

| | |
|---|---|
| LaunchAgent plist | `~/Library/LaunchAgents/com.chazzromeo.galt.plist` |
| Service logs | `logs/galt.{out,err}.log` (gitignored) |
| App database | `data/app.db` (gitignored, persists across reinstalls) |
| User config | `.env` (gitignored, never committed) |
| Service launcher | `bin/run` (called by launchd; sources nvm, exec npm run serve) |

### Notes for Claude (autonomous operation)

When making code changes for the user:

1. Edit files.
2. **Always end with `./bin/deploy`** before declaring done. Don't
   just leave changes on disk — they're not live until the LaunchAgent
   restarts.
3. If `./bin/deploy` fails on typecheck, fix the errors and re-run.
   Do not proceed to other work with a broken build.
4. If `./bin/deploy` succeeds but the status shows something off
   (e.g. `chat.db ok: False` after the user previously had it green),
   investigate before continuing.
5. For data inspection, prefer `curl http://127.0.0.1:3000/api/...`
   over reading SQLite directly — the API does the joins + enrichment
   the UI sees, so it's the most accurate view.

## Conventions

- **`text` first, `attributedBody` as fallback.** Apple stores
  modern message bodies in `attributedBody` (serialized
  `NSAttributedString`). Use `resolveMessageText(text,
  attributedBody)` from `server/attributedbody.ts`. The decoder is
  naive (regex + length-byte parse); plan to swap for
  `imessage-exporter` shell-out or a real typedstream library when
  fidelity matters.
- **Apple time conversion** is centralized in `appleDateToUnixMs()`
  (server/db/messages.ts). Don't reinvent. Heuristic: values >
  10^14 are nanoseconds since 2001-01-01; otherwise seconds.
- **Never auto-send.** Drafts always require explicit user approval
  via `POST /api/drafts/:id/approve`. The send wrapper is intentionally
  decoupled from any AI path.
- **Bind to 127.0.0.1.** This is single-user local-only. If a future
  decision opens it up (e.g. Tailscale + shared-secret), update this
  file.
- **No frontend framework.** `web/` is static HTML/JS/CSS that the
  Express server hands out. The artifact HTML drops directly in.

## Pause points / open questions

- **`attributedBody` decoder fidelity.** The naive extractor in
  `server/attributedbody.ts` works for plain text but misses
  reactions, formatting, URL attribution, and edge cases. Swap
  target: `imessage-exporter` shell-out OR a JS typedstream lib.
  Trigger to address: V1 step 2 (live watcher → AI), where missed
  decodes mean missed routing.
- **Group-chat sender resolution.** `chat_message_join` only links
  the message to a chat — sender within the group comes from
  `message.handle_id`. Verify this is enough for routing decisions
  in groups vs. needing the per-chat participant list.
- **SMS (green-bubble) send reliability.** The AppleScript path
  works for iMessage; SMS via the same `tell application "Messages"`
  is flakier. Decision deferred until first SMS-only contact use
  case.
- **OpenAI cost control.** Two-tier (regex pre-filter then LLM) is
  the design intent. Concrete budget caps and per-rule cooldowns
  not yet implemented.
- **Watcher off by default at boot.** `messageWatcher.start()` is
  not called from `index.ts` yet — needs a configurable flag once
  V1 step 2 wires the routing pipeline.
- **RTDB rules are wide-open.** `galt-messages` has `".read": true`
  and `".write": true` (or equivalent test-mode) during dev. Anyone
  who knows the project ID + database URL can read or overwrite every
  mirrored note. Acceptable for a single-user dev phase; **lock down
  before shipping the public mobile frontend**: backend already writes
  via admin SDK so the rules can drop to `".write": false` + a
  read rule scoped to your Google UID once Firebase Auth is added to
  the frontend. Update this file when the rules tighten.
- **Mirror only fires on insert, not on update.** `reviewed_at`
  changes locally don't propagate to RTDB yet. Add an update path when
  the mobile frontend needs to reflect "reviewed" state.
- **`device_id` is generated lazily** on first auto-note insert and
  persisted forever in `state`. If you need it earlier (e.g. for a
  startup banner), call `getDeviceId()` from `server/db/app.ts` at
  boot.
