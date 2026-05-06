# Audit log

Append-only chronological record of meaningful actions —
releases, task ships, rule changes, scaffolding events.

Newest entries on top. Each entry is one to a few lines —
*what happened*, *when*, and *where to find the receipts*
(PR numbers, tags, commit SHAs).

The git log is the ground truth; this file is the curated,
human-readable layer on top. Don't log every tweak — log the
things a future reader needs to navigate the project's history.

---

## Maintenance rule

Per `task-rules.md`'s "Audit log" section: every batch closing
report appends entries here for each task that landed and each
deploy that shipped. Process changes (new rules in
`task-rules.md`, new conventions) get their own entries.

The format is loose on purpose — readability beats parseability.
What matters: date, what changed, link to the PR / tag /
commit.

Use ISO dates (YYYY-MM-DD). Don't backdate; if you forgot to
log something, log it today with a "(retroactive)" marker.

Emoji set:
- 🚀 production deploys
- 📦 task ships
- 📜 rule / process changes
- 🏗 major scaffolding
- 🔥 hotfixes
- ⚠️ incidents and honest tradeoff calls

---

## 2026-05-06

- 📦 **TASK-002 — artifact HTML integrated and wired to live API.**
  Replaced the placeholder `web/index.html` with the dashboard design.
  Added a small client-side router (Inbox / Drafts / per-chat thread).
  Inbox lists chats from `/api/chats`; click-through opens the thread
  with messages from `/api/chats/:id/messages`, ordered oldest→newest
  with auto-scroll-to-bottom on open (scrolls `.main`, the actual
  scroll container). Top-bar pills bind to `/api/health`
  (`chat.db`, `watcher`, model, `X drafts pending`). Sidebar Watched
  Contacts and Active Rules now show real data and gain inline
  `+ add` forms with hover-remove (`✕`). Drafts view gets a
  `+ new draft` form (chat picker + body) backed by a new
  `POST /api/drafts` route that auto-resolves the recipient handle
  from the chat row and synthesizes a `manual-…` source guid.
  Approve & send confirms before driving Messages.app via
  AppleScript. Default landing view flips to Inbox so first-run
  users see real data instead of an empty drafts queue.
- 🏗 **Phase 1 foundation scaffolded.** Node 20 + TypeScript + Express
  4 + better-sqlite3 + OpenAI SDK. `server/` contains: read-only
  `chat.db` reader (`db/messages.ts`), app-owned SQLite with
  drafts/watched/rules/state tables (`db/app.ts`), naive
  `attributedBody` decoder, AppleScript send wrapper, `fs.watch`-based
  watcher (not yet booted), OpenAI client stub. Express surface:
  `/api/health`, `/api/chats`, `/api/chats/:id/messages`,
  `/api/messages/recent`, `/api/watched`, `/api/rules`,
  `/api/drafts`, `/api/drafts/:id/{approve,discard}`. `web/` serves
  a placeholder index that auto-checks `/api/health`. Verification
  gate for the foundation: `npm run typecheck` + `npm run dev` boots
  cleanly. Shipped as a single chore — task discipline kicks in from
  TASK-002 onward.
- 🏗 **Project bootstrapped from claude-kit v0.9.1.** `.claude/`
  installed via `bin/init` from a worktree at the v0.9.1 tag (sha
  `620ad508fe01`). Source: https://github.com/ChazzCoin/claude-kit.

---

## What this log is for

- **Project history.** A reviewer who joins later can read this
  top-to-bottom and understand what was built when.
- **Release retrospectives.** Search for a tag (`vX.Y.Z`) to find
  what shipped in it.
- **Process evolution.** Search for "rule added" to see how the
  workflow changed over time.
- **Honest tradeoff record.** When we made an opinionated call,
  the entry here is the receipt.
