# TASK-073 — GitHub API commit + PR fetcher per repo

**Phase:** 7 — Repo Groups & Daily Stand-Up
**Status:** STUB — full spec drafted before implementation

## What

Add a server-side job (triggered on demand or on a schedule) that
fetches recent commits and open PRs for each tracked repo via the
GitHub REST API (`/repos/{owner}/{repo}/commits` and
`/repos/{owner}/{repo}/pulls`). Results are stored in RTDB under
`/repos/<id>/recent_commits` and supplement the existing
`open_prs` snapshot. Uses the already-configured `gh` CLI's auth
token (via `gh auth token`) so no new credential management is
needed. Commit window: last 24 hours for stand-up generation.

## Why

Stand-up generation (TASK-074) needs commit data that isn't in the
local git clone — it needs author, message, and timestamp from the
canonical remote. The GitHub API is the right source; the `gh` CLI
auth means we get it for free without a new OAuth flow.

**STATUS: STUB — full spec drafted before implementation**
