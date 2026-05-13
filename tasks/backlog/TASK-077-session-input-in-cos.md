# TASK-077 — Session Input in COS Task Sheet

**Phase:** 8 — Persistent Claude Sessions & Action System
**Status:** FULL SPEC

---

## What

Add a text input + send button at the bottom of the Claude Output Sheet
(COS). When submitted, the text is dispatched as a `repo_claude_task`
command against the active task's repo, opening a new task card in the
same sheet. This enables follow-up prompts within the same repo session
without navigating away.

---

## Why

Today the COS is view-only. Once a task finishes, the only option is to
start a completely separate new task. With a persistent session (TASK-075),
the logical next step is obvious: type a follow-up right there. "Actually,
can you undo that last change and use a different approach" — without
re-navigating to the repo page, re-opening a form, or losing the context
of what just ran.

---

## Acceptance criteria

1. The COS sheet has a text input and send button visible at the bottom,
   below the task view area.
2. Typing in the input and pressing Enter or tapping Send dispatches
   `repo_claude_task` for the currently active task's repo.
3. A new task card opens in the same COS sheet (via `openClaudeOutputSheet`)
   and streams its output.
4. If no repo is associated with the active task (e.g. a `quick_claude`
   task with no `repo_id`), the input is hidden or disabled with a
   `not available — no repo session` hint.
5. The input clears on submit.
6. Enter key submits (no shift-enter multiline needed).
7. `npm run typecheck` passes clean.

---

## Dependencies

Requires TASK-075 (`repo_claude_task` command + persistent sessions) to
be merged first. The input will exist in the HTML but the command won't
exist until TASK-075 ships.

---

## Files expected to change

### `frontend/galt-messages/index.html`

**WHAT:** Add an input row inside the `.cos-sheet` div, after
`[data-id="cos-body"]`:

```html
<!-- COS session input — follow-up to the active repo session -->
<div class="cos-session-bar" data-id="cos-session-bar">
  <input class="cos-session-input"
         data-id="cos-session-input"
         type="text"
         placeholder="Follow up…"
         autocomplete="off"
         autocorrect="off" />
  <button class="cos-session-send claude-action-btn"
          data-action="cos-session-send"
          data-variant="dim"
          aria-label="Send">
    <span class="ca-sigil">◆</span>
    <span class="ca-label">→</span>
  </button>
</div>
```

Place this between `[data-id="cos-body"]` and the close button in the
sheet header, or at the very bottom of `.cos-sheet` — wherever it sits
below the scrollable task card area. Full-width, sticky to the bottom
of the sheet.

**WHY:** Input must be visible at all times in the COS, not buried inside
a scrollable zone.

---

### `frontend/galt-messages/styles.css`

**WHAT:** Style the session bar:

```css
.cos-session-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  background: var(--surface);
  flex-shrink: 0;
}

.cos-session-input {
  flex: 1;
  background: var(--input-bg, var(--surface-2));
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  font-size: 13px;
  padding: 6px 10px;
  outline: none;
}

.cos-session-input:focus {
  border-color: var(--claude-c);
}

.cos-session-bar .cos-session-send {
  padding: 6px 10px;
  flex-shrink: 0;
}

/* Hide bar when no repo session is available */
.cos-session-bar[data-available="false"] {
  display: none;
}
```

**WHY:** The bar needs to be below the scrollable task body, sticky, and
thematically connected to Claude (using `--claude-c` for focus ring).

---

### `frontend/galt-messages/js/galt-chat.js`

**WHAT:** Export one new function:

```javascript
/** Return the repoId for the currently active COS task, or null if
 *  there is no active task or the task has no repo association. */
export function getActiveCOSRepoId() {
  const meta = _cosTasks.get(_cosActiveId);
  return meta?.repoId ?? null;
}
```

Also update `_cosActivate(taskId)` (the internal function that switches
the visible task view) to update `[data-id="cos-session-bar"]`'s
`data-available` attribute based on whether the newly active task has
a `repoId`:

```javascript
function _cosActivate(taskId) {
  // ... existing logic ...
  const meta = _cosTasks.get(taskId);
  const bar = document.querySelector('[data-id="cos-session-bar"]');
  if (bar) bar.dataset.available = String(!!meta?.repoId);
}
```

**WHY:** The bar should hide itself when the active task has no repo
(e.g. a plain `quick_claude` task) since `repo_claude_task` requires
a `repo_id`. The CSS `[data-available="false"]` rule hides it cleanly.

---

### `frontend/galt-messages/js/actions.js`

**WHAT:** Add `cos-session-send` handler and import `getActiveCOSRepoId`:

```javascript
import {
  // ... existing imports ...
  getActiveCOSRepoId,
} from './galt-chat.js';

// In HANDLERS:
'cos-session-send': async () => {
  const input  = document.querySelector('[data-id="cos-session-input"]');
  const text   = input?.value?.trim();
  if (!text) return;

  const repoId = getActiveCOSRepoId();
  if (!repoId) {
    showToast('no repo session active', 'error');
    return;
  }

  input.value = '';

  try {
    const result = await sendCommand('repo_claude_task', {
      repo_id: repoId,
      text,
    });
    const uuid = result?.task_id;
    if (!uuid) throw new Error('no task_id returned');
    openClaudeOutputSheet(uuid, text.slice(0, 48), repoId);
  } catch (err) {
    showToast(err.message, 'error');
  }
},
```

Also wire the Enter key on the input. This goes in `wireEventDelegation()`:

```javascript
// COS session input: Enter key submits
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('[data-id="cos-session-input"]')) {
    e.preventDefault();
    HANDLERS['cos-session-send']?.(e.target);
  }
});
```

**WHY:** Delegated click covers the send button; the keydown handler
covers Enter in the text field. Both call the same handler function.

---

## Test plan

1. Open COS with a task that has a `repoId` — confirm session bar is
   visible.
2. Open COS with a `quick_claude` task (no repoId) — confirm session bar
   is hidden.
3. Switch between a repo task and a non-repo task in the COS pill queue —
   confirm bar toggles visibility accordingly.
4. Type a follow-up, press Enter — new task card appears in COS, streams
   output.
5. Tap Send button — same as 4.
6. Input clears after submit.
7. Backend error (e.g. repo inactive) → toast shows, input is not cleared.

---

## Out of scope

- Multiline input (shift-enter). Single line is fine — follow-ups are
  short commands, not essays.
- Input history / up-arrow recall.
- Displaying the repo name or session metadata in the bar. That's a
  polish pass.
