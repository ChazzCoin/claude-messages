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

- 🏗 **Right column = thread tool palette + UI polish.** When in thread
  view, the right column hosts the AI toolbar (Draft AI / Summarize /
  Add to Radar / context input), the per-contact memory notes, and the
  custom-prompt compose. Right column collapses entirely outside thread
  views (grid expands main column). The Drafts view's `+ new draft`
  toolbar stays in the main column (it's drafts-specific).
- 🏗 **Visual date+time picker + contact autocomplete.** Custom-built
  calendar grid + AM/PM time + 6 quick presets (in 1h, in 3h, tonight
  8pm, tomorrow 9am, tomorrow 7pm, next week). Used inline in the
  Scheduled view's `+ schedule a message` form and as a modal when
  hitting the **Schedule** action on a draft card. Contact autocomplete
  attaches to any input tagged `data-contact-autocomplete` — wired on
  Watched Contacts, Monitor Rules `scope_handle`, and Away Contacts.
  Server's `/api/contacts` now returns each contact's `handles[]`.
- 🏗 **Away mode (V1).** Toggleable auto-responder. New `away_contacts`
  whitelist + `away_sessions` lifecycle (`greeting_sent` →
  `continuing` → `ended`). Pipeline: opted-in inbound message → if no
  active session, send the canned `away_message` via AppleScript and
  open a session; on subsequent inbound, pull last N messages, build
  thread with voice-profile + contact notes + an away-specific context
  note that forbids fabricating commitments, AppleScript-send the AI
  reply, bump count. Reply-cap safety, `endAllActiveAwaySessions` on
  toggle-off, in-memory `recentAwayAutoSends` ledger to filter our own
  echo (initial bug: AI's own send round-tripped through chat.db's WAL
  and ended its own session; second bug: self-message round-trip
  produced both is_from_me=1 AND is_from_me=0 echoes — the echo guard
  now runs ahead of the direction split and is membership-only with TTL
  cleanup so the same body can match multiple times). Top-bar `away
  mode on` pill, Sessions log in the Away view.
- 🏗 **Auto-Calendar (V1).** New `kind=calendar` on `monitor_rules`
  (the existing form gets a Type dropdown that hides the prompt
  textarea when calendar). For matching incoming messages,
  `extractCalendarEvent` returns structured event data using the
  current local datetime+tz so it can resolve "tomorrow at 7." Pending
  proposals land in `calendar_proposals` (idempotent on
  `source_msg_guid`). New Calendar nav + view (tabs: pending/exported/
  dismissed/all). **Add to Calendar** writes a real `.ics` to /tmp and
  `open`s it — Calendar.app shows the add-event prompt; status flips
  to `exported`.
- 🏗 **Radar (V1) — per-contact memory bank.** New `radar_contacts` +
  `radar_signals` tables. Pipeline: incoming message from a radared
  contact → `extractRadarSignals` (categorized facts: likes /
  dislikes / wants / obsessed / schedule / vacation / gifts / family
  / health / work / other) → idempotent insert. `distillRadarProfile`
  takes existing profile + accumulated signals + user contact-notes
  and produces a narrative "memory bank" — sections for likes, wants,
  schedule, gift ideas, family, etc. New Radar nav + list view +
  detail view (split: editable profile textarea with regenerate
  button, signals timeline with category tabs and per-signal delete).
  Add-to-Radar toggle button in every thread toolbar. SSE
  `radar.signals` event for live updates.
- 🏗 **Schedule send (V1).** New `scheduled_messages` table with
  status (`pending` / `sent` / `failed` / `cancelled`). Background
  scheduler tick every 30s checks for due-and-pending rows and fires
  AppleScript-send. New Scheduled nav + view (tabs + cards with
  cancel + open-thread). Inline `+ schedule a message` form (chat
  picker + body + datetime). Schedule button on every draft card.
  SSE `scheduled.sent` / `scheduled.failed` events.
- 🏗 **Monitor rules + Flags (V1).** Replaced the legacy regex `rules`
  UI with AI-evaluated monitor rules. Each rule has scope
  (`contact` / `unknown` / `all`) + plain-English `prompt` +
  enabled. Watcher fires `evaluateRuleAgainstMessage` per rule per
  matching incoming message; matches go into `flagged_messages`
  (idempotent on rule+message_guid). New Flags nav + view (tabs:
  unreviewed / all) + topbar badge. SSE `flag.new` event.
- 🏗 **Quick summary (V1).** `POST /api/ai/summarize` reads last N
  messages of a chat, returns a bullet-point digest with `→ needs
  reply` markers on actionable items. UI: Summarize button in the
  thread toolbar; result reveals inline below the toolbar.
- 📦 **AI drafts shipped (TASK-021 + TASK-030 ahead of Phase 2).**
  Implemented `classifyIncoming()` (JSON-mode, low temp) and
  `draftReply()` in `server/ai.ts` with a voice-mimicry prompt that
  emphasizes *prediction* over generic helpfulness, an optional
  user-supplied `contextNote`, and a `SKIP` fallback for sensitive
  cases. Added `buildThreadFromMessages()` helper that collapses
  adjacent same-author turns and drops attachment-only messages.
  New routes: `POST /api/ai/classify`, `POST /api/ai/draft`. Both
  gated by `isAIConfigured()` — 503 with a clear "set OPENAI_API_KEY
  in .env" message when not configured. `/api/ai/draft` pulls
  context from chat.db, picks the most-recent incoming message as
  the source guid, calls the model, and optionally saves into the
  drafts queue with a token-usage breadcrumb in `reasoning`.
  *Why ahead of Phase 2:* user wanted drafts now; the watcher is
  still queued. Manual + on-click triggering until SSE lands.
- 🏗 **Inbox-row one-click predict + thread compose-with-context.**
  Sparkle button on every chat row in the inbox view fires
  `/api/ai/draft` with no context note (uses the global setting),
  saves to drafts, refreshes the queue count. Per-row busy/ok/err
  state. Below every thread, a compose textarea + "Draft with
  context" button (⌘+Enter to submit) sends a user hint alongside
  the last N messages.
- 🏗 **Global settings system.** `state` table now backs typed
  settings with `getSettings()` / `updateSettings()` helpers and
  bounds metadata in `db/app.ts`. New routes `GET /api/settings`
  and `PUT /api/settings`. First setting: `ai_context_count`
  (default 20, range [1, 100]). `/api/ai/draft` uses it as the
  default context window. Settings nav-item now wired to a Settings
  view with a numeric editor + reset-to-defaults + a read-only
  System panel mirroring `/api/health`. Thread toolbar default and
  AI-button tooltips read from the cached setting.
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
