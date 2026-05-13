# TASK-071 — Project group display on companion home screen

**Phase:** 7 — Repo Groups & Daily Stand-Up
**Status:** STUB — full spec drafted before implementation

## What

On the companion PWA home screen, render repo cards grouped by their
`project` field. Each group gets a color-coded section divider (the
existing `brp-co-divider` pattern) using the project's assigned hex
color. The color is stored per-project in RTDB under `/projects/<id>`
and applied inline on the divider label and as the left-border accent
on every repo card in that group. Ungrouped repos fall into a default
"Personal" group.

## Why

With more repos tracked, the flat list becomes hard to scan. Grouping
by project makes the home screen's information density actually
useful — you see each client/initiative as a coherent unit, not a
shuffled deck.

**STATUS: STUB — full spec drafted before implementation**
