// Inbox — unified review surface. Folds the legacy Queue (calendar +
// flags + scheduled) into the chat-list page as a tabbed top strip:
//
//   Tabs:  Chats (default) · Calendar · Flags · Scheduled
//
// Each tab pill shows a live count. The active tab's content renders
// into a single shared region. Sub-views (calendar/flags/scheduled)
// keep their own modules and renderers — this host just wires them
// into the shared chrome via their `targetEl` parameter.
//
// Also exposes the per-thread "memory notes" + "about this contact"
// blocks that the thread view re-uses on its right panel.

import { api } from '../api.js';
import { setMainHeader } from '../shell.js';
import { escapeHtml, initials, avatarClass, relTime } from '../utils.js';
import {
  chatsCache, setChatsCache,
  inboxTab,
} from '../state.js';
import { renderCalendarView } from './calendar.js';
import { renderFlagsView } from './flags.js';
import { renderScheduledView } from './scheduled.js';

/* ---------- count fetching for the tab pills + sidebar Inbox-queue badge ---------- */

async function fetchQueueCounts() {
  const out = { calendar: 0, flags: 0, scheduled: 0 };
  // Three small fan-out requests; each returns a count in its own shape.
  const [cal, flg, sch] = await Promise.allSettled([
    api('/api/calendar/proposals?status=pending&limit=1'),
    api('/api/monitor/flags?reviewed=false&limit=1'),
    api('/api/scheduled?status=pending'),
  ]);
  if (cal.status === 'fulfilled') out.calendar = cal.value.pending ?? 0;
  if (flg.status === 'fulfilled') out.flags = flg.value.unreviewed ?? 0;
  if (sch.status === 'fulfilled') out.scheduled = (sch.value.scheduled || []).length;
  return out;
}

/** Update the sidebar Inbox queue-badge (calendar + flags + scheduled
 *  total). The Inbox nav item carries TWO counters — `nav-inbox-count`
 *  for chats (live read of chat.db) and `nav-queue-badge` for unreviewed
 *  queue items. */
export function updateQueueBadge(counts) {
  const badge = document.getElementById('nav-queue-badge');
  if (!badge) return;
  const total = (counts.calendar || 0) + (counts.flags || 0) + (counts.scheduled || 0);
  if (total > 0) {
    badge.style.display = '';
    badge.textContent = String(total);
    badge.style.background = 'var(--orange)';
    badge.style.color = '#0a0c10';
    badge.title = `${counts.calendar} calendar · ${counts.flags} flags · ${counts.scheduled} scheduled`;
  } else {
    badge.style.display = 'none';
  }
}

/** Refresh just the badge — used at boot and after SSE events when the
 *  inbox isn't the current view. Cheap (3 small queries). Kept under the
 *  old `refreshQueueBadge` name so SSE wiring doesn't churn. */
export async function refreshQueueBadge() {
  try {
    const counts = await fetchQueueCounts();
    updateQueueBadge(counts);
  } catch { /* keep prior badge */ }
}

/* ---------- chat list (the default "Chats" tab) ---------- */

export function renderChatRow(c) {
  // Group chats: chat.chat_identifier is `chat<digits>`. 1:1 chats: it's
  // the recipient handle. Detect with a regex — same shape used in
  // thread.js. For groups we want a friendlier label than `chat<id>`.
  const isGroup = /^chat\d+$/i.test(c.identifier || '');
  const name = isGroup
    ? (c.display_name || `Group chat`)
    : (c.contact_name || c.display_name || c.identifier || '(unknown)');
  const seed = c.identifier || c.guid || String(c.id);
  const av = avatarClass(seed);
  const init = isGroup
    ? (c.display_name
        ? c.display_name.split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase()
        : 'GR')
    : initials(c.contact_name, c.display_name, c.identifier);
  const time = relTime(c.last_date_ms);
  const previewText = c.last_text
    ? (c.last_is_from_me ? 'You: ' : '') + c.last_text
    : '[encoded message — decoder skipped]';
  // Subline: groups → "group" tag + service. 1:1 → handle (when name is
  // a contact name) + service.
  const subline = isGroup
    ? `<span class="row-group-tag">group</span>${c.service_name ? ' · ' + escapeHtml(c.service_name) : ''}`
    : (c.contact_name && c.contact_name !== c.identifier
        ? `${escapeHtml(c.identifier || '')}${c.service_name ? ' · ' + escapeHtml(c.service_name) : ''}`
        : (c.service_name ? escapeHtml(c.service_name) : ''));
  return `
    <div class="chat-row${isGroup ? ' group' : ''}" data-action="open-thread" data-chat-id="${c.id}">
      <div class="avatar ${isGroup ? 'group' : av}">${escapeHtml(init)}</div>
      <div class="row-text">
        <div class="row-name">${escapeHtml(name)}</div>
        <div class="row-handle">${subline}</div>
        <div class="row-preview">${escapeHtml(previewText)}</div>
      </div>
      <div class="row-meta">${escapeHtml(time)}</div>
    </div>
  `;
}

async function renderChatsTab(targetEl) {
  let loadErr = null;
  try {
    const { chats } = await api('/api/chats?limit=200');
    setChatsCache(chats || []);
  } catch (e) { loadErr = e; }

  const ic = document.getElementById('nav-inbox-count');
  if (ic) ic.textContent = chatsCache.length || '—';
  const sub = document.getElementById('main-pending-count');
  if (sub) sub.textContent = `${chatsCache.length} chats`;

  if (loadErr) {
    targetEl.innerHTML = `
      <div class="empty">
        <div class="empty-title">Failed to load chats.</div>
        <div class="empty-sub">${escapeHtml(loadErr.message)}</div>
        <div class="empty-sub" style="margin-top:8px;">Most likely cause: Full Disk Access not granted. System Settings → Privacy &amp; Security → Full Disk Access.</div>
      </div>`;
    return;
  }

  const chatRows = chatsCache.length
    ? chatsCache.map(renderChatRow).join('')
    : '<div class="empty"><div class="empty-title">No chats found.</div></div>';

  targetEl.innerHTML = `
    <section class="inbox-chats-section">
      <div id="inbox-chats-list">${chatRows}</div>
    </section>
  `;
}

/* ---------- tabstrip ---------- */

function tabPill(key, label, count, active) {
  // Chats shows a chat-count chip when non-zero. Queue tabs show their
  // unreviewed-count chip in amber when non-zero.
  let countLbl = '';
  if (count > 0) {
    const cls = key === 'chats' ? 'inbox-tab-count' : 'inbox-tab-count amber';
    countLbl = ` <span class="${cls}">${count}</span>`;
  }
  return `
    <button class="filter inbox-tab ${active ? 'active' : ''}" data-action="inbox-tab" data-tab="${key}">
      ${label}${countLbl}
    </button>
  `;
}

/* ---------- top-level inbox render ---------- */

export async function renderInboxView() {
  const labels = {
    chats:     '<span class="accent" id="main-pending-count">— chats</span> · live read of chat.db',
    calendar:  '<span class="accent">calendar</span> · pending event proposals from incoming messages',
    flags:     '<span class="accent">flags</span> · monitor-rule matches awaiting review',
    scheduled: '<span class="accent">scheduled</span> · queued outbound — ready to send at the chosen time',
  };
  setMainHeader({ title: 'Inbox', subHTML: labels[inboxTab] || labels.chats });

  const list = document.getElementById('drafts-list');
  if (!list) return;

  // Tabstrip + content target. The active tab's content fires immediately;
  // the count fetch (3 small queries) lands shortly and re-renders just
  // the tabstrip pills with live counts.
  list.innerHTML = `
    <div class="inbox-tabstrip" id="inbox-tabstrip">
      ${tabPill('chats', 'Chats', chatsCache.length || 0, inboxTab === 'chats')}
      ${tabPill('calendar', 'Calendar', 0, inboxTab === 'calendar')}
      ${tabPill('flags', 'Flags', 0, inboxTab === 'flags')}
      ${tabPill('scheduled', 'Scheduled', 0, inboxTab === 'scheduled')}
    </div>
    <div id="inbox-content"><div class="empty"><div class="empty-title">loading…</div></div></div>
  `;

  const content = document.getElementById('inbox-content');
  if (!content) return;
  if (inboxTab === 'chats') {
    await renderChatsTab(content);
  } else if (inboxTab === 'calendar') {
    await renderCalendarView(content);
  } else if (inboxTab === 'flags') {
    await renderFlagsView(content);
  } else if (inboxTab === 'scheduled') {
    await renderScheduledView(content);
  } else {
    await renderChatsTab(content);
  }

  // Live counts for the tab pills + the sidebar queue badge.
  fetchQueueCounts().then((counts) => {
    updateQueueBadge(counts);
    const strip = document.getElementById('inbox-tabstrip');
    if (strip) {
      strip.innerHTML = `
        ${tabPill('chats', 'Chats', chatsCache.length || 0, inboxTab === 'chats')}
        ${tabPill('calendar', 'Calendar', counts.calendar, inboxTab === 'calendar')}
        ${tabPill('flags', 'Flags', counts.flags, inboxTab === 'flags')}
        ${tabPill('scheduled', 'Scheduled', counts.scheduled, inboxTab === 'scheduled')}
      `;
    }
  }).catch(() => { /* counts stay at 0 */ });
}

/* ---------- per-contact profile (long-form prose, top of thread sidebar) ---------- */

export function renderProfileBlock(handle, profile, updatedAt) {
  const updatedLabel = updatedAt > 0
    ? `last updated ${relTime(updatedAt)}`
    : 'not yet written';
  const filled = (profile || '').trim().length > 0;
  return `
    <div class="profile-block ${filled ? 'filled' : ''}">
      <div class="notes-header">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;"><circle cx="12" cy="7" r="4"/><path d="M5.5 21a6.5 6.5 0 0 1 13 0"/></svg>
        <span>About this contact</span>
        <span class="count" style="margin-left:auto;">${escapeHtml(updatedLabel)}</span>
      </div>
      <div class="notes-sub">// fed into every AI reply (regular + away mode)</div>
      <form class="profile-form" data-form="contact-profile" data-handle="${escapeHtml(handle)}">
        <textarea name="profile" rows="6" placeholder="Who is this person? Any context for how the AI should interact with them — relationship, sensitivities, recurring topics. e.g. 'this is my wife, we have 2 kids lulu and val. we're going through a hard time so be sensitive and warm. avoid logistics talk unless she brings it up.'">${escapeHtml(profile || '')}</textarea>
        <div class="profile-actions">
          <button type="submit" class="btn primary">Save</button>
          <span class="settings-status" data-error></span>
        </div>
      </form>
    </div>
  `;
}

// loadAndRenderProfile retired — the thread workbench in views/thread.js
// now owns fetching + rendering. Use refreshWorkbenchPanel('profile', …)
// from the workbench module instead.

/* ---------- per-contact memory notes (rendered in the thread right panel) ---------- */

export function renderNotesBlock(handle, notes) {
  const items = notes.length === 0
    ? '<div class="empty-row" style="padding:6px 0;">no notes for this contact yet — first one below ↓</div>'
    : notes.map((n) => `
        <div class="note-item" data-note-id="${n.id}">
          <div class="note-body">${escapeHtml(n.body)}</div>
          <div class="note-time">${escapeHtml(relTime(n.created_at))}</div>
          <span class="note-remove" data-action="remove-note" data-id="${n.id}" title="remove">✕</span>
        </div>
      `).join('');
  return `
    <div class="notes-block">
      <div class="notes-header">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <span>Memory notes</span>
        <span class="count">${notes.length}</span>
      </div>
      <div class="notes-sub">// fed into every AI draft for this contact</div>
      <div class="note-list">${items}</div>
      <form class="note-add" data-form="contact-note" data-handle="${escapeHtml(handle)}">
        <textarea name="body" rows="1" placeholder="Add a note (e.g. 'sister, mostly parent logistics'). ⌘+Enter to save."></textarea>
        <button type="submit" class="btn primary">Add</button>
      </form>
    </div>
  `;
}

// loadAndRenderNotes retired — the thread workbench in views/thread.js
// now owns fetching + rendering. Use refreshWorkbenchPanel('notes', …)
// from the workbench module instead.
