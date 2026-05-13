# TASK-072 — Project management UI

**Phase:** 7 — Repo Groups & Daily Stand-Up
**Status:** STUB — full spec drafted before implementation

## What

Add a Projects settings screen (accessible from the companion PWA
settings or a dedicated nav entry) where the user can: create a
project with a name and hex color, edit a project's name or color,
delete a project (repos in it become ungrouped), and assign/move
repos between projects. Color input uses a small swatchpicker built
from the existing design token palette plus a hex-input fallback.
All mutations go through the `/commands` RTDB bus so the backend
persists them to `app.db` and re-mirrors `/state`.

## Why

Projects are only useful if they're manageable. The UI is the
user-facing control plane for Phase 7's entire grouping model.
Doing this as a companion screen keeps the local web UI's complexity
flat while the mobile-first PWA gets the new surface.

**STATUS: STUB — full spec drafted before implementation**
