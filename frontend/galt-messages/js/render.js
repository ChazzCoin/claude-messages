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

/* ---------- COSS state (Claude Output Sessions Sheet) ---------- */

let _cossActiveRepoId = null;
let _cossSessions = [];

export function getActiveCOSSRepoId() { return _cossActiveRepoId; }

export function selectCOSSSession(repoId) {
  _cossActiveRepoId = Number.isFinite(repoId) ? repoId : null;
  renderCOSSQueue(_cossSessions);
}

export function renderCOSSQueue(sessions) {
  _cossSessions = sessions || [];

  const queueEl = $('[data-id="coss-queue"]');
  const countEl = $('[data-id="coss-session-count"]');
  if (countEl) countEl.textContent = _cossSessions.length ? String(_cossSessions.length) : '';

  // Auto-select first session when nothing is selected
  if (!_cossActiveRepoId && _cossSessions.length) {
    _cossActiveRepoId = _cossSessions[0].id;
  }

  if (queueEl) {
    queueEl.innerHTML = _cossSessions.map((s) => {
      const active = _cossActiveRepoId === s.id;
      return `
        <button class="coss-session-pill${active ? ' active' : ''}" data-action="coss-session-select" data-repo-id="${s.id}">
          <span class="coss-pill-dot${active ? ' active' : ''}"></span>
          <span class="coss-pill-name">${escape(s.name)}</span>
          ${s.task_count ? `<span class="coss-pill-count">${s.task_count}</span>` : ''}
        </button>`;
    }).join('');
  }

  _cossRenderBody();
}

function _cossRenderBody() {
  const bodyEl = $('[data-id="coss-body"]');
  if (!bodyEl) return;

  if (!_cossSessions.length) {
    bodyEl.innerHTML = '<div class="coss-empty">No sessions yet — assign a task to a repo to start one.</div>';
    return;
  }

  const selected = _cossActiveRepoId
    ? _cossSessions.find((s) => s.id === _cossActiveRepoId)
    : _cossSessions[0];

  if (!selected) {
    bodyEl.innerHTML = '<div class="coss-empty">Select a session above.</div>';
    return;
  }

  const ago = selected.last_used ? formatAgo(Date.now() - selected.last_used) : '—';
  bodyEl.innerHTML = `
    <div class="coss-session-card">
      <div class="coss-session-name">${escape(selected.name)}</div>
      <div class="coss-session-meta">
        ${selected.task_count ? `<span>${selected.task_count} task${selected.task_count !== 1 ? 's' : ''}</span>` : ''}
        <span>last active ${ago}</span>
      </div>
      <div class="coss-session-hint">Type a message below to talk to this session →</div>
    </div>`;
}

/* ---------- top-level ---------- */

export function renderAll(store) {
  renderConnection(store);
  renderState(store);
  renderAi(store);
  renderNotes(store);
  renderNotesQuickView(store);
  renderBriefingQuickView(store);
  renderBriefing(store);
  renderPushPanel();
  updateRepoMicSelect(store.state?.repo_sessions || []);
  renderCOSSQueue(store.state?.repo_sessions || []);
}

/** Populate the repo selector(s) on the home screen from /state.repo_sessions. */
export function updateRepoMicSelect(sessions) {
  const selects = document.querySelectorAll(
    '[data-id="repo-mic-select"], [data-id="d-repo-mic-select"]'
  );
  const saved = localStorage.getItem('galt_repo_mic_repo_id');

  for (const sel of selects) {
    sel.innerHTML = '<option value="">— Ask Claude —</option>';
    if (!sessions || sessions.length === 0) {
      sel.disabled = true;
      continue;
    }
    sel.disabled = false;
    for (const s of sessions) {
      const opt = document.createElement('option');
      opt.value = String(s.id);
      opt.textContent = s.name;
      sel.appendChild(opt);
    }
    const restore = saved || (sessions[0]?.id ? String(sessions[0].id) : '');
    if ([...sel.options].some((o) => o.value === restore)) {
      sel.value = restore;
    } else {
      sel.value = sessions[0] ? String(sessions[0].id) : '';
    }
  }
}

/* ---------- push notifications panel (settings sheet) ----------
   Reads from Notification.permission + localStorage (set by
   push.js on enable/disable). Re-renders on every store tick
   because there's no observable for permission changes; this
   keeps the panel honest if the user grants/revokes in OS
   settings outside the app. */
export function renderPushPanel() {
  const titleEl = document.querySelector('[data-id="push-status-title"]');
  const subEl   = document.querySelector('[data-id="push-status-sub"]');
  const toggle  = document.querySelector('[data-id="push-toggle-btn"]');
  const testBtn = document.querySelector('[data-id="push-test-btn"]');
  if (!titleEl || !subEl || !toggle || !testBtn) return;

  const supported = 'serviceWorker' in navigator
                 && 'Notification' in window
                 && 'PushManager' in window;
  if (!supported) {
    titleEl.textContent = 'Push notifications';
    subEl.textContent = 'not supported in this browser';
    toggle.disabled = true;
    toggle.style.opacity = '0.5';
    testBtn.disabled = true;
    testBtn.style.opacity = '0.5';
    return;
  }

  const perm = Notification.permission;
  const hasToken = !!localStorage.getItem('galt:push:token');
  const isOn = perm === 'granted' && hasToken;

  if (perm === 'denied') {
    subEl.textContent = 'blocked — enable in browser settings';
    toggle.disabled = true;
    toggle.style.opacity = '0.5';
    toggle.textContent = 'Enable';
  } else if (isOn) {
    subEl.textContent = 'enabled — this device will receive pushes';
    toggle.disabled = false;
    toggle.style.opacity = '1';
    toggle.textContent = 'Disable';
  } else {
    subEl.textContent = perm === 'granted'
      ? 'permission granted — tap Enable to register this device'
      : 'tap Enable to grant permission + register this device';
    toggle.disabled = false;
    toggle.style.opacity = '1';
    toggle.textContent = 'Enable';
  }

  // Test button: needs at least one registered device. We always
  // allow it when push is enabled on THIS device (so the user can
  // smoke-test); the backend will fan out to all registered tokens.
  testBtn.disabled = !isOn;
  testBtn.style.opacity = isOn ? '1' : '0.5';
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

  // Away message box — visible only when away is on
  for (const el of document.querySelectorAll('[data-id$="away-edit-btn"]')) {
    el.style.display = away ? '' : 'none';
  }
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

/* ---------- AI provider / model / usage ---------- */

function renderAi(store) {
  const ai = store.state?.ai;
  const html = ai ? renderAiPanel(ai) : '<div class="ai-empty">— no AI data yet —</div>';
  for (const el of document.querySelectorAll('[data-id$="ai-panel"]')) {
    el.innerHTML = html;
  }
}

function renderAiPanel(ai) {
  const today    = ai.today    || ZERO_BUCKET;
  const last30   = ai.last_30d || ZERO_BUCKET;
  const allTime  = ai.all_time || ZERO_BUCKET;
  return `
    <div class="ai-head">
      <span class="ai-label">AI</span>
      <span class="ai-provider">${escape(ai.provider || '—')}</span>
    </div>
    <div class="ai-model">${escape(ai.model || '—')}</div>
    <div class="ai-rows">
      <div class="ai-row">
        <span class="ai-row-label">today</span>
        <span class="ai-row-cost">${fmtUsd(today.cost_usd)}</span>
        <span class="ai-row-meta">${fmtNum(today.calls)} calls · ${fmtTokens(today.total_tokens)}</span>
      </div>
      <div class="ai-row">
        <span class="ai-row-label">30d</span>
        <span class="ai-row-cost">${fmtUsd(last30.cost_usd)}</span>
        <span class="ai-row-meta">${fmtNum(last30.calls)} calls · ${fmtTokens(last30.total_tokens)}</span>
      </div>
      <div class="ai-row">
        <span class="ai-row-label">total</span>
        <span class="ai-row-cost">${fmtUsd(allTime.cost_usd)}</span>
        <span class="ai-row-meta">${fmtNum(allTime.calls)} calls · ${fmtTokens(allTime.total_tokens)}</span>
      </div>
    </div>
  `;
}

const ZERO_BUCKET = { calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0 };

function fmtUsd(v) {
  const n = Number(v) || 0;
  if (n === 0)   return '$0.00';
  if (n < 0.01)  return '<$0.01';
  if (n < 1)     return '$' + n.toFixed(3);
  if (n < 100)   return '$' + n.toFixed(2);
  return '$' + Math.round(n).toLocaleString();
}

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v < 1_000)     return v + ' tok';
  if (v < 1_000_000) return (v / 1_000).toFixed(1).replace(/\.0$/, '') + 'K tok';
  return (v / 1_000_000).toFixed(2).replace(/\.00$/, '') + 'M tok';
}

function fmtNum(n) {
  const v = Number(n) || 0;
  return v.toLocaleString();
}

/* ---------- notes feed ---------- */

function renderNotes(store) {
  const notes = store.notes || [];
  const unreviewed = notes.filter((n) => !n.reviewed_at).length;
  const countText = `${unreviewed} unreviewed · ${notes.length} total`;

  // Count badges — home quick view + notes-page header
  for (const el of document.querySelectorAll('[data-id$="notes-count"], [data-id="notes-page-count"]')) {
    el.textContent = countText;
  }

  // Full notes list — only on the notes-page
  const fullHtml = notes.length
    ? notes.map(renderNote).join('')
    : '<div class="notes-empty">No notes yet. New inbound messages will surface here.</div>';
  const pageList = document.querySelector('[data-id="notes-page-list"]');
  if (pageList) pageList.innerHTML = fullHtml;
}

function renderNotesQuickView(store) {
  const notes = store.notes || [];
  const latest = notes[0]; // most recently added (feed is newest-first from RTDB)

  const previewHtml = latest
    ? renderNotePreview(latest)
    : '<div class="quick-view-empty">No notes yet.</div>';

  for (const el of document.querySelectorAll('[data-id="m-notes-preview"], [data-id="d-notes-preview"]')) {
    el.innerHTML = previewHtml;
  }
}

function renderNotePreview(n) {
  const name = n.contact_name || n.handle;
  const cat  = n.category || 'personal';
  const time = formatTime(n.created_at);
  return `
    <button class="quick-view-note" data-action="open-notes">
      <div class="quick-view-note-head">
        <span class="note-category" data-cat="${escape(cat)}">${escape(cat)}</span>
        <span class="note-contact">${escape(name)}</span>
        <span class="note-time">${escape(time)}</span>
      </div>
      <div class="quick-view-note-summary">${escape(n.summary || '')}</div>
    </button>`;
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
      <button class="note-body" data-action="view-source" data-note-id="${escape(n.source_local_id)}">
        <div class="note-head">
          <span class="note-category" data-cat="${escape(cat)}">${escape(cat)}</span>
          <span class="note-contact">${escape(name)}</span>
          <span class="note-time">${escape(time)}</span>
        </div>
        <div class="note-summary">${escape(n.summary || '')}</div>
        ${body ? `<div class="note-message">"${escape(body)}"</div>` : ''}
        <div class="note-view-hint">tap to view source →</div>
      </button>
      <div class="note-actions">
        ${reviewed
          ? `<button data-action="unreview-note" data-note-id="${escape(n.source_local_id)}">unreview</button>`
          : `<button data-action="review-note"   data-note-id="${escape(n.source_local_id)}">mark reviewed</button>`}
        <button class="danger" data-action="delete-note" data-note-id="${escape(n.source_local_id)}">delete</button>
      </div>
    </div>`;
}

/* ---------- source-message sheet renderer ---------- */

export function renderSourceSheet(data) {
  const body = document.querySelector('[data-id="source-body"]');
  if (!body) return;
  if (!data) {
    body.innerHTML = '<div class="field-help">Loading…</div>';
    return;
  }
  const name = data.contact_name || data.handle;
  const time = formatTime(data.created_at);
  const cat = data.category || 'personal';
  const text = data.message_text || '';
  body.innerHTML = `
    <div class="source-meta">
      <span class="note-category" data-cat="${escape(cat)}">${escape(cat)}</span>
      <span class="source-from">${escape(name)}</span>
      <span class="source-time">${escape(time)}</span>
    </div>
    <div class="source-summary">${escape(data.summary || '')}</div>
    ${text
      ? `<div class="source-message">${escape(text)}</div>`
      : '<div class="source-empty">— no source text was captured for this note —</div>'}
  `;
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
  for (const name of ['settings', 'away', 'status', 'source', 'cos', 'coss', 'task-detail']) closeSheet(name);
  closeRepoPage();
}

/* ---------- task detail sheet ---------- */

/** Populate and open the task detail sheet.
 *  @param {Object} task  — task object from repo snapshot (includes body, title, etc.)
 *  @param {Object} repo  — repo object (for action buttons)
 *  @param {Object} phaseMap — phase_num → phase for the phase label
 */
export function renderTaskDetail(task, repo, phaseMap = {}) {
  const idEl      = document.querySelector('[data-id="tds-task-id"]');
  const badgeEl   = document.querySelector('[data-id="tds-badge"]');
  const phaseEl   = document.querySelector('[data-id="tds-phase"]');
  const ageEl     = document.querySelector('[data-id="tds-age"]');
  const titleEl   = document.querySelector('[data-id="tds-title"]');
  const bodyEl    = document.querySelector('[data-id="tds-body"]');
  const actionsEl = document.querySelector('[data-id="tds-actions"]');
  if (!idEl) return;

  const isStub  = !!task.is_stub;
  const phase   = task.phase_num != null ? phaseMap[task.phase_num] : null;
  const phaseLabel = phase ? `P${task.phase_num} · ${phase.name}` : task.phase_num != null ? `P${task.phase_num}` : '';

  idEl.textContent    = task.task_id;
  badgeEl.textContent = isStub ? 'stub' : 'spec';
  badgeEl.className   = `tds-badge ${isStub ? 'stub' : 'spec'}`;
  phaseEl.textContent = phaseLabel;
  phaseEl.style.display = phaseLabel ? '' : 'none';

  if (task.days != null) {
    ageEl.textContent = task.days + 'd';
    ageEl.className   = `tds-age${task.stale ? ' stale' : ''}`;
    ageEl.style.display = '';
  } else {
    ageEl.style.display = 'none';
  }

  titleEl.textContent = task.title || task.task_id;

  if (task.body?.trim()) {
    bodyEl.innerHTML = `<span class="tds-body-text">${escape(task.body)}</span>`;
  } else {
    bodyEl.innerHTML = `<span class="tds-body-empty">${isStub ? 'No spec yet — this task is a stub. Use Spec to have Claude write it.' : 'No body content found for this task.'}</span>`;
  }

  // Action button — Assign for specs, Spec for stubs
  if (isStub) {
    actionsEl.innerHTML = `<button class="claude-action-btn" data-action="claude-action" data-claude-action="spec" data-variant="secondary" data-repo-id="${repo.id}" data-task-id="${escape(task.task_id)}"><span class="ca-sigil">◆</span><span class="ca-label">Write Spec</span></button>`;
  } else {
    actionsEl.innerHTML = `<button class="claude-action-btn" data-action="claude-action" data-claude-action="assign" data-variant="primary" data-repo-id="${repo.id}" data-task-id="${escape(task.task_id)}"><span class="ca-sigil">◆</span><span class="ca-label">Assign to Claude</span></button>`;
  }
}

/* ---------- repo page overlay ---------- */

export function openRepoPage() {
  const page = document.querySelector('[data-id="repo-page"]');
  if (page) page.dataset.visible = 'true';
}

export function closeRepoPage() {
  const page = document.querySelector('[data-id="repo-page"]');
  if (page) page.dataset.visible = 'false';
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

function formatUptime(startedAt) {
  if (!startedAt) return '—';
  const ms = Date.now() - startedAt;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0)  return `${d}d ${h % 24}h`;
  if (h > 0)  return `${h}h ${m % 60}m`;
  if (m > 0)  return `${m}m`;
  return `${s}s`;
}

function timeOfDayGreeting() {
  const h = new Date().getHours();
  if (h < 5)  return 'Up late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

/* ---------- standup generator — shared by briefing page + quick view ---------- */

function generateStandup(store) {
  const s      = store.state?.settings;
  const health = store.state?.health;
  const ai     = store.state?.ai;
  const notes  = store.notes || [];

  const unreviewed = notes.filter((n) => !n.reviewed_at).length;
  const parts = [];

  // Notes status
  if (unreviewed === 0) {
    parts.push('Inbox clear — no unreviewed notes');
  } else {
    parts.push(`${unreviewed} note${unreviewed === 1 ? '' : 's'} waiting for review`);
  }

  // Modes
  const modeOn = [];
  const modeOff = [];
  if (s?.summon_enabled)      modeOn.push('Summon');  else modeOff.push('Summon');
  if (s?.away_mode_enabled)   modeOn.push('Away');    else modeOff.push('Away');
  if (s?.auto_notes_enabled)  modeOn.push('Notes');   else modeOff.push('Notes');
  if (modeOn.length > 0) parts.push(modeOn.join(' + ') + ' on');
  else parts.push('All modes off');

  // Health
  if (health) {
    const ok = health.chat_db_ok && health.watcher_running;
    if (ok) {
      parts.push(`Server healthy · up ${formatUptime(health.started_at)}`);
    } else {
      const issues = [];
      if (!health.chat_db_ok)      issues.push('chat.db unreachable');
      if (!health.watcher_running) issues.push('watcher stopped');
      parts.push(issues.join(', '));
    }
  }

  // AI cost today
  const todayCost = ai?.today?.cost_usd;
  if (todayCost > 0) parts.push(`${fmtUsd(todayCost)} today`);

  return parts.join('. ') + '.';
}

/* ---------- briefing quick view (home screen) ---------- */

function renderBriefingQuickView(store) {
  const standup = generateStandup(store);
  const now     = new Date();
  const dateLabel = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

  // Date badge
  for (const el of document.querySelectorAll('[data-id="m-briefing-date"], [data-id="d-briefing-date"]')) {
    el.textContent = dateLabel;
  }

  // Standup preview text — tappable, navigates to briefing page
  const previewHtml = `<div class="quick-view-standup" data-action="open-briefing">${escape(standup)}</div>`;
  for (const el of document.querySelectorAll('[data-id="m-briefing-preview"], [data-id="d-briefing-preview"]')) {
    el.innerHTML = previewHtml;
  }
}

/* ---------- briefing page ---------- */

const COMPANY_COLORS = [
  { border: '#5b9bd5', bg: 'rgba(91,155,213,.12)'  },
  { border: '#9b7fd4', bg: 'rgba(155,127,212,.12)' },
  { border: '#e8a838', bg: 'rgba(232,168,56,.12)'  },
  { border: '#d45b8a', bg: 'rgba(212,91,138,.12)'  },
  { border: '#4db8b0', bg: 'rgba(77,184,176,.12)'  },
  { border: '#e05252', bg: 'rgba(224,82,82,.12)'   },
  { border: '#7cb776', bg: 'rgba(124,183,118,.12)' },
  { border: '#c9c84a', bg: 'rgba(201,200,74,.12)'  },
];
function coColor(name) {
  if (!name || name === '—') return null;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return COMPANY_COLORS[h % COMPANY_COLORS.length];
}

const PHASE_EMOJI = { queued: '📋', active: '🚧', shipped: '✅', unknown: '❓' };

function renderBriefing(store) {
  const body = document.querySelector('[data-id="briefing-body"]');
  if (!body) return;

  const s      = store.state?.settings;
  const health = store.state?.health;
  const notes  = store.notes || [];
  const repos  = store.repos || [];   // live from RTDB /repos subscription
  const now    = new Date();

  // ── Greeting header ────────────────────────────────────────────
  const standup  = generateStandup(store);
  const greeting = timeOfDayGreeting();
  const dayName  = now.toLocaleDateString([], { weekday: 'long' });
  const dayDate  = now.toLocaleDateString([], { month: 'short', day: 'numeric' });

  const greetBlock = `
    <div class="brf-greet">
      <div class="brf-eyebrow">${escape(dayName)} <span class="brf-day-accent">· ${escape(dayDate)}</span></div>
      <div class="brf-day">${escape(greeting)}</div>
      <div class="brf-standup">${escape(standup)}</div>
    </div>`;

  // ── Compact Galt stat strip ────────────────────────────────────
  const unreviewed = notes.filter((n) => !n.reviewed_at).length;
  const isLive     = health?.chat_db_ok && health?.watcher_running;
  const summonOn   = !!s?.summon_enabled;
  const awayOn     = !!s?.away_mode_enabled;

  const statStrip = `
    <div class="brf-stats">
      <div class="brf-stat">
        <span class="brf-stat-dot ${isLive ? 'ok' : 'bad'}"></span>
        <span>${isLive ? 'live' : 'offline'}</span>
      </div>
      <div class="brf-stat">
        <span class="brf-stat-num ${unreviewed > 0 ? 'amber' : 'dim'}">${unreviewed}</span>
        <span>notes</span>
      </div>
      <div class="brf-stat">
        <span class="brf-stat-dot ${summonOn ? 'ok' : 'dim'}"></span>
        <span>summon</span>
      </div>
      <div class="brf-stat">
        <span class="brf-stat-dot ${awayOn ? 'warn' : 'dim'}"></span>
        <span>away</span>
      </div>
    </div>`;

  // ── Repos section — driven by store.repos (live RTDB) ─────────
  let reposHtml;
  let repoRows = '';
  if (repos.length === 0) {
    reposHtml = `
      <div class="brf-section">
        <div class="brf-section-tag">Repos</div>
        <div class="brf-panel">
          <div class="brf-empty">No repos registered yet.</div>
        </div>
      </div>`;
  } else {
    // Cross-repo derived data
    const totalActive = repos.reduce((s, r) => s + (r.active_tasks?.length ?? 0), 0);
    const staleTasks = repos.flatMap((r) =>
      (r.active_tasks || [])
        .filter((t) => t.stale)
        .map((t) => ({ ...t, repo_name: r.name, company: r.company }))
    ).sort((a, b) => (b.days ?? 0) - (a.days ?? 0));

    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const recentAudit = repos.flatMap((r) =>
      (r.audit || [])
        .filter((e) => e.date >= cutoff)
        .map((e) => ({ ...e, repo_name: r.name, company: r.company }))
    ).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);

    // Oldest updated_at across all repos — shows how fresh the data is
    const oldestUpdate = repos.reduce((min, r) => Math.min(min, r.updated_at || Date.now()), Date.now());
    const syncAge = Math.floor((Date.now() - oldestUpdate) / 60000);
    const syncLabel = syncAge < 2 ? 'just now' : syncAge < 60 ? `${syncAge}m ago` : `${Math.floor(syncAge / 60)}h ago`;

    // Top bar
    const topBar = `
      <div class="brp-bar">
        <span class="brp-bar-stat">${repos.length} repo${repos.length !== 1 ? 's' : ''}</span>
        <span class="brp-bar-sep">·</span>
        <span class="brp-bar-stat">${totalActive} active</span>
        ${staleTasks.length > 0 ? `<span class="brp-stale-badge">⚠ ${staleTasks.length} stale</span>` : ''}
        <button class="brp-refresh-btn" data-action="briefing-refresh" title="Refresh repos">↻</button>
      </div>`;

    // Needs attention (stale tasks)
    const attentionHtml = staleTasks.length ? `
      <div class="brp-panel-section">
        <div class="brp-panel-label">⚠ Needs attention</div>
        ${staleTasks.map((t) => `
          <div class="brp-stale-row">
            <span class="brp-stale-repo">${escape(t.repo_name)}</span>
            <span class="brp-stale-title">${escape(t.title || t.task_id)}</span>
            <span class="brp-stale-days">${t.days}d</span>
          </div>`).join('')}
      </div>` : '';

    // Recent activity
    const activityHtml = recentAudit.length ? `
      <div class="brp-panel-section">
        <div class="brp-panel-label">Recent activity</div>
        ${recentAudit.map((e) => `
          <div class="brp-activity-row">
            <span class="brp-activity-emoji">${escape(e.emoji)}</span>
            <span class="brp-activity-text">${escape(e.text)}</span>
            <span class="brp-activity-repo">${escape(e.repo_name)}</span>
            <span class="brp-activity-date">${escape(e.date?.slice(5) ?? '')}</span>
          </div>`).join('')}
      </div>` : '';

    // Group repos by company
    const byCompany = {};
    for (const r of repos) {
      const co = r.company || '—';
      if (!byCompany[co]) byCompany[co] = [];
      byCompany[co].push(r);
    }

    repoRows = Object.entries(byCompany).map(([company, repoList]) => {
      const col = coColor(company);
      const coNameStyle  = col ? ` style="color:${col.border}"` : '';

      const divider = `
        <div class="brp-co-divider">
          <span class="brp-co-name"${coNameStyle}>${escape(company)}</span>
          <span class="brp-co-line"></span>
        </div>`;

      const rows = repoList.map((r) => {
        const activeCount = (r.active_tasks || []).length;
        const staleCount  = r.stale_count ?? 0;
        const backlog     = r.backlog_count ?? 0;
        const done        = r.done_count ?? 0;
        const openPRList  = r.open_prs || [];
        const phases      = r.phases || [];

        // Phase dots — each phase is a colored dot
        const phaseDots = phases.length
          ? `<span class="brp-phase-dots">${
              phases.map((p) => `<span class="brp-phase-dot ${escape(p.status)}" title="${escape(p.name)}"></span>`).join('')
            }</span>`
          : '';

        const dot = staleCount > 0 ? 'warn' : activeCount > 0 ? 'ok' : '';

        // Company color: left border + tinted bg + glow on the border
        const rowStyle = col
          ? ` style="border-left-color:${col.border};background:${col.bg};box-shadow:-3px 0 14px ${col.border}40"`
          : '';

        const activePill  = `<div class="brp-stat-pill"><span class="brp-stat-num${activeCount > 0 ? ' has-active' : ''}">${activeCount}</span><span>active</span></div>`;
        const backlogPill = `<div class="brp-stat-pill"><span class="brp-stat-num">${backlog}</span><span>backlog</span></div>`;
        const donePill    = `<div class="brp-stat-pill"><span class="brp-stat-num">${done}</span><span>done</span></div>`;
        const phasePill   = phases.length ? `<div class="brp-stat-pill">${phaseDots}</div>` : '';

        // Horizontal PR scroll rail — shown only when there are open PRs
        const prRail = openPRList.length ? `
          <div class="brp-pr-rail" data-action-stop>
            ${openPRList.map((x) => {
              const pr = x.pr;
              const titleShort = (pr.title || '').length > 55
                ? String(pr.title).slice(0, 55) + '…'
                : (pr.title || '');
              const accentStyle = col ? ` style="border-color:${col.border}33"` : '';
              return `
                <div class="brp-pr-chip"${accentStyle}>
                  <div class="brp-pr-chip-top">
                    <span class="brp-pr-chip-num">#${escape(pr.number)}</span>
                    <a class="brp-pr-chip-view" href="${escape(pr.url)}" target="_blank" rel="noopener" data-action-stop>↗</a>
                  </div>
                  <div class="brp-pr-chip-title">${escape(titleShort)}</div>
                  <div class="brp-pr-chip-branch">⎇ ${escape(pr.branch || '')}</div>
                  <div class="brp-pr-chip-actions">
                    <button class="brp-pr-chip-merge" data-action="approve-pr"
                      data-task-id="${escape(x.task_id)}" data-repo-id="${r.id}" data-pr-number="${escape(pr.number)}">✓ Merge</button>
                    <button class="brp-pr-chip-close" data-action="deny-pr"
                      data-task-id="${escape(x.task_id)}" data-repo-id="${r.id}" data-pr-number="${escape(pr.number)}">✗ Close</button>
                  </div>
                </div>`;
            }).join('')}
          </div>` : '';

        return `
          <div class="brp-repo-row" data-action="open-repo" data-repo-id="${r.id}"${rowStyle} role="button" tabindex="0">
            <div class="brp-repo-top">
              <span class="brp-repo-dot ${escape(dot)}"></span>
              <div class="brp-repo-info">
                <span class="brp-repo-name">${escape(r.name)}</span>
                ${r.branch ? `<div class="brp-repo-sub"><span class="brp-branch">⎇ ${escape(r.branch)}</span></div>` : ''}
              </div>
              <span class="brp-repo-chevron">›</span>
            </div>
            <div class="brp-repo-stats">
              ${openPRList.length ? `<div class="brp-stat-pill"><span class="brp-stat-num has-prs">${openPRList.length}</span><span>PR${openPRList.length !== 1 ? 's' : ''}</span></div>` : ''}
              ${activePill}${backlogPill}${donePill}${phasePill}
            </div>
            ${prRail}
          </div>`;
      }).join('');

      return divider + rows;
    }).join('');

    reposHtml = topBar + attentionHtml + activityHtml;
  }

  body.innerHTML =
    greetBlock +
    statStrip +
    reposHtml +
    repoRows +
    '<div style="height:24px;"></div>';

  // Also render repo cards on the home screen
  const homeRepoList = document.querySelector('[data-id="home-repo-list"]');
  if (homeRepoList) homeRepoList.innerHTML = repoRows;
}

/* ---------- global PR card ---------- */

/**
 * Render a PR as a `.chat-task-pr-card` — the same gorgeous design used in
 * the Claude Output Sheet. Pass the PR object and action identifiers.
 *
 * @param {object} pr       — { number, title, body, branch, url, state, repo_name, repo_id }
 * @param {string} taskId   — COS task id (for approve-pr / deny-pr data attrs)
 * @param {number} repoId   — repo id (for data attrs)
 * @returns {string} HTML string
 */
export function renderPRCard(pr, taskId, repoId) {
  const isOpen   = pr.state === 'open';
  const isMerged = pr.state === 'merged';
  const stateIcon = isMerged ? '✓' : pr.state === 'closed' ? '✗' : '⎇';

  const bodyPreview = (() => {
    if (!pr.body) return '';
    const first = pr.body.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('>'));
    if (!first) return '';
    return first.length > 120 ? first.slice(0, 120) + '…' : first;
  })();

  return `
    <div class="chat-task-pr-card">
      <div class="task-pr-top">
        <div class="task-pr-breadcrumb">
          <span class="task-pr-repo">${escape(pr.repo_name || '')}</span>
          <span class="task-pr-sep">›</span>
          <span class="task-pr-num">#${escape(pr.number)}</span>
          <span class="task-pr-state-badge task-pr-state-${escape(pr.state)}">${stateIcon} ${escape(pr.state)}</span>
        </div>
        <a class="task-pr-open-btn" href="${escape(pr.url)}" target="_blank" rel="noopener">View PR →</a>
      </div>
      <div class="task-pr-title">${escape(pr.title)}</div>
      ${bodyPreview ? `<div class="task-pr-body">${escape(bodyPreview)}</div>` : ''}
      <div class="task-pr-branch">⎇ ${escape(pr.branch || '')}</div>
      ${isOpen ? `
        <div class="task-pr-actions">
          <button class="task-pr-merge-btn" data-action="approve-pr"
            data-task-id="${escape(taskId)}" data-repo-id="${escape(repoId)}" data-pr-number="${escape(pr.number)}">✓ Merge</button>
          <button class="task-pr-close-btn" data-action="deny-pr"
            data-task-id="${escape(taskId)}" data-repo-id="${escape(repoId)}" data-pr-number="${escape(pr.number)}">✗ Close</button>
        </div>` : ''}
    </div>`;
}

/* ---------- repo detail sheet ---------- */

/** Render the drill-down sheet body for a single repo. Writes directly into
 *  the sheet DOM. The caller is responsible for opening the sheet. */
export function renderRepoSheet(repo) {
  const titleEl = document.querySelector('[data-id="repo-sheet-title"]');
  const bodyEl  = document.querySelector('[data-id="repo-sheet-body"]');
  if (!titleEl || !bodyEl) return;

  titleEl.textContent = repo.name + (repo.company ? ` · ${repo.company}` : '');

  // Build a phase-num → phase lookup for headers.
  const phaseMap = {};
  for (const p of (repo.phases || [])) phaseMap[p.phase_num] = p;

  // ── Render one task row ──────────────────────────────────────────
  const taskRow = (t, actionable) => {
    const isStub   = !!t.is_stub;
    const badge    = isStub
      ? `<span class="rsh-stub-badge">stub</span>`
      : `<span class="rsh-spec-badge">spec</span>`;

    let actionBtn = '';
    if (actionable) {
      if (isStub) {
        actionBtn = `<button class="claude-action-btn rsh-opt-inline" data-action="claude-action" data-claude-action="spec" data-variant="secondary" data-repo-id="${repo.id}" data-task-id="${escape(t.task_id)}"><span class="ca-sigil">◆</span><span class="ca-label">Spec</span></button>`;
      } else {
        actionBtn = `<button class="claude-action-btn rsh-opt-inline" data-action="claude-action" data-claude-action="assign" data-variant="primary" data-repo-id="${repo.id}" data-task-id="${escape(t.task_id)}"><span class="ca-sigil">◆</span><span class="ca-label">Assign</span></button>`;
      }
    }

    return `
      <div class="rsh-task-row${t.stale ? ' stale' : ''}">
        <div class="rsh-task-head">
          <span class="rsh-task-id">${escape(t.task_id)}</span>
          ${badge}
          ${t.days != null ? `<span class="rsh-task-age${t.stale ? ' stale' : ''}">${t.days}d</span>` : ''}
          ${actionBtn}
        </div>
        <div class="rsh-task-title">${escape(t.title || '')}</div>
      </div>`;
  };

  // ── Backlog grouped by phase ─────────────────────────────────────
  const backlogByPhase = () => {
    const tasks = repo.backlog_tasks || [];
    if (tasks.length === 0) {
      return `<div class="rsh-section-empty">No backlog tasks</div>`;
    }

    // Group by phase_num (null → ungrouped)
    const groups = {};
    for (const t of tasks) {
      const key = t.phase_num ?? '__none__';
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    }

    // Sort: numbered phases ascending, ungrouped last
    const keys = Object.keys(groups).sort((a, b) => {
      if (a === '__none__') return 1;
      if (b === '__none__') return -1;
      return Number(a) - Number(b);
    });

    return keys.map((key) => {
      const group = groups[key];
      let header = '';
      if (key !== '__none__') {
        const phase = phaseMap[Number(key)];
        const pName  = phase ? phase.name : `Phase ${key}`;
        const pEmoji = phase ? (PHASE_EMOJI[phase.status] ?? '') : '';
        const stubs  = group.filter((t) => t.is_stub).length;
        const specs  = group.length - stubs;
        header = `
          <div class="rsh-phase-group-header">
            <span class="rsh-phase-group-label">${pEmoji} P${escape(key)} · ${escape(pName)}</span>
            <span class="rsh-phase-group-meta">${specs > 0 ? `${specs} spec` : ''}${specs > 0 && stubs > 0 ? ' · ' : ''}${stubs > 0 ? `${stubs} stub` : ''}</span>
          </div>`;
      }
      const rows = group.map((t) => taskRow(t, true)).join('');
      return `<div class="rsh-phase-group">${header}${rows}</div>`;
    }).join('');
  };

  // ── Active task list (flat, with assign/spec) ────────────────────
  const activeSection = () => {
    const tasks = repo.active_tasks || [];
    if (tasks.length === 0) return `<div class="rsh-section-empty">No active tasks</div>`;
    return tasks.map((t) => taskRow(t, true)).join('');
  };

  // ── Done task list (flat, no action buttons) ─────────────────────
  const doneSection = () => {
    const tasks = repo.done_tasks || [];
    if (tasks.length === 0) return `<div class="rsh-section-empty">No recent done tasks</div>`;
    return tasks.map((t) => taskRow(t, false)).join('');
  };

  // ── Phases list ──────────────────────────────────────────────────
  const phasesSection = () => {
    const phases = repo.phases || [];
    if (phases.length === 0) return `<div class="rsh-section-empty">No phases defined</div>`;
    return phases.map((p) => `
      <div class="rsh-phase-row">
        <span class="rsh-phase-num">P${escape(p.phase_num)}</span>
        <span class="rsh-phase-name">${escape(p.name)}</span>
        <span class="rsh-phase-status brp-phase-${escape(p.status)}">${PHASE_EMOJI[p.status] ?? ''} ${escape(p.status)}</span>
      </div>`).join('');
  };

  const branchLine = repo.branch
    ? `<span class="brp-branch">⎇ ${escape(repo.branch)}</span>`
    : '';
  const platformLine = repo.platform
    ? `<span class="rsh-platform">${escape(repo.platform)}</span>`
    : '';

  bodyEl.innerHTML = `
    <div class="rsh-repo-meta">
      ${branchLine}${platformLine}
    </div>
    <div class="rsh-qo-container">
      <div class="rsh-qo-header">
        <span class="rsh-qo-label">Quick Options</span>
        <span class="rsh-qo-hint">Hand off to Claude</span>
      </div>
      <div class="rsh-qo-row">
        <button class="rsh-quick-opt rsh-opt-create" data-action="rsh-create-task" data-repo-id="${repo.id}">＋ Task</button>
        <button class="rsh-quick-opt rsh-opt-create" data-action="rsh-create-phase" data-repo-id="${repo.id}">⊕ Phase</button>
      </div>
    </div>
    <div class="rsh-create-form" data-id="rsh-create-form" style="display:none">
      <div class="rsh-create-label" data-id="rsh-create-label">Describe what you want…</div>
      <div class="dict-input-wrap">
        <textarea class="rsh-create-textarea" data-id="rsh-create-input" rows="5" placeholder="Tell Claude what you want. Be as specific as you like — what it does, why it matters, what done looks like, edge cases, constraints…" autocomplete="off"></textarea>
        <button class="dict-btn" data-action="dict-mic" data-dict-state="idle" aria-label="Dictate" title="Tap to dictate">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>
        </button>
      </div>
      <div class="rsh-create-actions">
        <button class="claude-action-btn" data-action="claude-action" data-claude-action="create" data-variant="primary"><span class="ca-sigil">◆</span><span class="ca-label">→ Create</span></button>
        <button class="rsh-quick-opt rsh-opt-cancel" data-action="rsh-create-cancel">Cancel</button>
      </div>
    </div>
    <div class="rsh-tabs" data-id="rsh-tabs">
      <button class="rsh-tab active" data-action="rsh-tab" data-tab="backlog">Backlog (${repo.backlog_count ?? 0})</button>
      <button class="rsh-tab" data-action="rsh-tab" data-tab="active">Active (${(repo.active_tasks || []).length})</button>
      <button class="rsh-tab" data-action="rsh-tab" data-tab="phases">Phases</button>
      <button class="rsh-tab" data-action="rsh-tab" data-tab="done">Done (${repo.done_count ?? 0})</button>
    </div>
    <div class="rsh-tab-panels">
      <div class="rsh-tab-panel" data-tab-panel="backlog">
        ${backlogByPhase()}
      </div>
      <div class="rsh-tab-panel" data-tab-panel="active" style="display:none">
        ${activeSection()}
      </div>
      <div class="rsh-tab-panel" data-tab-panel="phases" style="display:none">
        ${phasesSection()}
      </div>
      <div class="rsh-tab-panel" data-tab-panel="done" style="display:none">
        ${doneSection()}
      </div>
    </div>
  `;
}

/** Render the full-screen repo task management page.
 *  Populates 3 fixed DOM targets inside .page-overlay[data-id="repo-page"]:
 *    [data-id="rpo-top"]    — always-visible: quick opts + create form + PRs
 *    [data-id="rsh-tabs"]   — always-visible: tab strip (fixed, never scrolls)
 *    [data-id="rpo-content"] — scrollable: active tab panel only
 *
 *  @param {Object}   repo      — repo data from the RTDB /repos snapshot
 *  @param {Array}    openPRs   — [{taskId, pr}] from COS registry for this repo
 */
export function renderRepoPage(repo, openPRs = []) {
  const nameEl    = document.querySelector('[data-id="rpo-name"]');
  const chipsEl   = document.querySelector('[data-id="rpo-chips"]');
  const topEl     = document.querySelector('[data-id="rpo-top"]');
  const tabStripEl = document.querySelector('[data-id="rsh-tabs"]');
  const contentEl = document.querySelector('[data-id="rpo-content"]');
  if (!topEl || !tabStripEl || !contentEl) return;

  // ── Header: name + chips ─────────────────────────────────────────
  if (nameEl) nameEl.textContent = repo.name + (repo.company ? ` · ${repo.company}` : '');
  if (chipsEl) {
    chipsEl.innerHTML = [
      repo.branch   ? `<span class="rpo-chip rpo-chip-branch">⎇ ${escape(repo.branch)}</span>` : '',
      repo.platform ? `<span class="rpo-chip">${escape(repo.platform)}</span>` : '',
    ].join('');
  }

  // Build phase-num → phase lookup
  const phaseMap = {};
  for (const p of (repo.phases || [])) phaseMap[p.phase_num] = p;

  // ── Task row (new minimal list style) ───────────────────────────
  const taskRow = (t, actionable) => {
    const isStub = !!t.is_stub;
    const badge  = isStub
      ? `<span class="rpo-task-badge rpo-task-badge-stub">stub</span>`
      : `<span class="rpo-task-badge rpo-task-badge-spec">spec</span>`;
    const ageEl = t.days != null
      ? `<span class="rpo-task-age${t.stale ? ' stale' : ''}">${t.days}d</span>`
      : '';
    const actionBtn = actionable
      ? (isStub
          ? `<div class="rpo-task-action"><button class="claude-action-btn" data-action="claude-action" data-claude-action="spec" data-variant="secondary" data-repo-id="${repo.id}" data-task-id="${escape(t.task_id)}"><span class="ca-sigil">◆</span><span class="ca-label">Spec</span></button></div>`
          : `<div class="rpo-task-action"><button class="claude-action-btn" data-action="claude-action" data-claude-action="assign" data-variant="primary" data-repo-id="${repo.id}" data-task-id="${escape(t.task_id)}"><span class="ca-sigil">◆</span><span class="ca-label">Assign</span></button></div>`)
      : '';
    return `
      <div class="rpo-task-item${t.stale ? ' stale' : ''}" data-action="view-task" data-repo-id="${repo.id}" data-task-id="${escape(t.task_id)}" role="button" tabindex="0">
        <div class="rpo-task-meta">
          <span class="rpo-task-id">${escape(t.task_id)}</span>
          ${badge}
          ${ageEl}
          ${actionBtn}
        </div>
        <div class="rpo-task-title">${escape(t.title || '')}</div>
      </div>`;
  };

  // ── Backlog grouped by phase ─────────────────────────────────────
  const backlogByPhase = () => {
    const tasks = repo.backlog_tasks || [];
    if (!tasks.length) return `<div class="rpo-empty">No backlog tasks</div>`;
    const groups = {};
    for (const t of tasks) {
      const key = t.phase_num ?? '__none__';
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    }
    const keys = Object.keys(groups).sort((a, b) => {
      if (a === '__none__') return 1;
      if (b === '__none__') return -1;
      return Number(a) - Number(b);
    });
    return keys.map((key) => {
      const group = groups[key];
      let divider = '';
      if (key !== '__none__') {
        const phase = phaseMap[Number(key)];
        const pName  = phase ? phase.name : `Phase ${key}`;
        const pEmoji = phase ? (PHASE_EMOJI[phase.status] ?? '') : '';
        const stubs  = group.filter((t) => t.is_stub).length;
        const specs  = group.length - stubs;
        const meta   = [specs > 0 && `${specs} spec`, stubs > 0 && `${stubs} stub`].filter(Boolean).join(' · ');
        divider = `
          <div class="rpo-phase-divider">
            <span class="rpo-phase-divider-label">${pEmoji} P${escape(key)} · ${escape(pName)}</span>
            ${meta ? `<span class="rpo-phase-divider-meta">${meta}</span>` : ''}
          </div>`;
      }
      return `<div class="rpo-phase-group">${divider}${group.map((t) => taskRow(t, true)).join('')}</div>`;
    }).join('');
  };

  const activeSection = () => {
    const tasks = repo.active_tasks || [];
    return tasks.length
      ? tasks.map((t) => taskRow(t, true)).join('')
      : `<div class="rpo-empty">No active tasks</div>`;
  };

  const doneSection = () => {
    const tasks = repo.done_tasks || [];
    return tasks.length
      ? tasks.map((t) => taskRow(t, false)).join('')
      : `<div class="rpo-empty">No recently done tasks</div>`;
  };

  const phasesSection = () => {
    const phases = repo.phases || [];
    if (!phases.length) return `<div class="rpo-empty">No phases defined</div>`;
    return phases.map((p) => `
      <div class="rpo-phase-item">
        <span class="rpo-phase-item-num">P${escape(p.phase_num)}</span>
        <span class="rpo-phase-item-name">${escape(p.name)}</span>
        <span class="rpo-phase-item-status brp-phase-${escape(p.status)}">${PHASE_EMOJI[p.status] ?? ''} ${escape(p.status)}</span>
      </div>`).join('');
  };

  // ── PR section ───────────────────────────────────────────────────
  const prSection = () => {
    const openOnes = openPRs.filter((x) => x.pr?.state === 'open');
    if (!openOnes.length) return '';
    const chips = openOnes.map((x) => {
      const pr = x.pr;
      const titleShort = (pr.title || '').length > 55
        ? String(pr.title).slice(0, 55) + '…'
        : (pr.title || '');
      return `
        <div class="brp-pr-chip">
          <div class="brp-pr-chip-top">
            <span class="brp-pr-chip-num">#${escape(pr.number)}</span>
            <a class="brp-pr-chip-view" href="${escape(pr.url)}" target="_blank" rel="noopener" data-action-stop>↗</a>
          </div>
          <div class="brp-pr-chip-title">${escape(titleShort)}</div>
          <div class="brp-pr-chip-branch">⎇ ${escape(pr.branch || '')}</div>
          <div class="brp-pr-chip-actions">
            <button class="brp-pr-chip-merge" data-action="approve-pr"
              data-task-id="${escape(x.taskId)}" data-repo-id="${repo.id}" data-pr-number="${escape(pr.number)}">✓ Merge</button>
            <button class="brp-pr-chip-close" data-action="deny-pr"
              data-task-id="${escape(x.taskId)}" data-repo-id="${repo.id}" data-pr-number="${escape(pr.number)}">✗ Close</button>
          </div>
        </div>`;
    }).join('');
    return `
      <div class="rpo-pr-section">
        <div class="rpo-pr-header">
          <span class="rpo-pr-label">Pull Requests</span>
          <span class="rpo-pr-count">${openOnes.length} open</span>
        </div>
        <div class="brp-pr-rail">${chips}</div>
      </div>`;
  };

  // ── [rpo-top] Always-visible: quick options + create form + PRs ──
  topEl.innerHTML = `
    <div class="rpo-qo-bar">
      <button class="rpo-qo-btn rpo-qo-btn-create" data-action="rsh-create-task" data-repo-id="${repo.id}">＋ Task</button>
      <button class="rpo-qo-btn rpo-qo-btn-create" data-action="rsh-create-phase" data-repo-id="${repo.id}">⊕ Phase</button>
    </div>
    <div class="rpo-create-form" data-id="rsh-create-form">
      <div class="rpo-create-label" data-id="rsh-create-label">Describe what you want…</div>
      <div class="dict-input-wrap">
        <textarea class="rpo-create-textarea" data-id="rsh-create-input" rows="4"
          placeholder="Tell Claude what you want — what it does, why it matters, what done looks like…"
          autocomplete="off"></textarea>
        <button class="dict-btn" data-action="dict-mic" data-dict-state="idle" aria-label="Dictate" title="Tap to dictate">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>
        </button>
      </div>
      <div class="rpo-create-actions">
        <button class="claude-action-btn" data-action="claude-action" data-claude-action="create" data-variant="primary"><span class="ca-sigil">◆</span><span class="ca-label">→ Create</span></button>
        <button class="rpo-create-cancel" data-action="rsh-create-cancel">Cancel</button>
      </div>
    </div>
    ${prSection()}
  `;

  // ── [rsh-tabs] Fixed tab strip (never scrolls) ───────────────────
  // Both .rsh-tab (handler compat) and .rpo-tab (new styling) on each button.
  tabStripEl.innerHTML = `
    <button class="rsh-tab rpo-tab active" data-action="rsh-tab" data-tab="backlog">Backlog <span class="rpo-tab-count">${repo.backlog_count ?? 0}</span></button>
    <button class="rsh-tab rpo-tab" data-action="rsh-tab" data-tab="active">Active <span class="rpo-tab-count">${(repo.active_tasks || []).length}</span></button>
    <button class="rsh-tab rpo-tab" data-action="rsh-tab" data-tab="phases">Phases</button>
    <button class="rsh-tab rpo-tab" data-action="rsh-tab" data-tab="done">Done <span class="rpo-tab-count">${repo.done_count ?? 0}</span></button>
  `;

  // ── [rpo-content] Scrollable: tab panels ─────────────────────────
  contentEl.innerHTML = `
    <div class="rsh-tab-panel" data-tab-panel="backlog">${backlogByPhase()}</div>
    <div class="rsh-tab-panel" data-tab-panel="active"  style="display:none">${activeSection()}</div>
    <div class="rsh-tab-panel" data-tab-panel="phases"  style="display:none">${phasesSection()}</div>
    <div class="rsh-tab-panel" data-tab-panel="done"    style="display:none">${doneSection()}</div>
  `;
}
