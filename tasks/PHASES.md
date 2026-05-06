# Phases

High-level phase-only roadmap for this project. Each phase has a
**name**, a **scope paragraph** (2–4 sentences), and a status. The
ordered task list for each phase lives in [`ROADMAP.md`](ROADMAP.md).

This file answers "what's the big picture?" — `ROADMAP.md` answers
"what's in flight?".

---

## How to read this file

- 📋 **Queued** — defined, not started.
- 🚧 **Active** — current work happens here.
- ✅ **Shipped** — phase done; record the version that landed it.

Phases ship in order top-to-bottom, but cross-cutting work (typically
infrastructure or process) can interleave.

---

## Phase 1 — Foundation

**Status:** 🚧 Active

**Scope.** Project skeleton — Node/TS server, read-only `chat.db`
reader, app-owned SQLite for state, AppleScript send wrapper, watcher
on `chat.db-wal`, OpenAI client stub, Express API surface, static
serving for the web UI. **In scope:** the plumbing every later phase
depends on, plus the bare-bones placeholder frontend so artifact HTML
drops in. **Out of scope:** any AI behavior (classification, drafts),
any rule evaluation, any actual message sending. Success: `npm run
dev` boots, `/api/health` returns OK with chat.db readable, and the
artifact HTML can be dropped into `web/` and served.

---

## Phase 2 — Live inbox

**Status:** 📋 Queued

**Scope.** Bring the watcher online and stream new messages to the
browser in real time. **In scope:** wiring `messageWatcher.start()`
into boot, an SSE (or WebSocket) endpoint at `/api/stream`, frontend
JS that subscribes and prepends new messages to the inbox view.
**Out of scope:** any AI processing — the stream is dumb. Success:
sending iMessages to the user shows up in the browser within 1s
without a refresh.

---

## Phase 3 — Two-tier classifier

**Status:** 📋 Queued

**Scope.** Layer the rule engine + OpenAI classifier on top of the
watcher. **In scope:** regex pre-filter (`rules` table) → LLM
classification (`classifyIncoming`) for matched messages or watched
contacts → tagged messages on the frontend (question / scheduling /
urgent / casual / other). **Out of scope:** draft generation. Success:
incoming messages from a watched contact get tagged in the UI within
2s, with cost-per-message kept down by the regex pre-filter.

---

## Phase 4 — Drafts and approve-to-send

**Status:** 📋 Queued

**Scope.** Generate draft replies for classifier-flagged messages,
queue them for approval, send via AppleScript on click. **In scope:**
`draftReply()` implementation, drafts queue UI, edit-before-send,
discard, AppleScript send path under load. **Out of scope:** auto-
send (never), advanced prompt tuning. Success: a flagged message
produces a draft within 5s; one-click approve sends it; sent drafts
appear in the recipient's Messages thread.

---

*(Add phases as the project evolves. Use `/plan` to think through new
phases conversationally; use `/task` to file tasks under existing
phases. Don't create empty phases speculatively — a phase exists
because it has work in it.)*
