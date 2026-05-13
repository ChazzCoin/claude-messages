# 🔖 Bookmarks

Curated `path:line` pointers. Read this on session start to land
oriented instead of grep-scanning. Add anything you find yourself
re-finding.

Format: `[path:line](relative-link) — one-line context`. Keep
entries dense; one line each.

---

## Entry points

- `server/index.ts:1` — Express app, routes, boot/shutdown sequence
- `frontend/galt-messages/js/main.js:1` — companion PWA boot: subscriptions, routing, event wiring

## Architectural seams

- `server/firebase-commands.ts:134` — `/commands` dispatch switch — all RTDB→backend commands live here
- `server/firebase-state.ts:1` — `/state` snapshot builder (debounced push after every mutation)
- `frontend/galt-messages/js/state.js:1` — RTDB subscriptions + `sendCommand` — single source of truth for companion store
- `frontend/galt-messages/js/galt-chat.js:1` — all chat + quick-action logic (voice, memory, claude)

## Quick action pattern

- `docs/decisions/quick-action-pattern.md` — **full spec for building a new quick action**
- `frontend/galt-messages/js/galt-chat.js:1579` — `startClaudeMic` — reference Claude quick action implementation
- `frontend/galt-messages/js/galt-chat.js:1673` — `startMemoryMic` — reference Memory quick action implementation
- `frontend/galt-messages/js/actions.js:36` — where quick action handlers are wired (`claude-mic`, `memory-mic`, etc.)

## Schema / data model

- `server/db/app.ts:1` — `migrate()` owns all app.db DDL; add tables/columns here
- `server/db/messages.ts:1` — read-only chat.db reader — all Apple schema contact here
- `server/db/contacts.ts:1` — AddressBook reader

## The weird stuff

- `frontend/galt-messages/js/firebase.js:1` — `databaseURL` is pinned to `galt-messages` RTDB (not the default `msb-logistics-default-rtdb`) — never change this without reading the CLAUDE.md note
- `frontend/galt-messages/js/galt-chat.js` — always use `querySelectorAll` (not `querySelector`) for panels — mobile + desktop have identical `data-id` values
- `server/watcher.ts:1` — 1.5s polling loop (not fs.watch — see CLAUDE.md for why)

## Configuration

- `.env.example` — all env vars with defaults
- `frontend/galt-messages/js/firebase.js:1` — SDK init + pinned RTDB URL

## Task / streaming infrastructure

- `server/task-runner.ts:1` — `startClaudeTask`, `cancelTask`, subprocess lifecycle
- `frontend/galt-messages/js/galt-chat.js` — `subscribeToTask`, `updateTaskCardRow`, `appendTaskCardEvent`

---

*Bookmarks are project-specific. Edit freely. The kit's `/sync`
won't touch this file. Stale bookmarks are worse than missing ones
— prune when the code moves.*
