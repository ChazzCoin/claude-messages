# Git Flow Rules

These five rules govern branching, merging to `main`, deploy tagging,
and where deploy commands are allowed to run. They protect the
project from agents (Claude included) silently shipping code, merging
unreviewed work into `main`, or deploying without authorization.
**Read this file before any task that touches branches, merges, or
deploys.** It extends `task-rules.md`; the rules are non-negotiable
and apply to every Claude session, every project, every release.

## Git flow discipline (the safety rules)

Five non-negotiable rules. They protect the project from agents
(Claude included) silently shipping code, merging unreviewed work
into `main`, or deploying without authorization. Read these
before any task that touches branches, merges, or deploys.

### Rule 1 — Always branch

**Every change starts on a new branch.** Never edit code on
`main`, never edit code on a release branch you didn't cut, never
edit code on someone else's branch unless the user has explicitly
handed it off to you.

Naming:

| Pattern | Use |
|---|---|
| `task/TASK-XXX-short-slug` | Per-task work (the default) |
| `chore/<slug>` | Non-task work — docs, scaffolding, dep upgrades |
| `hotfix/HOTFIX-NNN-slug` | Emergency production fixes |
| `feat/<slug>` | Feature work bigger than one task or spanning tasks |
| `proto/<slug>` | Prototype work (per `/prototype`) |
| `integration/<range>` | Multi-task integration branch (per Batch handoff) |

If you can't decide which prefix applies, ask. Don't guess.

### Rule 2 — Never merge to `main` without explicit user confirmation

`main` is the release branch. The protection lives in this rule,
not in GitHub config (the kit doesn't touch repo settings).

- **No skill auto-merges to `main`.** Every merge is a user-
  confirmed action in chat. Acceptable phrasings: "yes merge",
  "ship it", "merge integration → main", "go".
- **No agent runs `git push origin main` without confirmation.**
  Even if the merge has already been approved on GitHub.
- **No "while you're in there" merges.** If you notice main is
  behind, don't fast-forward silently. Ask first.

The only way `main` updates is: user says yes, agent (or user)
merges. Otherwise `main` does not move.

### Rule 3 — Tag every deploy ("tag and bag")

Every successful deploy from `main` is annotated-tagged with a
semver version. No exceptions. The tag is the version-controlled
record of what shipped — `git log --tags` becomes the deploy
history.

The phrase **"tag and bag"** is the operational shorthand: tag
the commit (`git tag -a vX.Y.Z`), bag the app (build the
container or artifact), deploy it. The full sequence — merge →
build → deploy → tag → push tag → AUDIT entry — is what
`/release` orchestrates.

Format, version-bump heuristics, and message body shape: see
"Production deploy tagging (mandatory)" below.

### Rule 4 — Protect `main` like it's prod

`main` reflects production state. Treat any change touching it
with the same care as a deploy:

- **Treat any merge to `main` as release-adjacent**, even if no
  deploy follows. Same confirmation discipline.
- **Never force-push to `main`.** Period. If `main` has a bad
  commit, fix it forward (revert + new commit) — never rewrite
  history.
- **Any agent action touching `main`** (merge, rebase, push,
  force) is a user-confirmed action. No agent does any of these
  without an explicit go from the user in chat.

### Rule 5 — Deploys route through `/release`

Production deploys are not free-floating actions. They flow
through `/release` (or its platform variants — `/ios-release`,
future `/web-release`, etc.). The skill is the gate.

Reasons:

- The skill enforces pre-flight (clean tree, tests green, build
  clean, on `main`, no surprise upstream commits).
- The skill prompts for version with reasoning and waits for
  user confirmation.
- The skill prompts for final deploy go-ahead.
- The skill tags the commit, pushes the tag, and writes the
  AUDIT entry.

**Never run deploy commands directly** (`firebase deploy`,
`fastlane release`, `npm run deploy`, `git push --tags` for
release tags, etc.) bypassing the skill. Even if you know the
command works. The skill is the gate.

If a project doesn't use `/release` (because it has a more
specialized release flow), the same five gates still apply
manually:

1. Pre-flight green.
2. User-confirmed version.
3. User-confirmed deploy.
4. Annotated tag pushed.
5. AUDIT entry appended.

These rules apply to every Claude session, every project, every
release. Don't soften them.
