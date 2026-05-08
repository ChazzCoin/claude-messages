// Render functions — read from the store, write to the DOM.
//
// All renderers are idempotent and accept a fresh snapshot. main.js
// wires them up to fire on every store update via subscribe().

const $$ = (id) => document.querySelectorAll(`[data-id="${id}"]`);
const $  = (id) => document.querySelector(`[data-id="${id}"]`);

function html(strings, ...values) {
  // Tagged-template helper that escapes string interpolations and
  // leaves literal HTML (the template parts) untouched.
  let out = '';
  strings.forEach((str, i) => {
    out += str;
    if (i < values.length) out += escape(values[i]);
  });
  return out;
}
function escape(v) {
  if (v == null) return '';
  return String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/* ---------- top-level ---------- */

export function renderAll(store) {
  renderConnection(store);
  renderState(store);
  renderNotes(store);
}

/* ---------- connection / health pill ---------- */

function renderConnection(store) {
  const { state, connected, lastError } = store;
  const health = state?.health;
  let tone = 'unknown';
  let label = '—';
  if (lastError) { tone = 'error'; label = 'no link'; }
  else if (!connected) { tone = 'unknown'; label = 'connecting'; }
  else if (!state) { tone = 'warning'; label = 'no state'; }
  else if (!health?.chat_db_ok) { tone = 'warning'; label = 'chat.db'; }
  else { tone = 'ok'; label = 'live'; }

  for (const el of document.querySelectorAll('.health-btn')) {
    el.dataset.health = tone;
    const txt = el.querySelector('[data-id$="health-text"]');
    if (txt) txt.textContent = label;
  }
}

/* ---------- main state (toggles + away preview + status panel) ---------- */

function renderState(store) {
  const s = store.state?.settings;
  const health = store.state?.health;

  // Toggles
  const summon = !!s?.summon_enabled;
  const away   = !!s?.away_mode_enabled;

  for (const el of document.querySelectorAll('[data-toggle="summon"]')) {
    el.dataset.on = String(summon);
    const badge = el.querySelector('[data-id$="summon-badge"]');
    if (badge) badge.textContent = summon ? 'on' : 'off';
  }
  for (const el of document.querySelectorAll('[data-toggle="away"]')) {
    el.dataset.on = String(away);
    const badge = el.querySelector('[data-id$="away-badge"]');
    if (badge) badge.textContent = away ? 'on' : 'off';
  }

  // Away message preview (clicking opens editor)
  const awayMsg = s?.away_message?.trim() || '— no message set —';
  for (const el of document.querySelectorAll('[data-id$="away-display"]')) {
    el.textContent = awayMsg;
  }

  // Status panel — desktop sidebar + mobile sheet share the same
  // markup, just rendered into different roots.
  const statusHTML = renderStatusPanel(s, health);
  for (const el of document.querySelectorAll('[data-id$="status-panel"]')) {
    el.innerHTML = statusHTML;
  }

  // Settings sheet inputs (only re-fill when the sheet is closed —
  // otherwise we'd clobber what the user is typing)
  const settingsSheet = document.querySelector('[data-id="settings-sheet"]');
  if (settingsSheet && settingsSheet.dataset.visible !== 'true') {
    const vp = document.querySelector('[data-id="voice-profile"]');
    if (vp && s) vp.value = s.voice_profile || '';
    const da = document.querySelector('[data-id="default-away"]');
    if (da && s) da.value = s.away_message || '';
  }

  // Watched contacts list — always re-render (no editable fields here)
  renderContacts(store.state?.watched_contacts || []);

  // Away message sheet input (only fill when closed)
  const awaySheet = document.querySelector('[data-id="away-sheet"]');
  if (awaySheet && awaySheet.dataset.visible !== 'true') {
    const ai = document.querySelector('[data-id="away-input"]');
    if (ai && s) ai.value = s.away_message || '';
  }
}

function renderStatusPanel(settings, health) {
  if (!settings || !health) return '<div class="stat-row"><span class="stat-label">—</span></div>';
  const tone = (b) => (b ? 'ok' : 'bad');
  const ago  = (ts) => ts ? formatAgo(Date.now() - ts) : '—';
  const rows = [
    ['Server',        'galt v' + escape(health.version)],
    ['Started',       escape(ago(health.started_at))],
    ['chat.db',       `<span class="stat-value" data-tone="${tone(health.chat_db_ok)}">${health.chat_db_ok ? 'ok' : 'fail'}</span>`],
    ['OpenAI',        `<span class="stat-value" data-tone="${tone(health.openai_configured)}">${health.openai_configured ? 'configured' : 'missing key'}</span>`],
    ['Watcher',       `<span class="stat-value" data-tone="${tone(health.watcher_running)}">${health.watcher_running ? 'running' : 'stopped'}</span>`],
    ['Auto-notes',    `<span class="stat-value" data-tone="${tone(settings.auto_notes_enabled)}">${settings.auto_notes_enabled ? 'on' : 'off'}</span>`],
    ['Unreviewed',    String(health.auto_unreviewed_notes ?? 0)],
    ['Away sessions', String(health.away_active_sessions ?? 0)],
    ['Summon active', String(health.summon_active_sessions ?? 0)],
  ];
  return rows
    .map(([k, v]) => `<div class="stat-row"><span class="stat-label">${escape(k)}</span><span class="stat-value">${v}</span></div>`)
    .join('');
}

function renderContacts(contacts) {
  const root = document.querySelector('[data-id="contacts-list"]');
  if (!root) return;
  if (!contacts.length) {
    root.innerHTML = '<div class="field-help" style="padding:8px 4px;">No watched contacts. Add one below.</div>';
    return;
  }
  root.innerHTML = contacts.map((c) => {
    const name = c.contact_name || c.label || c.handle;
    const subtitle = c.contact_name && c.handle !== c.contact_name ? c.handle : '';
    return `
      <div class="contact-row" data-contact-id="${escape(c.id)}">
        <div class="contact-info">
          <div class="contact-name">${escape(name)}</div>
          ${subtitle ? `<div class="contact-handle">${escape(subtitle)}</div>` : ''}
        </div>
        <button class="contact-status" data-action="toggle-contact" data-contact-id="${escape(c.id)}" data-on="${escape(c.enabled)}">${c.enabled ? 'on' : 'muted'}</button>
        <button class="contact-remove" data-action="remove-contact" data-contact-id="${escape(c.id)}" aria-label="Remove">×</button>
      </div>`;
  }).join('');
}

/* ---------- notes feed ---------- */

function renderNotes(store) {
  const notes = store.notes || [];
  const unreviewed = notes.filter((n) => !n.reviewed_at).length;
  for (const el of document.querySelectorAll('[data-id$="notes-count"]')) {
    el.textContent = `${unreviewed} unreviewed · ${notes.length} total`;
  }
  const html = notes.length
    ? notes.map(renderNote).join('')
    : '<div class="notes-empty">No notes yet. New inbound messages will surface here.</div>';

  for (const el of document.querySelectorAll('[data-id$="notes-list"]')) {
    el.innerHTML = html;
  }
}

function renderNote(n) {
  const reviewed = !!n.reviewed_at;
  const name     = n.contact_name || n.handle;
  const cat      = n.category || 'personal';
  const time     = formatTime(n.created_at);
  const body     = n.source_message_text || ''; // null when the backend
                                                // redacts it (default).
  return `
    <div class="note" data-reviewed="${reviewed}" data-note-id="${escape(n.source_local_id)}">
      <div class="note-head">
        <span class="note-category" data-cat="${escape(cat)}">${escape(cat)}</span>
        <span class="note-contact">${escape(name)}</span>
        <span class="note-time">${escape(time)}</span>
      </div>
      <div class="note-summary">${escape(n.summary || '')}</div>
      ${body ? `<div class="note-message">"${escape(body)}"</div>` : ''}
      <div class="note-actions">
        ${reviewed
          ? `<button data-action="unreview-note" data-note-id="${escape(n.source_local_id)}">unreview</button>`
          : `<button data-action="review-note"   data-note-id="${escape(n.source_local_id)}">mark reviewed</button>`}
        <button class="danger" data-action="delete-note" data-note-id="${escape(n.source_local_id)}">delete</button>
      </div>
    </div>`;
}

/* ---------- toast ---------- */

let toastTimer = null;
export function showToast(message, tone = '') {
  const el = document.querySelector('[data-id="toast"]');
  if (!el) return;
  el.textContent = message;
  el.dataset.tone = tone;
  el.dataset.visible = 'true';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.dataset.visible = 'false'; }, 2400);
}

/* ---------- sheets ---------- */

export function openSheet(name) {
  const sheet     = document.querySelector(`[data-id="${name}-sheet"]`);
  const backdrop  = document.querySelector(`[data-id="${name}-backdrop"]`);
  if (sheet)    sheet.dataset.visible = 'true';
  if (backdrop) backdrop.dataset.visible = 'true';
}

export function closeSheet(name) {
  const sheet     = document.querySelector(`[data-id="${name}-sheet"]`);
  const backdrop  = document.querySelector(`[data-id="${name}-backdrop"]`);
  if (sheet)    sheet.dataset.visible = 'false';
  if (backdrop) backdrop.dataset.visible = 'false';
}

export function closeAllSheets() {
  for (const name of ['settings', 'away', 'status']) closeSheet(name);
}

/* ---------- boot screen ---------- */

export function hideBoot() {
  const el = document.querySelector('[data-id="boot"]');
  if (el) el.dataset.hidden = 'true';
}

/* ---------- helpers ---------- */

function formatAgo(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60)    return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)    return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)    return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatTime(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
         ' ' +
         date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
