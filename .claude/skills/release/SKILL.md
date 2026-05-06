---
name: release
description: Cut a production release end-to-end — merge integration to main, build, deploy, tag, push tag, append AUDIT entry. Reads the project's CLAUDE.md / DEPLOY.md / package.json to discover the actual deploy command. User-confirms the version and the deploy at every gate. Triggered when the user wants to ship — e.g. "/release", "deploy v1.2.0", "ship it", "cut a release".
---

# /release — Cut a production release

Orchestrate the deploy sequence from "integration approved" to
"tag pushed + audit logged." Every project's deploy command is
different; this skill discovers it from the project's docs and
manifests rather than hardcoding.

Per the project's deploy-tagging rule: **production deploys are
user-confirmed every time.** This skill never auto-deploys. It
prepares, asks, executes only on explicit go.

## Behavior contract

- **Detect platform before discovering deploy commands.** The kit
  uses platform-prefixed skill names (e.g. `/ios-release`,
  `/web-deploy`) for platform-specific release flows. Before doing
  anything else, figure out which platform applies and decide
  whether to delegate. Detection rules:

  1. **Explicit declaration in `CLAUDE.md`.** Look for a `## Platform`
     section or a "Platform: <name>" header. If present, use it
     verbatim. Multi-platform declarations (e.g. "ios + python")
     are valid — the user knows which release skill they want.
  2. **Inferred from manifest files** when `CLAUDE.md` is silent:
     - `*.xcodeproj` / `*.xcworkspace` / `Package.swift` at repo
       root → `ios`
     - `package.json` containing `"react-native"` dep → `react-native`
       (no skill yet, fall through to universal flow)
     - `package.json` only (no react-native) → `web` (no
       `/web-release` skill yet, fall through)
     - `pyproject.toml` / `setup.py` → `python`
     - `build.gradle` / `*.gradle.kts` with `android` plugin →
       `android`
     - Otherwise → `universal`

  Then check whether a `<platform>-release` skill exists in
  `.claude/skills/`. If yes, **propose handoff explicitly**:

  > This is an **iOS** project. The right tool is `/ios-release`,
  > which handles the `xcodebuild` archive → `altool` upload flow.
  > Want me to hand off, or are you intentionally invoking the
  > universal `/release` flow?

  Wait for confirmation. **Do not auto-invoke another skill.** The
  user might be running the universal flow on purpose (e.g., a
  non-iOS deploy in an iOS-primary monorepo). Always ask.

  If no platform-specific release skill exists, proceed with the
  universal flow below.

- **Discover, don't assume.** Read in this order:
  1. `CLAUDE.md` — the "Deploy" / "Release" section if it exists.
  2. `DEPLOY.md` — full deploy runbook.
  3. `package.json` `scripts` — look for `deploy`, `deploy:prod`,
     `release`, `publish`.
  4. `Makefile` — `deploy` / `release` targets.
  5. `Fastfile` (iOS), `fastlane`, `eas.json` (Expo), `firebase.json`,
     `netlify.toml`, `vercel.json`, etc.
  Surface what you found and the command you'd run before
  running it.

- **Confirm version with the user.** Per task-rules.md: closer
  *proposes* a version with reasoning; reviewer confirms or
  overrides. Don't pick unilaterally. Use the version-bump
  heuristic (patch/minor/major) and propose with the *why*.

- **Confirm deploy with the user.** Even with a known command and
  a confirmed version, ask one final go: "Deploy now? `<command>`
  on `<branch>` → tag `<vX.Y.Z>`." Wait for explicit yes.

- **Run pre-flight gates.** Before deploying:
  - Working tree clean.
  - On `main` (or the project's release branch).
  - `git pull` clean — no surprise upstream commits.
  - The project's verification gate (test command from `CLAUDE.md`)
    is green. Run it; don't trust a stale green from yesterday.
  - The build succeeds (delegating to `/build` semantics, but
    inline is fine since this skill is the orchestrator).

- **Tag with annotated tags only.** Lightweight tags don't carry
  the release-notes message. Use `git tag -a vX.Y.Z -m "..."`.

- **Push the tag explicitly.** `git push origin vX.Y.Z` — main
  push and tag push are separate operations.

- **Append `tasks/AUDIT.md`** with a 🚀 entry per the audit-log
  rule. Don't commit it as part of the deploy commit — it's a
  separate, audited entry typically committed alongside the next
  task.

- **Honest reporting on failure.** If the deploy command fails
  partway, **do not retry blindly**. Report what succeeded, what
  failed, the exact error, and ask before any cleanup or retry.

## Output structure

This skill produces several outputs across its flow. Each pins a
catalogue entry per `output-rules.md`:

- **Pre-flight check** (Step 1) → §2 Live status dashboard. Each
  check is a row; ● = passed, ◐ = running, ✗ = failed.
- **Version proposal** (Step 5) → markdown blockquote with the
  reasoning. Conversational, not a structured deliverable.
- **Deploy confirmation prompt** (Step 6) → markdown blockquote.
  Conversational.
- **Any failure** (Steps 1–9) → §25 Alert variants (ERROR). Stops
  the flow.
- **Closing report** (Step 10) → §5 Deployment report. The big
  artifact the user takes away.

Concrete templates are inlined in each step below.

## The flow

### Step 0 — Platform detection + delegation

Before pre-flight, determine the project's platform per the
"Detect platform" rule in the Behavior contract. If a
`<platform>-release` skill exists, surface the handoff option to
the user and wait for their confirmation. Only proceed past Step 0
if the user opts into the universal flow or the platform has no
specific skill.

### Step 1 — Pre-flight check

Run in parallel:

- `git rev-parse --abbrev-ref HEAD` (must be main / release branch)
- `git status --porcelain` (must be empty)
- `git fetch origin && git log HEAD..origin/main --oneline` (must
  be empty — no upstream commits we don't have)
- Latest tag: `git describe --tags --abbrev=0` (so we know what
  the previous version was)
- `gh pr list --state open --base main` (any unmerged PRs that
  should have shipped?)

Render the pre-flight summary as a §2 Live status dashboard:

```
┌─ pre-flight · vX.Y.Z release ──────────────────────────┐
│                                                        │
│  ● branch         main                                 │
│  ● working tree   clean                                │
│  ● upstream       no surprise commits                  │
│  ● tests          142/142 green                        │
│  ● build          clean (no warnings)                  │
│  ● open PRs       0 pending merge to main              │
│                                                        │
│  ✓ all checks passed — ready to propose version        │
└────────────────────────────────────────────────────────┘
```

Glyph semantics: ● = passed, ◐ = running, ✗ = failed. If any check
fails, that row's glyph becomes ✗, the footer becomes a §25 ERROR
alert, and the skill stops:

```
┌─ ✗  ERROR ───────────────────────────────────────────────┐
│  pre-flight failed — <which check>                       │
│  <one-line reason; full output above>                    │
└──────────────────────────────────────────────────────────┘
```

### Step 2 — Discover deploy command

Read `CLAUDE.md` / `DEPLOY.md` / manifest files. State:

> **Deploy command:** `<exact command>`
> **Source:** `<file where it was documented>`

If multiple candidates, ask which.

If no deploy command is documented anywhere, **stop and ask** —
this skill won't guess prod commands.

### Step 3 — Run verification gate

The project's contract test command from `CLAUDE.md`. Examples:
`npm run test:e2e`, `pytest`, `go test ./...`, `cargo test`,
`xcodebuild test`, etc. Must be green.

If it fails, stop. Report the failure. Don't deploy.

### Step 4 — Run build

Run the project's build command (same discovery as `/build`).
Surface warnings; ask before proceeding through them.

### Step 5 — Propose version

Compute next version using the heuristic from task-rules.md:

- **Patch** — bug fixes, copy/styling tweaks.
- **Minor** — new user-visible features, additive (default for
  most batches).
- **Major** — breaking changes, schema migrations.

Propose with reasoning:

> Previous: `v1.1.0` · Proposed: **`v1.2.0`** (minor) — batch ships
> Part CRUD + Work Order CRUD + sidebar counts. Confirm or override.

Wait for confirmation.

### Step 6 — Confirm deploy

> Ready to deploy:
> - Branch: `main` @ `<sha>`
> - Command: `<deploy command>`
> - Tag (after success): `vX.Y.Z`
>
> Proceed?

Wait for explicit yes.

### Step 7 — Deploy

Run the deploy command in the foreground. Capture full output.

If it fails, stop. **Do not retry.** Report exactly what failed.

### Step 8 — Tag and push

After deploy success:

```sh
git tag -a vX.Y.Z -m "<release notes — see format below>"
git push origin vX.Y.Z
```

Release-notes message format (from task-rules.md):

```
vX.Y.Z — <one-line summary>

Tasks shipped:
- TASK-NNN — <name>
- TASK-NNN — <name>

Deployed: <YYYY-MM-DD HH:MM UTC>
Integration PR: #N
```

Pull the task list from the integration PR's body or recent
commit messages. Ask the user to confirm the summary line if
unclear.

### Step 9 — Append AUDIT.md

Add a 🚀 entry under today's date header. Format:

```markdown
- 🚀 **Released vX.Y.Z** — <one-line summary>. Tag `vX.Y.Z` at
  commit `<sha>`. Integration PR
  [#N](<url>).
```

Don't commit the audit edit by itself — leave it staged or
uncommitted unless the user says otherwise.

### Step 10 — Closing report

Render the deploy completion report per §5 Deployment report (per
task-rules.md "Closing report after deploy"):

````markdown
# Release vX.Y.Z — shipped

```
  ▲  DEPLOYMENT   ·   <env>   ·   vX.Y.Z


  ┌─ release ──────────────────────────────────────────┐
  │                                                    │
  │   ●  build           clean       <duration>        │
  │   ●  verification    <count>     <duration>        │
  │   ●  deploy          succeeded   <duration>        │
  │   ●  tag pushed      vX.Y.Z      ▲ <prev> → vX.Y.Z │
  │   ●  audit appended  ✓                             │
  │                                                    │
  └────────────────────────────────────────────────────┘


  tag           vX.Y.Z       <commit SHA>
  branch        main
  integration   PR #N
  deployed by   <user>
  started       <YYYY-MM-DD HH:MM UTC>
  completed     <YYYY-MM-DD HH:MM UTC>  ·  <duration>


  →  <live URL from CLAUDE.md / DEPLOY.md>
  →  https://github.com/<owner>/<repo>/releases/tag/vX.Y.Z
```

**Tasks shipped**
- TASK-NNN — <name>
- TASK-NNN — <name>

**Rollback** *(if needed)*
- Hosting rollback: `<command, e.g. firebase hosting:rollback>`
- Note: rollback reverts the live build; the tag stays in place
  per task-rules.md "Rollback semantics".
````

**Glyph semantics for the release box.** ● = step succeeded,
◐ = step running, ✗ = step failed (would have stopped the skill
before this report). ▲ marks the version bump. The two-column
key/value rows below the box carry the metadata the prior table
held — short values read better in this shape.

If the deploy partially succeeded (e.g. deploy went through but
tag push failed), use a §25 WARNING alert instead of §5 — the
deployment box implies a clean release, which a partial state isn't.

## What you must NOT do

- **Don't auto-deploy without confirmation.** Even on a clean
  pre-flight, the deploy is a user-confirmed gate.
- **Don't pick the version.** Propose with reasoning; user
  decides.
- **Don't run lightweight tags.** Annotated only.
- **Don't push tag and main commit together** if main needs a
  separate push — separate pushes, one for the merge commit, one
  for the tag.
- **Don't retry a failed deploy** without the user's say-so.
  Partial deploy state is dangerous; investigate before retrying.
- **Don't deploy with a dirty working tree.** Stash, commit, or
  abort — user's call.

## Edge cases

- **No annotated tags exist yet** (first release): bootstrap at
  `v1.0.0` per the project's tagging rule.
- **Hotfix path**: if the user invoked this skill via a hotfix,
  defer to the project's hotfix rule (typically: branch off main,
  patch bump, fast-track verification, audit entry tagged 🔥).
  Confirm hotfix mode explicitly.
- **No deploy command documented**: stop and ask. Don't infer
  from filename ("ah, `firebase.json` exists, so probably
  `firebase deploy`") — stating the inference and asking is
  always cheaper than a wrong deploy.

## When NOT to use this skill

- **Just verifying a build** → `/build`.
- **Running locally** → `/run`.
- **Reverting / rolling back** → use the project's rollback
  command directly. This skill cuts forward releases; rollback
  is its own operation (and should append an AUDIT entry too —
  do that by hand for now).
- **Pre-release / staging deploy** that doesn't tag — most
  projects have a separate `deploy:preview` or `deploy:stage`
  flow. That's not this skill. This is the prod tagged release.

## What "done" looks like for a /release session

- Live build deployed.
- Annotated tag pushed.
- AUDIT.md entry appended.
- Closing report rendered with the tag URL, commit SHA, and the
  rollback escape hatch.

If any of those didn't happen, the release isn't done. Be
explicit about it in the closing report — partial state is the
worst state to leave undocumented.
