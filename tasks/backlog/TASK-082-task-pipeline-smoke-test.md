# TASK-082: Task creation pipeline smoke test

**Status:** STUB — full spec drafted before implementation

---

## User story

As the **repo owner**, I want to verify that the automated task creation pipeline (companion → backend → worktree → git commit → PR) is working end-to-end so that I can trust new tasks filed via the companion will land correctly in the backlog.

## Why this matters

The new-task pipeline was recently wired up. This task exists to confirm the full flow is operational: companion UI → Firebase command → backend spawns Claude in a worktree → Claude creates the task file and commits → PR is auto-opened for review. If any step silently fails, tasks get lost without feedback.

## Scope

**In scope:**
- Verifying the task creation flow produces a valid task file in `tasks/backlog/`
- Confirming the git commit lands on the worktree branch
- Confirming the PR is auto-opened from the worktree branch

**Out of scope (explicit):**
- Any code changes to the application
- Changes to the watcher, AI pipeline, or send path
- Anything that modifies `server/` or `web/` files

## References

- Related convention: `CLAUDE.md` — "Claude Code hooks fire on every Galt-cwd subprocess"
- Companion command entry point: `server/firebase-commands.ts:134` — dispatch switch

## Files expected to change

This task does not require any code changes. It is a validation artifact only.

- `tasks/backlog/TASK-082-task-pipeline-smoke-test.md` (this file — new)
- `tasks/ROADMAP.md` — add task entry under Cross-cutting

## Acceptance criteria

- [ ] Task file `tasks/backlog/TASK-082-task-pipeline-smoke-test.md` exists and follows the project task-template format
- [ ] Git commit is present on the worktree branch with message `backlog: add TASK-082 — Task creation pipeline smoke test`
- [ ] PR is auto-opened from the worktree branch for human review
- [ ] No application files were modified as part of this task

## Test plan

1. **Setup:** Trigger the new-task flow from the companion by providing a task narrative.
2. **Steps:**
   1. Companion sends `create_task` command via Firebase.
   2. Backend spawns Claude in a git worktree.
   3. Claude reads task conventions and creates this file.
   4. Claude stages and commits the file.
   5. PR is auto-opened (handled by the calling system).
3. **Assertions:**
   - `tasks/backlog/TASK-082-task-pipeline-smoke-test.md` is present.
   - `git log --oneline` on the worktree branch shows the commit.
   - No modifications to `server/`, `web/`, or `frontend/` files.

## Manual verification

1. Open the auto-created PR and confirm this file is the only file changed.
2. Confirm the commit message matches `backlog: add TASK-082 — Task creation pipeline smoke test`.

## Open questions / risks

- None — this is a meta-validation task with no implementation work.

## Blocker notes

(Agent fills this in if it gets stuck. Leave empty when creating.)

---

**Definition of done:**
- Task file committed to worktree branch
- PR auto-opened for review
- No application code changed
