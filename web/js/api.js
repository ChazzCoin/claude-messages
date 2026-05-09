// Thin fetch wrapper used everywhere.

export async function api(path, opts = {}) {
  const init = {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  };
  if (opts.body !== undefined && opts.method !== 'GET') {
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, init);
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const j = await res.json();
      if (j.error) detail += `: ${j.error}`;
    } catch { /* not JSON */ }
    throw new Error(detail);
  }
  if (res.status === 204) return null;
  return res.json();
}

/** Set a top-bar pill (chat.db / watcher / model / drafts / away). */
export function setPill(id, state, label) {
  const el = document.getElementById(id);
  if (!el) return;
  const dot = el.querySelector('.dot');
  const lab = el.querySelector('.pill-label');
  if (dot) {
    dot.classList.remove('amber', 'red');
    if (state === 'warn') dot.classList.add('amber');
    else if (state === 'error') dot.classList.add('red');
  }
  if (lab && label !== undefined) lab.textContent = label;
}

/** Update the Galt nav-item's active-summon-sessions badge. Hidden at 0;
 *  amber pill at >0. The badge sits on the Galt sidebar item because
 *  Summon was folded into Galt — the count surfaces there as a live
 *  signal of "Galt is in conversation right now." */
function setSummonBadge(count) {
  const badge = document.getElementById('nav-summon-badge');
  if (!badge) return;
  if (count > 0) {
    badge.style.display = '';
    badge.textContent = String(count);
    badge.style.background = 'var(--accent)';
    badge.style.color = 'var(--bg)';
    badge.title = `${count} active summon session${count === 1 ? '' : 's'}`;
  } else {
    badge.style.display = 'none';
  }
}

/** Refresh top-bar pills + the Galt summon badge from /api/health.
 *  Tolerates fetch failure. */
export async function refreshHealth() {
  try {
    const h = await api('/api/health');
    setPill('pill-chatdb', h.chat_db?.ok ? 'ok' : 'error');
    setPill('pill-watcher', h.watcher_running ? 'ok' : 'warn');
    setPill('pill-model', h.openai_configured ? 'ok' : 'warn', h.openai_model || 'gpt-4o-mini');
    setSummonBadge(h.summon_active_sessions || 0);
    return h;
  } catch {
    setPill('pill-chatdb', 'error');
    setPill('pill-watcher', 'warn');
    setPill('pill-model', 'warn');
    return null;
  }
}

/** Fetch settings + bounds, return them. State module updates happen at call site. */
export async function fetchSettings() {
  return api('/api/settings'); // { settings, bounds }
}

/** Fetch the contacts list (with handles[]) for the autocomplete cache. */
export async function fetchContacts() {
  return api('/api/contacts'); // { contacts: [...] }
}
