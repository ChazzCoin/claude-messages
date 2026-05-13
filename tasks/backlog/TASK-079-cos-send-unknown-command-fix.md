# TASK-079 — Fix COSS/COS Send: "unknown command type" Error

**Phase:** 8 — Persistent Claude Sessions & Action System
**Status:** FULL SPEC

---

## What

Diagnose and fix the send failure in the Claude Output Sheet (COS) session
input bar and/or the Claude Output Sessions Sheet (COSS) send path that
produces an "unknown command type" error toast when the user submits a
message.

The backend dispatch in `server/firebase-commands.ts` throws
`unknown command type: <name>` (line 770) when the frontend sends a
command type string that doesn't match any registered `case`. This task
finds where the mismatch occurs and corrects it — either by fixing the
frontend command name or by adding the missing backend case.

---

## Why

The COSS sheet (persistent repo sessions) and the COS session input bar
(TASK-077) are the primary entry points for follow-up conversation with a
Claude session. A send failure with an opaque error message makes the
feature unusable and leaves the user with no path forward except refreshing
the page.

---

## Scope

**In scope:**
- Trace all `sendCommand(...)` call sites in the COSS/COS send paths and
  verify each command type string matches a registered case in
  `server/firebase-commands.ts::dispatch`.
- Fix any mismatch found — wrong command name on the frontend, missing case
  on the backend, or payload shape mismatch that causes a downstream throw.
- Verify the fix end-to-end: send from the COSS global pill, send from a
  repo session pill, send from the COS session bar.
- Ensure the error toast shows a user-readable message if a real error
  occurs (e.g. repo inactive) rather than a raw internal error string.

**Out of scope (explicit):**
- Redesigning the COSS/COS send UX.
- Adding new commands beyond what's needed for the fix.
- Fixing unrelated errors visible in the COS task stream.

---

## Root cause candidates

In order of likelihood:

1. **Stale backend after recent COSS commits.** Commits `f774b68`
   (global Galt session) and `e6cd105` (new-session pill) added
   `global_claude_task` to the COSS send path. If the `launchd` service
   was not redeployed after those commits, the running backend lacks the
   `global_claude_task` case and every global-session send throws
   `unknown command type: global_claude_task`. Fix: `./bin/deploy`.
   Verify this first before touching code.

2. **Wrong command string in a frontend code path.** The `coss-send`
   handler (`frontend/galt-messages/js/actions.js:372`) dispatches
   `global_claude_task` or `repo_claude_task`. If either string was
   mistyped (e.g. `global_claude_tasks`, `repo_claude`) the backend
   rejects it. Audit each `sendCommand(...)` call in the COSS/COS area.

3. **Payload type mismatch.** `repo_claude_task` requires `repo_id` to
   be a `number` (backend validates `typeof p.repo_id === 'number'`). If
   the frontend sends a string (e.g. `picker.value` without `parseInt`),
   the validation throws `repo_id required` — though that's a different
   error message than "unknown command type".

4. **Missing case for a new action introduced alongside COSS.** If any
   button wired up in the COSS HTML calls `sendCommand` with a type that
   was never added to `dispatch`, the default case fires.

---

## Files expected to change

Determined during investigation. Likely candidates:

- `frontend/galt-messages/js/actions.js` — fix send command type string
  if mismatched, or tighten error toast copy
- `server/firebase-commands.ts` — add missing `case` if a command was
  added to the frontend but not the backend
- `frontend/galt-messages/index.html` — only if a button's `data-action`
  attribute is wrong

---

## Acceptance criteria

- [ ] `./bin/deploy` succeeds (typecheck passes, service restarts clean).
- [ ] Opening the COSS sheet, selecting the "Galt" (global) pill, typing a
      message, and tapping Send — no error toast; a new task card appears
      in the COS stream or a "sent to Galt" toast fires.
- [ ] Opening the COSS sheet, selecting an existing repo session pill,
      typing a message, and tapping Send — "sent to session" toast fires;
      backend receives `repo_claude_task` and starts a task.
- [ ] Opening the COSS sheet in "new" mode (＋ pill), picking a repo from
      the dropdown, typing a message, and tapping Send — no error; task
      starts against the chosen repo.
- [ ] Sending from the COS session input bar (visible for repo-backed tasks)
      fires `repo_claude_task` and shows "sent to session".
- [ ] No regression on existing send paths: `quick_claude`, `galt_chat`.
- [ ] If the backend is legitimately unavailable (service down), the timeout
      toast says "command timed out — is the backend running?" as before.

---

## Test plan

1. **Setup:** `./bin/status` — confirm backend is running and `chat.db ok:
   True`. Open the companion PWA at `https://galt-messages.web.app`.
2. **COSS global send:**
   1. Tap the COSS button to open the sheet.
   2. Confirm "Galt" pill is active.
   3. Type "hello" in the input, tap Send.
   4. Assert: toast says "sent to Galt" (or similar), no error toast.
3. **COSS repo send:**
   1. Select a repo session pill.
   2. Type a short prompt, tap Send.
   3. Assert: toast says "sent to session", COS sheet opens (or was already
      open) with a new task card streaming.
4. **COSS new-session send:**
   1. Tap the ＋ pill.
   2. Pick a repo from the dropdown.
   3. Type a prompt, tap Send.
   4. Assert: session is created, task starts.
5. **COS session bar:**
   1. Trigger a `repo_claude_task` to open the COS with a repo task.
   2. Wait for the task to complete.
   3. Type a follow-up in the session bar, press Enter.
   4. Assert: new task card appears.
6. **Baseline regression:** Send a `galt_chat` message from the home screen.
   Assert it still works.

---

## Manual verification

1. Check `./bin/logs` immediately after triggering the error to see the raw
   `[firebase-commands] dispatch failed` log line — it will include the
   exact command type string the backend received.
2. Confirm `npm run typecheck` passes after any code changes.
3. Run `./bin/deploy` to restart the service.

---

## Open questions / risks

- **Deployed vs. local version gap.** If the user sees the error on
  `galt-messages.web.app` but the PWA was cached from before recent
  frontend commits landed, the companion may be running old JS that sends
  a different command. Hard-refresh (`⌘⇧R`) or `npm run remote:deploy`
  to publish the latest frontend first.
- **`querySelectorAll` vs `querySelector` rule.** The COSS send reads the
  `coss-input` element with `querySelector`. On a page that has both
  mobile and desktop HTML with the same `data-id`, this picks the first
  (mobile) one. If the user is on desktop and the mobile input is hidden
  (empty value), the send silently aborts with no error, not an "unknown
  command type" error. Verify this path too.

## Blocker notes

(Agent fills this in if it gets stuck. Leave empty when creating.)

---

**Definition of done:**
- All acceptance criteria checked
- E2E test passes (or N/A documented)
- The project's build command clean (per `CLAUDE.md` / `/build`)
- PR opened, linked from this file, ready for human review
