# Quick Action Pattern

The canonical way to add a home-screen quick action button to the companion PWA.
Both Memory (◈ GALT BRAIN) and Claude (◆ CLAUDE) were built this way. Use this
checklist when building the next one.

---

## What a quick action is

A single button on the home screen (mobile `.controls` strip + desktop sidebar) that:

1. **Listens** — tap → Web Speech API STT
2. **Sends** — transcript dispatched to a backend command
3. **Shows output** — inline panel below the button, themed to match the AI

Three output modes depending on what the backend returns:
- **Chat reply** (Galt): routed through `renderMessages` → spoken or brain card
- **Task stream** (Claude): `task_id` → `subscribeToTask` → live streaming card
- **Direct data** (future): inject structured HTML into the panel directly

---

## Checklist

### 1. Pick a namespace

Choose a short slug, e.g. `memory`, `claude`, `search`. Everything below uses it.

---

### 2. CSS variables + button styles (`styles.css`)

Add a block of CSS vars for the action's accent color:

```css
:root {
  --<slug>-c:          #hex;     /* primary accent */
  --<slug>-bg:         color-mix(in srgb, var(--<slug>-c) 10%, var(--surface));
  --<slug>-border:     color-mix(in srgb, var(--<slug>-c) 30%, transparent);
  --<slug>-header-bg:  color-mix(in srgb, var(--<slug>-c) 12%, var(--surface));
  --<slug>-header-bdr: color-mix(in srgb, var(--<slug>-c) 25%, transparent);
  --<slug>-dim:        color-mix(in srgb, var(--<slug>-c) 40%, transparent);
  --<slug>-glow:       color-mix(in srgb, var(--<slug>-c) 60%, transparent);
}
```

Button states driven by `data-<slug>-state` attribute:

```css
.<slug>-mic-btn { /* idle default */ }
.<slug>-mic-btn[data-<slug>-state="listening"] { /* pulse animation */ }
.<slug>-mic-btn[data-<slug>-state="waiting"]   { /* dim / spinner */ }
```

Icon swap (show wave during listening):

```css
.<slug>-icon-wave { display: none; }
.<slug>-mic-btn[data-<slug>-state="listening"] .<slug>-icon-default { display: none; }
.<slug>-mic-btn[data-<slug>-state="listening"] .<slug>-icon-wave    { display: inline; }
```

Output card themed to match:

```css
.<slug>-quick-card { border: 1px solid var(--<slug>-border); background: var(--<slug>-bg); }
.<slug>-quick-header { background: var(--<slug>-header-bg); border-bottom: 1px solid var(--<slug>-header-bdr); }
.<slug>-sigil, .<slug>-label { color: var(--<slug>-c); }
```

---

### 3. HTML (`index.html`)

Add in **two places**: mobile `.controls` strip and desktop `.sidebar`.

```html
<!-- button -->
<button class="<slug>-mic-btn"
        data-id="<slug>-mic-btn"
        data-action="<slug>-mic"
        data-<slug>-state="idle"
        aria-label="<Label>">
  <span class="<slug>-mic-icon">
    <!-- default icon SVG -->
    <!-- wave/listening icon SVG (hidden by CSS until listening) -->
  </span>
  <span class="<slug>-mic-label"><Label></span>
  <span class="<slug>-mic-hint">Tap to speak</span>
</button>

<!-- response panel — content injected by JS, never static -->
<div class="<slug>-response" data-id="<slug>-response" hidden></div>
```

Desktop variant uses `data-id="d-<slug>-mic-btn"` and `data-id="d-<slug>-response"`.
All JS functions target both via `querySelectorAll` (never `querySelector`).

---

### 4. galt-chat.js — the state machine

Add a self-contained block at the end of the file. Four pieces:

```js
/* === <SLUG> QUICK ACTION === */

let _<slug>Rec       = null;
let _<slug>Listening = false;

// 4a. Button state
function _set<Slug>State(state) {
  const hintMap = { idle: 'Tap to speak', listening: 'Listening…', waiting: 'Thinking…' };
  const hint = hintMap[state] || 'Tap to speak';
  for (const btn of document.querySelectorAll('[data-id="<slug>-mic-btn"], [data-id="d-<slug>-mic-btn"]')) {
    btn.dataset.<slug>State = state;                        // drives CSS
    const hintEl = btn.querySelector('.<slug>-mic-hint');
    if (hintEl) hintEl.textContent = hint;
    const label = btn.querySelector('.<slug>-mic-state-label');
    if (label) label.textContent = state === 'idle' ? '<Label>' : hint;
  }
}

// 4b. STT stop helper
function _stop<Slug>Listening() {
  if (_<slug>Rec) { try { _<slug>Rec.stop(); } catch (_) {} _<slug>Rec = null; }
  _<slug>Listening = false;
}

// 4c. Panel injector — 'hidden' | 'waiting' | '<output-type>'
function _set<Slug>Panel(state, data = '') {
  const panels = [
    document.querySelector('[data-id="<slug>-response"]'),
    document.querySelector('[data-id="d-<slug>-response"]'),
  ].filter(Boolean);

  if (state === 'hidden') {
    for (const p of panels) { p.hidden = true; p.innerHTML = ''; }
    return;
  }
  if (state === 'waiting') {
    const html = `<div class="<slug>-quick-card">
      <div class="<slug>-quick-header">...</div>
      <div class="memory-response-loading" style="padding:10px 12px;">
        <span></span><span></span><span></span>
      </div>
    </div>`;
    for (const p of panels) { p.hidden = false; p.innerHTML = html; }
    return;
  }
  // ... output-specific states (task, reply, data)
}

// 4d. Exports
export function dismiss<Slug>Panel() { _set<Slug>Panel('hidden'); }

export async function start<Slug>Mic() {
  if (_<slug>Listening) { _stop<Slug>Listening(); _set<Slug>State('idle'); return; }

  _set<Slug>Panel('hidden');
  cancelSpeech();
  _unlockSpeechSynthesis();

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { showToast('Speech input not supported', 'error'); return; }

  const rec = new SR();
  rec.lang = 'en-US'; rec.interimResults = false; rec.continuous = false;

  rec.onresult = async (e) => {
    const transcript = e.results[0]?.[0]?.transcript?.trim();
    if (!transcript) { _stop<Slug>Listening(); _set<Slug>State('idle'); return; }

    _stop<Slug>Listening();
    _set<Slug>State('waiting');
    _set<Slug>Panel('waiting');

    try {
      const result = await sendCommand('<backend_command>', { text: transcript });
      // route output based on what came back
      _set<Slug>State('idle');
      _set<Slug>Panel('<output-state>', result.task_id /* or result.reply etc */);
    } catch (err) {
      _set<Slug>State('idle');
      _set<Slug>Panel('hidden');
      showToast(`<Label>: ${err.message}`, 'error');
    }
  };

  rec.onerror = (e) => {
    _stop<Slug>Listening(); _set<Slug>State('idle');
    if (e.error !== 'no-speech' && e.error !== 'aborted') showToast(`Voice: ${e.error}`, 'error');
  };
  rec.onend = () => { if (_<slug>Listening) { _stop<Slug>Listening(); _set<Slug>State('idle'); } };

  _<slug>Rec = rec;
  rec.start();
  _<slug>Listening = true;
  _set<Slug>State('listening');
}
```

---

### 5. actions.js — wire the handlers

```js
// Import
import { ..., start<Slug>Mic, dismiss<Slug>Panel } from './galt-chat.js';

// In HANDLERS:
'<slug>-mic':     () => { start<Slug>Mic(); },
'<slug>-dismiss': () => { dismiss<Slug>Panel(); },
```

---

### 6. Backend command (`server/firebase-commands.ts`)

Add a `case` to the `dispatch` switch:

```typescript
case '<backend_command>': {
  const text = typeof p.text === 'string' ? p.text.trim() : '';
  if (!text) throw new Error('text required');
  // ... do the work ...
  return { ok: true, task_id: task.id }; // or reply, data, etc.
}
```

Import whatever server helpers the command needs from `./task-runner.js`,
`./ai/galt-chat.js`, etc.

---

## Output type reference

| Output | Panel state | How it works |
|---|---|---|
| **Streaming task** | `'task'` | inject `.chat-task-card` shell → `subscribeToTask(taskId)` → existing task-card machinery drives updates |
| **Galt text reply** | `'reply'` | inject `.memory-brain-card` shell → set `_memoryWaiting = true` → `renderMessages` routes to panel |
| **Direct data** | custom state | inject bespoke HTML; no subscription needed |

---

## Rules

- **Always `querySelectorAll`**, never `querySelector`. Mobile and desktop panels
  have the same `data-id` values — both must update together.
- **Always inject via `innerHTML`**. Never show/hide existing children — `display:flex`
  will override the `hidden` attribute. Empty + re-inject on each state change.
- **State machine is single-file**. All logic lives in galt-chat.js under a clear
  `=== <SLUG> QUICK ACTION ===` banner. No spread across files.
- **Button resets to idle after dispatch**. The panel carries the live state from
  that point on (streaming, speaking, etc.). Button should never stay in "waiting"
  while a task runs — that's what the card header badge is for.
- **Dismiss is always wired**. Every panel has a `data-action="<slug>-dismiss"` ×
  button that calls `dismiss<Slug>Panel()`. No orphaned panels.
- **`_unlockSpeechSynthesis()` on every gesture**. Required for iOS TTS to work
  on the first reply after a new PWA launch.
