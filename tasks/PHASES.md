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

## Phase 5 — Richer iMessage send paths

**Status:** 📋 Queued

**Scope.** The AppleScript send wrapper currently does text-to-handle
only — a strict subset of what Apple actually supports. This phase
lifts it to the full Messages surface: tapbacks (heart/like/laugh/...),
threaded replies, group-chat sends by chat GUID, file/image
attachments, expressive effects (slam/loud/fireworks/...), mark-thread-
read after auto-replies, edit/unsend within Apple's 2-min/15-min
windows, and FaceTime/phone-call initiation. Several of these double
as inbound classifier signals: an incoming 👍 on Galt's reply means
closure; an incoming edit means the sender cared enough to revise.
**Out of scope:** creating new group chats, group renames/photo
changes. Success: every Galt-originated send can carry the right shape
(reaction, threaded reply, group, attachment, effect) instead of
collapsing to bare text — and every meaningful inbound state change
on a message we sent feeds the classifier.

---

## Phase 6 — Multimodal AI enrichment

**Status:** 📋 Queued

**Scope.** Today the auto-note + draft pipeline only "sees" message
text — voice messages collapse to `[encoded message]`, image
attachments are silent, and Apple's already-extracted Data Detector
entities (dates / addresses / phone numbers / flight numbers / package
tracking) sit in `payload_data` blobs unused. This phase wires Whisper
transcription for audio, GPT-4V description + OCR for images, and a
parser for Apple's native Data Detectors so calendar extraction can
favor free + accurate native data over LLM re-extraction. Also adds
CallHistory cross-reference so drafts know "Mom called twice today,
no callback yet". **Out of scope:** sending voice/video, image
generation, video understanding. Success: voice messages get
transcribed and feed the auto-note pipeline; image attachments get
captioned + OCR'd; Apple's Data Detectors replace the LLM calendar-
extraction call for the easy cases; CallHistory context appears in
identity card and in draft prompts.

---

## Phase 7 — Repo Groups & Daily Stand-Up

**Status:** 📋 Queued

**Scope.** Bring organization and daily narrative to the repo
dashboard. Repos are grouped by `project` (renamed from `company`) —
each project gets a hex color applied to its section divider and repo
card accents on the companion home screen. A project management UI
lets the user create, color, and assign repos to projects. A GitHub
API fetcher pulls yesterday's commits per repo, and a stand-up
generator combines tasks + PRs + commits into a freeform prose
summary the user can copy in one tap. Format stays open-ended so
calendar events and other context can be woven in as the feature
evolves.

**Tasks:** TASK-070, TASK-071, TASK-072, TASK-073, TASK-074

---

*(Add phases as the project evolves. Use `/plan` to think through new
phases conversationally; use `/task` to file tasks under existing
phases. Don't create empty phases speculatively — a phase exists
because it has work in it.)*
