# TASK-070 — Rename `company` → `project` across the stack

**Phase:** 7 — Repo Groups & Daily Stand-Up
**Status:** STUB — full spec drafted before implementation

## What

Rename the `company` field to `project` everywhere it appears: the
`repos` table in `app.db`, the RTDB snapshot schema, the backend repo
watcher/mirror, the companion PWA render/state/actions, and the local
web UI. This is a pure refactor — no behavior change.

## Why

"Company" conflates a grouping concept with an ownership concept.
"Project" is the right word: a project can be a company, a client,
a personal initiative, or any other meaningful grouping. Phase 7
builds on this renamed field, so it must land first.

**STATUS: STUB — full spec drafted before implementation**
