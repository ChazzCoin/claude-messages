# Roadmap

Phase-by-phase task registry for this project. Each phase has a name,
a scope paragraph, and an ordered list of tasks. Order implies
suggested ship order.

The skills `/roadmap` (full per-phase view) and `/backlog`
(forward-looking only) parse this file as the source of truth for
which tasks belong to which phase.

For phase scopes only (no task lists), see [`PHASES.md`](PHASES.md).

---

## Phase 1 — Foundation

> **Scope.** Project skeleton — Node/TS server, read-only `chat.db`
> reader, app-owned SQLite for state, AppleScript send wrapper, watcher
> on `chat.db-wal`, OpenAI client stub, Express API surface, static
> serving for the web UI.

Tasks (in suggested ship order):

- TASK-001 — Scaffold backend + frontend foundation *(shipped as chore — see AUDIT)*
- TASK-002 — Drop in artifact HTML and wire it to the API *(shipped — see AUDIT)*

---

## Phase 2 — Live inbox

> **Scope.** Bring the watcher online and stream new messages to the
> browser in real time.

Tasks:

- TASK-010 — Boot-flag the watcher (`ENABLE_WATCHER=1` or always-on)
- TASK-011 — SSE endpoint `/api/stream` with new-message events
- TASK-012 — Frontend subscriber: prepend new messages live

---

## Phase 3 — Two-tier classifier

> **Scope.** Layer the rule engine + OpenAI classifier on top of the
> watcher.

Tasks:

- TASK-020 — Regex pre-filter against `rules` table on watcher emit
- TASK-021 — `classifyIncoming()` real implementation + prompt *(shipped — see AUDIT)*
- TASK-022 — Tag messages in UI (question / scheduling / urgent / …)
- TASK-023 — Cost guardrails: per-day token cap, per-rule cooldown

---

## Phase 4 — Drafts and approve-to-send

> **Scope.** Generate draft replies for classifier-flagged messages,
> queue them for approval, send via AppleScript on click.

Tasks:

- TASK-030 — `draftReply()` real implementation with thread context *(shipped — see AUDIT)*
- TASK-031 — Drafts queue UI: pending list, edit, approve, discard *(partial — list/approve/discard shipped; edit-before-send still pending)*
- TASK-032 — Send-path hardening: error handling, retry, audit log
- TASK-033 — Improve `attributedBody` decode (swap to imessage-exporter
  shell-out or real typedstream lib)

---

## Phase 5 — Richer iMessage send paths

> **Scope.** Lift the AppleScript send wrapper from "text-to-handle"
> to the full surface Apple actually offers: reactions, threaded
> replies, group chats, attachments, effects, mark-read, edit/unsend,
> and call initiation. Several of these double as classifier signals
> (incoming reactions = closure, edits = priority bump).

Tasks (in suggested ship order):

- TASK-052 — Send to a group chat by chat GUID *(prerequisite for most others)*
- TASK-050 — Reactions / tapbacks: send + use as classifier signal
- TASK-051 — Threaded replies: render incoming, send outgoing
- TASK-055 — Mark a thread as read after Galt auto-replies
- TASK-053 — Send attachments (images, files)
- TASK-056 — Edit / unsend our own + treat incoming edits as signal
- TASK-054 — Send with iMessage effect (slam / fireworks / etc.)
- TASK-057 — Initiate FaceTime / phone call from the dashboard

---

## Phase 6 — Multimodal AI enrichment

> **Scope.** Plug the gaps in our message-comprehension pipeline: voice
> messages, image attachments, Apple's pre-extracted Data Detector
> results, and cross-channel context from CallHistory. Today the
> pipeline only sees text; this phase makes everything else first-class.

Tasks (in suggested ship order):

- TASK-063 — CallHistory cross-reference for context enrichment *(small, high leverage)*
- TASK-062 — Apple Data Detector parser (`payload_data` → entities)
- TASK-060 — Whisper transcription for voice messages
- TASK-061 — GPT-4V image understanding for inbound images

---

## Phase 7 — Companion remote control

> **Scope.** Features that elevate the companion PWA from observer + toggle panel to a real action surface: approving task PRs, merging them, and eventually other write operations the owner needs to complete from their phone. Each feature follows the existing Firebase command bus pattern — frontend sends a command, backend executes, pushes updated state.

Tasks (in suggested ship order):

- TASK-064 — Fix companion merge-PR button after new-task creation

---

## Cross-cutting

Tasks that don't fit a single phase — typically infrastructure that
several phases depend on. Use sparingly.

- TASK-100 — Optional `launchd` plist for auto-start on login
- TASK-101 — Vitest harness with synthetic `chat.db` fixture

---

## Phase 7 — Repo Groups & Daily Stand-Up

> **Scope.** Organize repos by project (color-coded groups), add a
> project management UI, fetch commits via GitHub API, and generate a
> freeform daily stand-up from tasks + PRs + commits.

Tasks (in suggested ship order):

- TASK-070 — Rename `company` → `project` across the stack *(prerequisite)*
- TASK-071 — Project group display on companion home screen
- TASK-072 — Project management UI (create / edit / color / assign)
- TASK-073 — GitHub API commit + PR fetcher per repo
- TASK-074 — Daily stand-up generator (freeform prose, companion PWA)

---

## Phase 8 — Persistent Claude Sessions & Action System

> **Scope.** Every repo gets a long-lived Claude session so context
> accumulates across tasks. A unified "Send to Claude" button component
> replaces the hand-rolled per-action patterns. The COS sheet gains a
> direct text input for follow-up prompts. The home screen Claude mic
> gains a repo selector so voice commands route to the right session.

Tasks (in suggested ship order):

- TASK-075 — Persistent repo sessions (DB, session routing, max-turn rollover)
- TASK-076 — Reusable Claude action button component
- TASK-077 — Session input in COS task sheet
- TASK-078 — Repo quick actions on home screen (mic + repo selector)

---

*(Add phases and tasks as the project evolves. Use `/task` to file
tasks; use `/plan` to think through new phases.)*
