# TASK-064: Fix companion-site merge-PR button after new-task creation

## User story

As the **owner**, I want to **merge a new-task PR from the companion mobile site** so that **I can close out the task creation loop from my phone without going back to the Mac**.

## Why this matters

The new-task workflow (Claude Code running in a git worktree) creates a task spec, commits it, and opens a PR. After the PR opens, the companion PWA surfaces a "Merge PR" button. Tapping it produces a long red error and GitHub never merges anything. The task creation loop is stuck — the user has to SSH to the Mac or open GitHub to close it.

## Root cause

Two things are broken:

1. **Missing backend command handler.** `server/firebase-commands.ts::dispatch()` has no `merge_pr` case. When the companion's button sends `{ type: 'merge_pr', payload: { pr_number } }` via the `/commands` bus, the switch falls to `default` and throws `unknown command type: merge_pr`. That error string propagates through the command result to the frontend, which renders it as an error toast.

2. **gh CLI error output is raw and verbose.** If the handler *were* present but `gh pr merge` fails (wrong branch, not mergeable, auth issue, etc.), the full CLI stderr/stdout is sent back as the error message. That's the "very long red error" — `gh` can emit multi-line output including usage text, which makes for an unexpectedly large toast.

## Scope

**In scope:**
- Add `merge_pr` command handler to `server/firebase-commands.ts` that shells out to `gh pr merge --squash --delete-branch` (squash-merge is the convention for task PRs; delete the branch on merge)
- Trim the error message before writing it to the command result — capture only the first line of `gh` stderr, not the full multi-line dump
- Add a `merge-pr` action handler in `frontend/galt-messages/js/actions.js` that sends the `merge_pr` command with the PR number from the button's `data-pr-number` attribute
- Surface a success toast ("PR merged") and failure toast (first-line error only) in the companion
- Verify the button renders correctly in `frontend/galt-messages/index.html` with the PR number attribute set; fix if the attribute is missing or malformed

**Out of scope:**
- Changing how the new-task workflow writes the pending PR number to RTDB (that's the caller's concern — this task fixes the receiving end)
- Adding a pending-PR section to the `/state` snapshot in `firebase-state.ts` — if the button exists in the HTML, its `data-pr-number` already arrives from RTDB via some other path; don't add a second path without tracing where the current one writes
- Merge-strategy config (always squash-merge; this can be a setting later)
- GitHub auth setup (the Mac's `gh` CLI must already be authenticated — if not, that's a deploy-time config issue, not code)
- Auto-clearing the pending PR state after a successful merge (future nice-to-have)

## References

- Command bus entry point: `server/firebase-commands.ts::dispatch()` — add the new case here, immediately before `default`
- Action handler pattern: `frontend/galt-messages/js/actions.js::HANDLERS` — follow the shape of `proposal-approve` (try/catch, toast on error)
- `sendCommand` error path: `frontend/galt-messages/js/state.js:109` — `reject(new Error(v.error || 'command failed'))` — error text is exactly `v.error` from the backend result
- Firebase command bus flow: see `server/firebase-commands.ts::processCommand()` — result written at line ~116
- Existing shell-out precedent: `server/send.ts` (AppleScript via `osascript`) — same pattern: spawn child process, capture stdout/stderr, throw on non-zero exit

## Files expected to change

- `server/firebase-commands.ts` — add `merge_pr` case in `dispatch()`; include a shell-out helper that runs `gh pr merge` and captures only the first line of any error
- `frontend/galt-messages/js/actions.js` — add `merge-pr` handler in `HANDLERS` registry
- `frontend/galt-messages/index.html` — verify or fix the merge button element: must have `data-action="merge-pr"` and `data-pr-number="<PR_NUMBER>"`

## Acceptance criteria

- [ ] Tapping the merge button on the companion site successfully merges the PR on GitHub (verified via `gh pr view <num>` showing `MERGED`)
- [ ] On success, a concise toast ("PR #NNN merged") appears; no error toast
- [ ] On failure (e.g. already-merged PR, not-mergeable state), a single-line error toast appears — not a multi-paragraph dump
- [ ] The merged branch is deleted from the remote (confirming `--delete-branch` was effective)
- [ ] `npm run typecheck` passes clean after backend changes

## Test plan

1. Trigger the new-task workflow to open a real test PR on a throwaway branch (or use `gh pr create` manually against a scratch branch)
2. Confirm the PR number appears in the companion site's merge button (`data-pr-number`)
3. Tap "Merge PR" on the companion site
4. Run `gh pr view <num>` on the Mac — state should be `MERGED`
5. Confirm the branch is gone: `git ls-remote origin <branch>` returns nothing
6. Confirm toast is "PR #NNN merged" (no error, no multi-line dump)
7. Tap the button a second time (PR already merged) — confirm the error toast is short (first-line only from `gh` stderr)

## Manual verification

1. In the companion PWA, open the status/home section where the pending PR button appears after a new-task run
2. Tap "Merge PR" and watch the toast + GitHub PR state
3. Check the Mac terminal: `git branch -r | grep <task-branch>` should return nothing after merge

## Open questions / risks

- **Where does the PR number come from?** The button's `data-pr-number` attribute must be set somewhere. Before implementing, trace who writes the RTDB node that feeds this attribute. If it's currently unset (the attribute is hardcoded empty), the button will send `pr_number: NaN` to the backend, which the handler needs to guard against with a clear error.
- **gh auth on the LaunchAgent.** The LaunchAgent process runs under a different environment than the user's shell. `gh` uses the macOS Keychain for auth, which should be accessible, but this has caused issues before (similar to FDA for `chat.db`). Verify `gh auth status` works inside `bin/run`'s execution context.
- **Squash vs. merge vs. rebase.** Task PRs are single-commit by convention, so squash is equivalent to merge for now. If multi-commit task PRs appear later, squash will flatten them. Document the assumption in the handler comment.
- **Race: button tapped while PR is already merged or closed.** The handler's `gh pr merge` call will fail with a clear one-line error from `gh`. First-line truncation handles this gracefully.

## Blocker notes

(Agent fills this in if it gets stuck. Leave empty when creating.)

---

**Definition of done:**
- All acceptance criteria checked
- `npm run typecheck` clean
- PR opened, linked from this file, ready for human review
