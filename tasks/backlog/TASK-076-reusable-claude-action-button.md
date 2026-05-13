# TASK-076 — Reusable Claude Action Button

**Phase:** 8 — Persistent Claude Sessions & Action System
**Status:** FULL SPEC

---

## What

A single themed button component — `claude-action-btn` — that any view
can stamp out to dispatch a "send to Claude" operation. The same design
language (◆ sigil, blue palette, loading state) appears everywhere, with
per-action variation in label, color, and routed command. Currently each
Claude-dispatching button is hand-rolled differently (`start-repo-task`,
`spec-repo-task`, `rsh-create-submit`). This task introduces one canonical
component and migrates all three existing button patterns to use it.

---

## Why

The feature set is about to grow (TASK-077: session input, TASK-078: repo
mic). New "send to Claude" surfaces will keep appearing. Without a shared
component, every new button reinvents the loading state, error handling,
disabled logic, and visual style. One component = one place to evolve.

---

## Acceptance criteria

1. `.claude-action-btn` renders with the Claude blue palette and ◆ sigil
   in all three variants: `primary`, `secondary`, `dim`.
2. While a dispatch is in flight, the button enters `data-state="loading"`:
   label replaced with `…`, button disabled, sigil dimmed.
3. On error, button resets to its original label and is re-enabled.
   `showToast` fires with the error message.
4. On success, button resets OR the sheet closes (per-action behavior —
   see handler spec below).
5. All three existing button patterns (`▶ Assign`, `◎ Spec`,
   `＋ Create task / ⊕ Plan phase submit`) continue to work identically
   after migration — same commands, same COS opens.
6. No new `data-action` strings added to `actions.js` beyond
   `claude-action`. The old `start-repo-task`, `spec-repo-task`, and
   `rsh-create-submit` action strings are removed.
7. `npm run typecheck` passes clean.

---

## Files expected to change

### `frontend/galt-messages/styles.css`

**WHAT:** Add `.claude-action-btn` block. Reuse existing `--claude-*` CSS
vars. Three variants driven by `data-variant` attribute:

```css
.claude-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--claude-border);
  background: var(--claude-bg);
  color: var(--claude-c);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.claude-action-btn:hover {
  background: var(--claude-glow);
  border-color: var(--claude-c);
}

.claude-action-btn[disabled],
.claude-action-btn[data-state="loading"] {
  opacity: 0.5;
  pointer-events: none;
}

/* green variant — used for Spec (expand task) */
.claude-action-btn[data-variant="secondary"] {
  --ca-c: var(--green-c, #4caf50);
  border-color: color-mix(in srgb, var(--ca-c) 35%, transparent);
  background:   color-mix(in srgb, var(--ca-c) 10%, var(--surface));
  color: var(--ca-c);
}
.claude-action-btn[data-variant="secondary"]:hover {
  background: color-mix(in srgb, var(--ca-c) 18%, var(--surface));
  border-color: var(--ca-c);
}

/* dim / ghost — for lower-prominence placements */
.claude-action-btn[data-variant="dim"] {
  background: transparent;
  border-color: transparent;
  color: var(--text-secondary);
}
.claude-action-btn[data-variant="dim"]:hover {
  background: var(--claude-bg);
  color: var(--claude-c);
}

.ca-sigil { font-size: 11px; line-height: 1; flex-shrink: 0; }
.ca-label { white-space: nowrap; }
```

**WHY:** All Claude action buttons share this palette. Variants are the
minimum needed to distinguish assign (blue), spec (green), and ghost
placements without inventing a third color system.

---

### `frontend/galt-messages/index.html`

**WHAT:** Replace the three button patterns with `claude-action-btn`:

**Assign button** (in task detail sheet):
```html
<!-- Before -->
<button class="sheet-action primary" data-action="start-repo-task"
        data-repo-id="..." data-task-id="...">▶ Assign</button>

<!-- After -->
<button class="claude-action-btn" data-action="claude-action"
        data-claude-action="assign"
        data-variant="primary"
        data-repo-id="..." data-task-id="...">
  <span class="ca-sigil">◆</span>
  <span class="ca-label">Assign</span>
</button>
```

**Spec button**:
```html
<!-- After -->
<button class="claude-action-btn" data-action="claude-action"
        data-claude-action="spec"
        data-variant="secondary"
        data-repo-id="..." data-task-id="...">
  <span class="ca-sigil">◆</span>
  <span class="ca-label">Spec</span>
</button>
```

**Create task / phase submit** (in `rsh-create-form`):
```html
<!-- After -->
<button class="claude-action-btn" data-action="claude-action"
        data-claude-action="create"
        data-variant="primary">
  <span class="ca-sigil">◆</span>
  <span class="ca-label">→ Create</span>
</button>
```

The `rsh-create-form`'s `data-create-type` attribute (`task` | `phase`)
is read by the handler at click time — no change to form setup.

**WHY:** Uniform DOM shape means one handler covers all three, and a
new action is a new `data-claude-action` value rather than a new JS
function + CSS block.

---

### `frontend/galt-messages/js/actions.js`

**WHAT:** Remove `start-repo-task`, `spec-repo-task`, and
`rsh-create-submit` handler entries. Add a single `claude-action`
handler that dispatches based on `data-claude-action`:

```javascript
'claude-action': async (target) => {
  const verb   = target.dataset.claudeAction;  // 'assign' | 'spec' | 'create'
  const repoId = parseInt(
    target.closest('[data-repo-id]')?.dataset.repoId ?? target.dataset.repoId,
    10
  );
  const taskId = target.closest('[data-task-id]')?.dataset.taskId ?? target.dataset.taskId;

  // Enter loading state
  const originalLabel = target.querySelector('.ca-label')?.textContent;
  target.dataset.state = 'loading';
  target.disabled = true;

  try {
    let result;
    let title;

    if (verb === 'assign') {
      if (!Number.isFinite(repoId) || !taskId) throw new Error('repo + task required');
      result = await sendCommand('start_repo_task', { repo_id: repoId, task_id: taskId });
      title  = `Assign: ${result?.spec_title || taskId}`;
      closeSheet('task-detail');
    } else if (verb === 'spec') {
      if (!Number.isFinite(repoId) || !taskId) throw new Error('repo + task required');
      result = await sendCommand('spec_task', { repo_id: repoId, task_id: taskId });
      title  = `Spec: ${result?.spec_title || taskId}`;
      closeSheet('task-detail');
    } else if (verb === 'create') {
      const form      = document.querySelector('[data-id="rsh-create-form"]');
      const createType = form?.dataset.createType;     // 'task' | 'phase'
      const narrative  = form?.querySelector('[data-id="rsh-create-input"]')?.value?.trim();
      const fRepoId    = parseInt(form?.dataset.repoId, 10);
      if (!narrative) throw new Error('describe what you want first');
      const cmd = createType === 'task' ? 'create_repo_task' : 'create_repo_phase';
      result = await sendCommand(cmd, { repo_id: fRepoId, narrative });
      title  = createType === 'task' ? '＋ Create task' : '⊕ Plan phase';
      if (form) form.style.display = 'none';
    } else {
      throw new Error(`unknown claude-action: ${verb}`);
    }

    const uuid = result?.task_id;
    if (!uuid) throw new Error('no task_id returned');
    const effectiveRepoId = verb === 'create'
      ? parseInt(document.querySelector('[data-id="rsh-create-form"]')?.dataset.repoId, 10)
      : repoId;
    openClaudeOutputSheet(uuid, title, effectiveRepoId);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    target.dataset.state = '';
    target.disabled = false;
    const labelEl = target.querySelector('.ca-label');
    if (labelEl && originalLabel) labelEl.textContent = originalLabel;
  }
},
```

Also remove the now-dead `rsh-create-cancel` handler if the create form
cancel still works via `data-close` or a separate cancel button (verify
at migration time).

**WHY:** One handler, one loading state, one error surface. The `verb`
determines which backend command fires; the rest is identical.

---

## Test plan

1. Open a repo's task detail → tap Assign → button enters loading state →
   COS opens with the task card → no error toast.
2. Same for Spec.
3. Open New Task form, type narrative, tap Create → COS opens.
4. Simulate a backend error (disconnect wifi, tap Assign) → button resets,
   toast shows error, no stuck loading state.
5. Visual regression: Assign button is blue, Spec button is green.
6. Confirm old `start-repo-task` / `spec-repo-task` action strings no
   longer exist in the JS (grep check).

---

## Out of scope

- Adding new `data-claude-action` verbs beyond `assign`, `spec`, `create`.
  Those are TASK-077/078 territory.
- The `rsh-create-cancel` button — leave as-is if it still works; don't
  migrate unless broken.
- Mobile vs desktop visual parity beyond what the existing CSS vars already
  handle.
