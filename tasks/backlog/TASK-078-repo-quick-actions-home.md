# TASK-078 — Repo Quick Actions on Home Screen

**Phase:** 8 — Persistent Claude Sessions & Action System
**Status:** FULL SPEC

---

## What

Replace the single "CLAUDE" mic button on the companion home screen with a
combined repo selector + mic button. The selector shows all registered
repos (from `/state.repo_sessions`). Tapping the mic listens for a voice
command and routes it to the selected repo's persistent session via
`repo_claude_task`. The response streams inline below the button, same as
the existing `quick_claude` flow.

The original general-purpose `quick_claude` mic button is retained but
moved or de-emphasized — this doesn't remove that escape hatch.

---

## Why

The "Claude" home screen button is currently a shoot-in-the-dark command
with no repo context. It works but every task starts cold. With persistent
sessions (TASK-075), you can have an ongoing conversation with a specific
repo just by speaking to it from the home screen. The repo selector makes
that concrete: you know exactly which codebase you're talking to.

---

## Acceptance criteria

1. Home screen shows a row with a `<select>` containing all active repos,
   sorted by `last_used` desc (most recently touched first).
2. Tapping the mic button while a repo is selected speaks the transcript
   to `repo_claude_task` for that repo.
3. The response streams inline in the existing Claude panel below the
   button (same `.claude-response` / `_setClaudePanel('task', taskId)` path).
4. Selected repo persists in `localStorage['galt_repo_mic_repo_id']`
   across PWA launches.
5. If no repos are in `/state.repo_sessions`, the selector shows "No
   repos" and the mic button is disabled.
6. The general `quick_claude` mic (no repo context) is still accessible —
   it can live in the selector as an "— Ask Claude —" option or as a
   separate fallback.
7. Mobile and desktop layouts both updated (the quick-action pattern
   requires both; see `bookmarks.md:frontend/galt-messages/js/galt-chat.js`).
8. `npm run typecheck` passes clean.

---

## Dependencies

- TASK-075 (`repo_claude_task` command + `repo_sessions` in `/state`) must
  be merged first.
- Builds on the existing `startClaudeMic` pattern in `galt-chat.js` —
  reads that code first before writing the new function.

---

## Files expected to change

### `frontend/galt-messages/index.html`

**WHAT:** Replace the current Claude mic button block in both mobile
`.controls` and desktop `.sidebar` with a combined row.

Current pattern (both mobile + desktop):
```html
<button class="claude-mic-btn" data-id="[d-]claude-mic-btn"
        data-action="claude-mic" data-claude-state="idle" aria-label="Ask Claude">
  ...
</button>
<div class="claude-response" data-id="[d-]claude-response" hidden></div>
```

New pattern:
```html
<div class="repo-mic-row">
  <select class="repo-mic-select"
          data-id="[d-]repo-mic-select"
          data-action="repo-mic-select-change"
          aria-label="Select repo">
    <option value="">— Ask Claude —</option>
    <!-- populated from /state.repo_sessions by render.js -->
  </select>
  <button class="claude-mic-btn repo-claude-mic"
          data-id="[d-]claude-mic-btn"
          data-action="claude-mic"
          data-claude-state="idle"
          aria-label="Ask Claude">
    <!-- same SVG icons as before -->
    <span class="claude-mic-icon">...</span>
    <span class="claude-mic-label">◆</span>
    <span class="claude-mic-hint">Tap to speak</span>
  </button>
</div>
<div class="claude-response" data-id="[d-]claude-response" hidden></div>
```

The `data-action="claude-mic"` stays the same — the existing handler is
updated to read the selected repo rather than routing as `quick_claude`.
No new action string needed.

**WHY:** The button's `data-id` values stay identical so `_setClaudeState`
and `_setClaudePanel`'s `querySelectorAll` logic keeps working unmodified.
Only the wrapper row and the select are new DOM.

---

### `frontend/galt-messages/styles.css`

**WHAT:**

```css
.repo-mic-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
}

.repo-mic-select {
  flex: 1;
  min-width: 0;
  background: var(--surface-2, var(--surface));
  border: 1px solid var(--claude-border);
  border-radius: var(--radius);
  color: var(--text);
  font-size: 12px;
  padding: 4px 8px;
  appearance: none;
  cursor: pointer;
}

.repo-mic-select:focus {
  border-color: var(--claude-c);
  outline: none;
}

/* Shrink mic button in the combined row — the select takes the width */
.repo-mic-row .claude-mic-btn {
  flex-shrink: 0;
  width: auto;
  padding: 0 10px;
}

.repo-mic-row .claude-mic-hint {
  display: none;  /* no room for hint text in the combined layout */
}

/* Desktop sidebar: selector above the mic button (vertical layout) */
.sidebar .repo-mic-row {
  flex-direction: column;
  align-items: stretch;
}
.sidebar .repo-mic-select {
  margin-bottom: 4px;
}
```

**WHY:** Mobile shows the select + mic side by side (horizontal). Desktop
sidebar stacks them (vertical) since the sidebar is narrow.

---

### `frontend/galt-messages/js/render.js`

**WHAT:** Add `updateRepoMicSelect(sessions)` called from the store
subscriber whenever `store.repo_sessions` changes.

```javascript
export function updateRepoMicSelect(sessions) {
  const selects = document.querySelectorAll(
    '[data-id="repo-mic-select"], [data-id="d-repo-mic-select"]'
  );
  const saved = localStorage.getItem('galt_repo_mic_repo_id');

  for (const sel of selects) {
    const prev = sel.value;
    sel.innerHTML = '<option value="">— Ask Claude —</option>';
    if (!sessions || sessions.length === 0) {
      sel.disabled = true;
      continue;
    }
    sel.disabled = false;
    for (const s of sessions) {
      const opt    = document.createElement('option');
      opt.value    = String(s.id);
      opt.textContent = s.name;
      sel.appendChild(opt);
    }
    // Restore saved selection
    const restore = saved || (sessions[0]?.id ? String(sessions[0].id) : '');
    if ([...sel.options].some((o) => o.value === restore)) {
      sel.value = restore;
    } else {
      sel.value = sessions[0] ? String(sessions[0].id) : '';
    }
  }
}
```

Call site in `render.js` (wherever store updates trigger re-renders):
`updateRepoMicSelect(store.repo_sessions || []);`

**WHY:** render.js already owns all store→DOM projections. This follows
the existing pattern.

---

### `frontend/galt-messages/js/state.js`

**WHAT:** Ensure `repo_sessions` is extracted from the RTDB `/state`
snapshot and stored in the local store, then notify subscribers.

The `/state` subscription already copies the full snapshot into the store.
If `repo_sessions` is included in the snapshot object (TASK-075 adds it),
no change is needed — it will be available as `getStore().repo_sessions`
automatically.

Verify: after TASK-075 ships, check that `getStore().repo_sessions` is
populated. If the state subscription uses an allowlist to copy keys, add
`repo_sessions` to that list.

**WHY:** Companion state management is reactive — `updateRepoMicSelect`
reads from the store; the store is the source of truth.

---

### `frontend/galt-messages/js/galt-chat.js`

**WHAT:** Modify `startClaudeMic()` to read the repo selector and route
accordingly.

Inside `rec.onresult`:
```javascript
rec.onresult = async (e) => {
  const transcript = e.results[0]?.[0]?.transcript?.trim();
  if (!transcript) { _stopClaudeListening(); _setClaudeState('idle'); return; }

  _stopClaudeListening();
  _setClaudeState('waiting');
  _setClaudePanel('waiting');

  // Read selected repo from either selector (mobile or desktop)
  const sel    = document.querySelector('[data-id="repo-mic-select"]')
              || document.querySelector('[data-id="d-repo-mic-select"]');
  const repoId = sel?.value ? parseInt(sel.value, 10) : NaN;

  try {
    let result;
    if (Number.isFinite(repoId)) {
      // Route to persistent repo session
      result = await sendCommand('repo_claude_task', { repo_id: repoId, text: transcript });
    } else {
      // Fallback: general quick_claude (no repo context)
      result = await sendCommand('quick_claude', { text: transcript });
    }
    const taskId = result?.task_id;
    if (!taskId) throw new Error('no task_id returned');
    _setClaudeState('idle');
    _setClaudePanel('task', taskId);
  } catch (err) {
    _setClaudeState('idle');
    _setClaudePanel('hidden');
    showToast(`Claude: ${err.message}`, 'error');
  }
};
```

Also persist the selected repo when the user changes the select. Wire a
`change` event (or use the existing `wireEventDelegation` `<select>`
change handler):

```javascript
// In actions.js wireEventDelegation change handler (already exists for proposal-set-calendar)
// Add: repo-mic-select-change
'repo-mic-select-change': (target) => {
  localStorage.setItem('galt_repo_mic_repo_id', target.value);
  // Sync the other selector (mobile/desktop)
  for (const sel of document.querySelectorAll(
    '[data-id="repo-mic-select"], [data-id="d-repo-mic-select"]'
  )) {
    if (sel !== target) sel.value = target.value;
  }
},
```

**WHY:** The button keeps its existing `data-id` and `data-action`
(`claude-mic`). Only the routing logic inside `startClaudeMic` changes.
The `_setClaudeState` / `_setClaudePanel` machinery works unmodified since
it targets by `data-id`, not by parent structure.

---

## Test plan

1. `/state` includes repos → selector shows them, sorted by `last_used`.
2. Select repo A, tap mic, speak → task dispatched to repo A's session →
   Claude panel shows streaming output.
3. Select "— Ask Claude —" (no repo), tap mic → `quick_claude` fallback
   fires.
4. Reload PWA → saved repo is pre-selected in the selector.
5. Both mobile and desktop selectors stay in sync when either changes.
6. No repos in `/state` → selector disabled, mic button disabled.
7. Desktop sidebar layout: selector above mic (vertical).
8. Mobile controls layout: selector + mic side by side (horizontal).

---

## Out of scope

- Per-repo session status indicators in the selector (e.g. `task_count`
  badge). That's a cosmetic pass.
- Typing into the home screen instead of speaking. The input exists in the
  COS (TASK-077) — the home screen is voice-first.
- Multiple simultaneous repo selectors on the home screen (one is enough).
