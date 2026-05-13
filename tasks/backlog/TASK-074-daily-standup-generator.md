# TASK-074 — Daily stand-up generator

**Phase:** 7 — Repo Groups & Daily Stand-Up
**Status:** STUB — full spec drafted before implementation

## What

Add a "Generate Stand-Up" action on the companion PWA (per project
group or across all projects). When triggered, the backend aggregates:
active tasks (from `app.db`), open + recently merged PRs, and
yesterday's commits (from TASK-073's RTDB data). This is sent to
OpenAI with a freeform prose prompt — output is a concise stand-up
paragraph (not rigid Yesterday/Today/Blockers sections) that the user
can copy or share. The generated text is displayed in a sheet on the
companion and stored transiently in RTDB under `/standup/latest` so
it's readable across devices. Format stays flexible so calendar
events, meeting notes, or other context can be spliced in later.

## Why

The repo dashboard already aggregates exactly the data a stand-up
needs. Generating the narrative is a one-click step that saves
5–10 minutes of daily mental overhead, and the freeform format
avoids the rigid structure that makes AI stand-ups feel mechanical.

**STATUS: STUB — full spec drafted before implementation**
