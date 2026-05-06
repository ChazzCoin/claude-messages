---
name: status
description: Global project snapshot — current production version, latest deploys, recent commits and authors, open PRs, in-flight work, top of the roadmap, doc/audit recency. One pleasant scannable read of "where do things stand right now". Triggered when the user wants a quick situational read — e.g. "/status", "where do things stand", "what's the current state of the project", "give me a snapshot".
---

# /status — Project snapshot

A single readable dashboard of where the project is *right now*.
Production state, in-flight work, recent activity, and what's next.
No editing, no opining — pure situational awareness.

Per CLAUDE.md: honest, calibrated. If a piece of data is stale or
unavailable, say so — don't fabricate.

## Behavior contract

- **Read-only.** Don't edit files, don't commit, don't push. This
  skill answers "where are we?" — it doesn't change anything.
- **Pull from sources of truth, not narratives.**
  - Production version: latest `git tag` matching `v*`
  - Latest commits: `git log` (not your memory)
  - Open PRs: `gh pr list`
  - In-flight tasks: contents of `tasks/active/`
  - Roadmap: `tasks/PHASES.md` + `tasks/ROADMAP.md`
  - Recent activity: top of `tasks/AUDIT.md`
- **Run sources in parallel.** Most of these are independent reads.
  Batch them in one tool-call round.
- **Keep it tight.** This is a snapshot, not a deep-dive. The whole
  thing should fit on roughly one screen of chat.
- **Calibrate.** If `gh` isn't installed or auth has lapsed, say
  "couldn't fetch PR list — `gh` returned X" rather than guessing.
  Same for any other source that fails.
- **No recommendations.** This skill reports state. If the user
  wants advice on what to do next, they'll ask `/plan` or `/stuck`.

## Data to gather (in parallel where possible)

1. **Production state** — `git describe --tags --abbrev=0` for the
   latest semver tag, plus `git log -1 --format="%h %s" <tag>` for
   what shipped at that tag.
2. **Branch state** — current branch name, ahead/behind main,
   `git status` (clean or dirty).
3. **Recent commits** — `git log --oneline -10 --format="%h %an %ar
   %s"` on `main` (or current branch if it's a worktree).
4. **Open PRs** — `gh pr list --json number,title,author,createdAt,isDraft,headRefName`
   then format. If `gh` fails, surface that.
5. **In-flight tasks** — list files in `tasks/active/`. Read the
   first few lines of each to grab title + status.
6. **Top of backlog** — first ~5 items from `tasks/ROADMAP.md`'s
   active phase. Don't render the whole roadmap.
7. **Recent audit entries** — top ~5 entries from `tasks/AUDIT.md`.
8. **Worktrees** — `git worktree list` (one line per worktree;
   useful when there's parallel work).

If a source is missing (no tags yet, no PRs, no active tasks),
render the section with "—" or skip it cleanly. Don't render an
empty heading.

## Output structure

**Catalogue entry.** §2 Live status dashboard (primary, for the
project state row) + §23 Activity timeline (for the AUDIT log).
Markdown tables for commits and PRs (legitimate tabular data,
no catalogue ornament needed). §25 Alert variants only when
something is genuinely off.

Render exactly this shape. The whole report is the response — no
preamble, no closing chat.

````markdown
# Project status · <repo name> · <YYYY-MM-DD>

> **Headline.** <one sentence reading the room. Specific, not
> "things are progressing." e.g. "v1.1.0 in prod, v1.2.0 batch
> merged and pending deploy, 3 active tasks across the inspection
> CRUD slice.">

```
┌─ <repo> · <YYYY-MM-DD HH:MM UTC> ──────────────────────┐
│                                                        │
│  ● Production   v1.1.0  (742b5f1 · 2026-04-27)         │
│  ● Branch       main · clean · 2 ahead of origin       │
│  ● Worktrees    3 active                               │
│  ◐ In flight    3 tasks active                         │
│  ◐ Pending      v1.2.0 batch merged, untagged          │
│                                                        │
│  next · review v1.2.0 batch, then tag and deploy       │
└────────────────────────────────────────────────────────┘
```

*(§2 dashboard. Glyph semantics: ● = current/healthy/known-good,
◐ = active/in-progress, ○ = pending/queued, ✗ = failed/blocked.
Drop rows that don't apply — no pending deploy → skip the Pending
row; no extra worktrees → skip the Worktrees row. Render inside a
code fence so monospace alignment holds.)*

## Recent commits

| SHA | Author | When | Subject |
|---|---|---|---|
| `72c3810` | Chazzcoin | 2h ago | Wire Parts Inventory, Work Orders, … |
| … | … | … | … |

*(Up to 10 commits from main. Truncate subjects at ~60 chars
with `…`.)*

## Open pull requests

| # | Title | Author | Branch | Age |
|---|---|---|---|---|
| [#35](url) | /skills meta-skill | Chazzcoin | chore/skills-meta-skill | 1h |

*(If none: "No open PRs." If `gh` failed: render a §25 WARNING
alert in place of the table.)*

## In flight

Tasks currently in `tasks/active/`:

- **TASK-XXX — <title>** — <one-line status>

*(If empty: "No active tasks — between batches.")*

## Top of roadmap

Next up in the active phase, per `ROADMAP.md`:

- **Phase N — <name>**
  - TASK-XXX — <title>
  - TASK-YYY — <title>

*(Limit to ~5 items. Don't render the whole roadmap.)*

## Recent activity

```
 2026-04-28  ◆  /skills meta-skill added
             │
 2026-04-27  ◆  Released v1.1.0  ·  v1.2.0 batch merged
             │  by chazz · 4f8c3d2
             │
 2026-04-25  ●  TASK-021 shipped
```

*(§23 Activity timeline — top ~5 entries from `tasks/AUDIT.md`.
Glyph semantics: ◆ = informational/release/scaffolding,
● = task ship, ▲ = automated action, ⚠ = incident or hotfix.
Vertical `│` connects events into one narrative.)*

## Anything off

*(Optional. Only render if there's something genuinely worth
flagging — `gh` not installed, dirty working tree on main, a PR
sitting open >7 days, an active task with no recent activity, etc.
If nothing's off, skip this section entirely — don't render an
empty heading just to say "all clear".)*

```
┌─ ⚠  WARNING ──────────────────────────────────────────┐
│  PR #42 open 12 days — feat/notifications             │
│  needs reviewer attention                             │
└───────────────────────────────────────────────────────┘
```

*(§25 Alert variants — INFO `ⓘ` blue / WARNING `⚠` yellow /
ERROR `✗` red. Pick the variant matching severity.)*
````

## Style rules

- **Render structured deliverables per `output-rules.md`.** §2
  dashboard rows use the canonical glyph set (● ◐ ○ ✗); don't
  invent new meanings. §23 timeline uses `◆ ● ▲ ⚠` with the
  semantics above.
- **Tables for tabular data** (commits, PRs). Lists for prose
  bullets (in-flight tasks, roadmap). Catalogue art for the
  dashboard, timeline, and alerts.
- **Relative times for activity** ("2h ago", "yesterday"), absolute
  dates for releases (ISO `YYYY-MM-DD`). Releases are landmarks;
  activity is a stream.
- **Truncate long subjects** at ~60 chars with `…`. The shape of
  the table matters.
- **Calibrate honestly.** If you couldn't fetch something, say so
  in the relevant section with a short reason. Don't fabricate.
  A failed `gh` call becomes a §25 WARNING block, not silence.
- **No closing chat.** End on the last section. The user will
  follow up if they want detail.

## What you must NOT do

- **Don't recommend actions.** "You should deploy v1.2.0" — not
  this skill's job. Report state; let the user decide.
- **Don't editorialize PRs.** Just list them. Reviewing them is
  `/review` or `/ultrareview`.
- **Don't deep-dive any single section.** If the user wants
  details on a PR, an audit entry, or a task, they'll ask. Keep
  the snapshot a snapshot.
- **Don't run write operations** to "tidy up" before reporting.
  If the working tree is dirty, that's part of the status —
  report it, don't clean it.

## When NOT to use this skill

- **Looking at the full roadmap or backlog** → `/roadmap` or
  `/backlog`.
- **Reviewing what shipped historically** → read `tasks/AUDIT.md`
  directly.
- **Code-level "what's going on in this folder"** → `/audit` or
  `/review`.
- **Strategic "what should we do next"** → `/plan`.
- **Filing or moving tasks** → `/task`.

## What "done" looks like for a /status session

A single rendered snapshot. The user reads it, knows where things
stand, and either asks a follow-up or moves on. No file changes,
no git operations beyond reads, no commits.
