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

## Cross-cutting

Tasks that don't fit a single phase — typically infrastructure that
several phases depend on. Use sparingly.

- TASK-100 — Optional `launchd` plist for auto-start on login
- TASK-101 — Vitest harness with synthetic `chat.db` fixture

---

*(Add phases and tasks as the project evolves. Use `/task` to file
tasks; use `/plan` to think through new phases.)*
