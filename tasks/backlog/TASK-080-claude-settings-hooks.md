# TASK-080 — `.claude/settings.json` Hooks for Defense in Depth

**Phase:** 8.5 — Galt CLI Tunnel & Permission Hardening
**Status:** FULL SPEC
**Depends on:** none (independent of all other work)
**Unblocks:** safer posture for TASK-081 work-in-progress

---

## What

Ship a `.claude/settings.json` with `PreToolUse` / `PostToolUse` hooks
that fire on every Claude CLI subprocess Galt spawns — both the existing
per-turn runner and (eventually) the bidirectional supervisor from
TASK-081. Hooks live next to agent config, not inside Galt's
orchestrator, so they survive subprocess restarts and apply identically
to both execution models.

Concretely:

- **Audit log every `Bash` invocation** to `logs/audit.log` with
  timestamp, task id (if available from env), and the command. Cheap
  forensics if `--dangerously-skip-permissions` ever lets something
  through that surprises us.
- **Block `Write` / `Edit` paths outside the repo root or active
  worktree.** Belt-and-suspenders against the model deciding to edit
  files in `$HOME`, `~/Library/`, or any other Mac path that's none of
  Galt's business.
- **Require `gh auth status` to succeed** before any `mcp__github`
  push. Catches the "auth expired silently" failure mode at the gate
  instead of letting the model retry-loop on a 401.
- **Mirror non-zero `Bash` exit codes** to RTDB as a structured
  `bash_failure` event tied to the current task. Companion UI can
  surface them as a chip instead of letting them get buried in the
  text stream.

---

## Why

Galt currently runs every Claude task with
`--dangerously-skip-permissions` (see
`server/integrations/claude-cli.ts:435`). That flag is necessary
because the subprocess is headless — no terminal is attached to approve
permission prompts interactively. But it means the model can run any
allowed tool against the whole filesystem.

Today this is tolerable because:
- It's one user on one machine.
- The allow-list (`Read`, `Edit`, `Bash`, `Grep`, etc.) is reasonable.
- The repos we target are scoped to `~/ChazzCoin/`.

It stops being tolerable the moment any of the following changes:
- A teammate is onboarded.
- COSS opens to a less-trusted context (LAN guest, mobile remote).
- A deploy task runs on a host with broader network access.
- A new MCP server is added that the model can use.

Hooks are the **deterministic gate layer** that survives every one of
those changes. They're also asymmetric leverage: a week of work, no
architectural commitment, no impact on the COSS/COA UX. The right thing
to land first.

This task is also a prerequisite for being able to **safely operate**
during the TASK-081 work-in-progress window — while the bidirectional
path is half-built, hooks give us deterministic Bash audit + path
scoping that doesn't depend on either subprocess model.

---

## Scope

**In scope:**

- Create `.claude/settings.json` with the four hooks listed above.
- Create `bin/hooks/` directory for hook scripts. Bash only. macOS-
  native tools (`/usr/bin/jq`, `/bin/echo`, `/bin/date`).
- Hook script: `pre-bash-audit.sh` — appends one line to
  `logs/audit.log` per Bash invocation.
- Hook script: `pre-write-scope.sh` — rejects with exit 1 if the
  target path isn't under the repo root or one of `~/.claude/worktrees/`.
- Hook script: `pre-gh-auth.sh` — runs `gh auth status` and rejects
  with exit 1 + a helpful message if not authenticated.
- Hook script: `post-bash-mirror.sh` — if the just-ran Bash exited
  non-zero, POSTs a structured event to a backend HTTP endpoint
  (`POST /api/internal/bash-failure`) that mirrors it to RTDB.
- Add the matching backend endpoint to receive `bash-failure` from
  hooks.
- `logs/audit.log` gitignored.
- `bin/hooks/` scripts chmod +x'd at install.
- README updates: `CLAUDE.md` and `bin/install` mention the hooks.

**Out of scope (explicit):**

- Hooks for `Read` / `Grep` — too noisy, no real attack surface.
- Hooks in Python / Go / Node — Bash is enough for everything here.
- Per-tool permission UI — that's TASK-081.
- Replacing `--dangerously-skip-permissions` flag — also TASK-081.
- Hooks for the chat.db reader (it's read-only; no model path
  touches it).
- Tests for hooks that run inside the CI — there's no CI yet. Manual
  verification is the gate.

---

## Files expected to change

- `.claude/settings.json` (new) — hook config
- `bin/hooks/pre-bash-audit.sh` (new)
- `bin/hooks/pre-write-scope.sh` (new)
- `bin/hooks/pre-gh-auth.sh` (new)
- `bin/hooks/post-bash-mirror.sh` (new)
- `bin/install` — chmod the new hook scripts; print confirmation
- `server/index.ts` — add `POST /api/internal/bash-failure` route
- `server/firebase-tasks.ts` (or similar) — `mirrorBashFailure(taskId, event)`
- `.gitignore` — add `logs/audit.log`
- `CLAUDE.md` — short section under "Conventions" describing the hooks
- `tasks/PHASES.md` — add Phase 8.5 entry

---

## Acceptance criteria

1. **Hooks fire on a real Claude task.** Run `start_repo_task` against
   a repo, watch `logs/audit.log` — every `Bash` invocation from the
   subprocess appears as one line. Format:
   `<ISO-8601> task=<task_id> cwd=<dir> cmd=<oneline>`.

2. **Write outside repo is blocked.** Manually craft a Claude prompt
   that tries to `Write` to `/tmp/test.txt`. The task fails with a
   stderr line `[pre-write-scope] path /tmp/test.txt not under any
   permitted root; rejecting`. The file is not created.

3. **Write inside repo is allowed.** Same prompt but targeting a path
   under the repo root — completes successfully, file is created.

4. **gh auth gate fires.** Temporarily invalidate `gh` auth
   (`gh auth logout`), trigger any task that uses `mcp__github` push,
   confirm it fails at the hook with a `[pre-gh-auth] gh not
   authenticated` message. Re-login and confirm it works again.

5. **Bash failure mirrors to RTDB.** Trigger a task where Claude runs
   `false` (exit 1) via Bash. Within 2 seconds, a `bash_failure` event
   appears under `/tasks/<task_id>/events/<n>` in RTDB with `exit_code:
   1` and the command.

6. **Companion UI renders the bash_failure chip.** With (5) above, the
   COA card for that task shows a red `Bash exit 1` chip next to the
   tool_use row. (Minimal styling; just must render.)

7. **No regression on the per-turn runner.** Existing
   `start_repo_task` / `spec_task` flows succeed end-to-end with hooks
   in place. Latency overhead per Bash < 50ms (audit hook is a single
   `echo >>`).

8. **`./bin/install` is idempotent on hook scripts.** Running it a
   second time doesn't error and doesn't duplicate anything.

9. **`./bin/deploy` succeeds clean.** Typecheck passes, service
   restarts, /api/health green.

10. **`logs/audit.log` is gitignored** and absent from `git status`
    after a task run.

---

## References

- `server/integrations/claude-cli.ts:435` — `--dangerously-skip-
  permissions` flag (current posture)
- `server/integrations/claude-cli.ts:452` — `stdio` config for
  per-turn subprocess (hooks fire regardless of stdio shape)
- `bin/install` — current install script (need to chmod new files)
- `bin/run` — service launcher (hooks load from `.claude/settings.json`
  on subprocess spawn, no changes needed here)
- Claude Code hook docs — `~/.claude/docs/hooks.md` if installed; else
  https://docs.claude.com/en/docs/claude-code/hooks
- `docs/decisions/bidirectional-claude-cli-architecture.md` — full
  architectural context

---

## Test plan

No E2E framework exists yet. Manual verification only.

1. **Setup.** `./bin/deploy` running, companion live, at least one repo
   registered.

2. **Audit log.**
   1. `tail -F logs/audit.log` in a terminal.
   2. From companion, trigger a `start_repo_task` that you expect to
      use Bash (e.g. "run `ls` and tell me what you see").
   3. Confirm one or more lines appear in `audit.log` with the
      expected format.

3. **Write scope block.**
   1. Craft a prompt: "Write the text 'hello' to `/tmp/galt-test.txt`."
   2. Trigger it via `quick_claude` or COSS.
   3. Confirm task fails. Confirm `/tmp/galt-test.txt` doesn't exist.
   4. Check `task_events` for the rejection line.

4. **Write scope allow.**
   1. Same shape but target `${repo}/tmp-test.txt`.
   2. Confirm task succeeds and file is created.
   3. Delete the test file.

5. **gh auth gate.**
   1. `gh auth logout`.
   2. Trigger any flow that exercises `mcp__github push` (the
      simplest: a `start_repo_task` whose `onComplete` does the
      branch push).
   3. Confirm task fails at the hook stage with the auth message.
   4. `gh auth login`.
   5. Re-trigger and confirm success.

6. **Bash failure mirror.**
   1. Prompt: "Run `false` via Bash to test error handling."
   2. Observe RTDB at `/tasks/<id>/events/` for the `bash_failure`
      event with `exit_code: 1`.
   3. Confirm chip renders in COA card.

7. **Latency check.** Time a task that runs 10 Bash commands. With
   hooks: < 500ms total overhead. Without hooks (revert
   `.claude/settings.json` temporarily): baseline. Diff should be
   < 500ms.

---

## Manual verification

1. `cat .claude/settings.json` — pretty-prints; no syntax errors.
2. `ls -la bin/hooks/` — all four scripts are executable.
3. `./bin/install` — re-running prints "hooks already installed"
   or similar; no errors.
4. Open `https://galt-messages.web.app` after a task — bash_failure
   chip renders if one occurred.

---

## Open questions / risks

- ~~**Hook script discovery for per-turn tasks against external repos.**~~
  **RESOLVED.** Original concern: per-turn tasks set `cwd` to the
  target repo, so the target repo's `.claude/settings.json` applies
  (not Galt's), leaving the hooks invisible for those subprocesses.
  Fix landed on this branch: Claude CLI supports `--settings <file>`,
  so `claude-cli.ts::resolveGaltSettingsPath` resolves Galt's local
  `settings.json` and passes it on every spawn. Hook `command` fields
  reference `$GALT_HOOKS_DIR/...` (not `$CLAUDE_PROJECT_DIR/...`) so
  they resolve regardless of cwd; `claude-cli.ts::galtSpawnEnv` exports
  the var on every spawn.
- **Hook script return semantics.** A non-zero exit blocks the tool.
  Verify the model recovers gracefully — emits a stderr event the
  user can see, doesn't infinite-loop retrying. Test in (3) above.
- **`logs/audit.log` rotation.** Untouched in this task. If volume
  becomes a problem, file a follow-up to rotate via `newsyslog` or
  similar. Not a launch blocker.
- **Cross-worktree edits.** During a `start_repo_task`, Claude works
  inside `~/.claude/worktrees/<branch>/`. The scope check must allow
  that path even though it's outside the registered repo root. List
  of permitted roots: `repo.local_path`, `~/.claude/worktrees/`, the
  current working directory tree.
- **Backend endpoint security.** `POST /api/internal/bash-failure`
  must be loopback-only and unauthenticated (hook scripts can't auth).
  Bind explicitly to `127.0.0.1` regardless of `HOST` env, refuse the
  request if it didn't come from loopback.

---

## Blocker notes

(Agent fills this in if it gets stuck. Leave empty when creating.)

---

**Definition of done:**

- All acceptance criteria checked
- Manual verification steps 1–7 above pass
- `./bin/deploy` clean
- No new errors in `logs/galt.err.log` post-deploy
- `docs/decisions/bidirectional-claude-cli-architecture.md` updated
  if any decisions changed during implementation (e.g. env-var path
  for settings.json discovery)
- PR opened, linked from this file, ready for human review
