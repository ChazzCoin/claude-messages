// View chrome — header, nav highlight, right-panel mode, form open/close.
// These are the bits every view needs to call when it mounts/unmounts.

export function setMainHeader({ title, subHTML }) {
  const t = document.querySelector('.main-title');
  const s = document.querySelector('.main-sub');
  if (t) t.textContent = title;
  if (s) s.innerHTML = subHTML;
}

export function setActiveNav(view) {
  document.querySelectorAll('.nav-item[data-view]').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === view);
  });
}

export function clearDraftsToolbar() {
  const tb = document.getElementById('drafts-toolbar');
  if (tb) tb.innerHTML = '';
}

export function clearThreadTools() {
  // Legacy slots (hidden but still cleared so stale data doesn't leak)
  // + new workbench slots that the thread view populates.
  const ids = [
    'thread-toolbar', 'thread-compose-bar', 'thread-profile', 'thread-notes',
    'workbench-identity', 'workbench-profile', 'workbench-notes',
    'workbench-radar', 'workbench-tools',
  ];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  }
}

export function clearThreadNotes() {
  const n = document.getElementById('thread-notes');
  if (n) n.innerHTML = '';
}

/** mode: 'thread' | 'collapsed'
 *  In thread mode the standard 3-column grid is in effect (sidebar +
 *  chat + rightpanel) and the rightpanel hosts the workbench cards
 *  stacked vertically. In collapsed mode the rightpanel hides
 *  entirely (other views don't need it).
 *
 *  An earlier "spatial canvas" experiment overlaid cards on top of
 *  the chat at fixed positions; that's been retired in favor of the
 *  classic two-column readout (chat left, cards right). */
export function setRightPanelMode(mode) {
  const app = document.querySelector('.app');
  const rp = document.querySelector('.rightpanel');
  const def = document.getElementById('rightpanel-default');
  if (mode === 'thread') {
    app?.classList.remove('no-rightpanel');
    rp?.classList.add('thread-mode');
    if (def) def.style.display = 'none';
  } else {
    app?.classList.add('no-rightpanel');
    rp?.classList.remove('thread-mode');
    if (def) def.style.display = '';
    clearThreadTools();
  }
}

export function openForm(id) {
  const f = document.getElementById(id);
  if (!f) return;
  f.classList.add('open');
  const err = f.querySelector('[data-error]');
  if (err) err.textContent = '';
  const first = f.querySelector('input, textarea, select');
  if (first) first.focus();
}

export function closeForm(id) {
  const f = document.getElementById(id);
  if (!f) return;
  f.classList.remove('open');
  f.reset?.();
  const err = f.querySelector('[data-error]');
  if (err) err.textContent = '';
}
