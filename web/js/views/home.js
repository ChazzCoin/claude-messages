// Home — the dashboard landing page. Composes the most time-sensitive
// panels so the user can see the state of things at a glance without
// clicking through every section.
//
// Panels:
//   - Search bar          (live LIKE search across chat.db — folded in
//                          from the former Search nav item)
//   - Latest auto notes   (5 most recent unreviewed — top-level priority)
//   - Recent threads      (top 6 chats from inbox)
//   - Away mode controls  (toggle + greeting edit)
//   - Summon mode panel   (active sessions + trigger phrase)
//   - Upcoming events     (5 most recent pending calendar proposals)
//
// Most actions on this page reuse existing data-action handlers — clicking a
// thread row routes via 'open-thread', toggling away mode uses 'toggle-away-
// mode', auto-note actions reuse the auto-notes-view handlers, etc.

import { api } from '../api.js';
import { setMainHeader } from '../shell.js';
import { escapeHtml, initials, avatarClass, relTime, fmtCalEventTime } from '../utils.js';
import { settingsCache, setChatsCache } from '../state.js';

function recentThreadRow(c) {
  const name = c.contact_name || c.display_name || c.identifier || '(unknown)';
  const seed = c.identifier || c.guid || String(c.id);
  const av = avatarClass(seed);
  const init = initials(c.contact_name, c.display_name, c.identifier);
  const time = relTime(c.last_date_ms);
  const previewText = c.last_text
    ? (c.last_is_from_me ? 'You: ' : '') + c.last_text
    : '';
  return `
    <div class="home-thread-row" data-action="open-thread" data-chat-id="${c.id}">
      <div class="avatar ${av}">${escapeHtml(init)}</div>
      <div class="home-thread-text">
        <div class="home-thread-head">
          <span class="home-thread-name">${escapeHtml(name)}</span>
          <span class="home-thread-time">${escapeHtml(time)}</span>
        </div>
        ${previewText ? `<div class="home-thread-preview">${escapeHtml(previewText)}</div>` : ''}
      </div>
    </div>
  `;
}

function awayPanel() {
  const enabled = !!settingsCache.away_mode_enabled;
  const greeting = settingsCache.away_message || '';
  return `
    <div class="home-panel away-panel ${enabled ? 'on' : ''}">
      <div class="home-panel-head">
        <h3>Away mode</h3>
        <div class="away-toggle-switch ${enabled ? 'on' : ''}" data-action="toggle-away-mode" title="${enabled ? 'turn off' : 'turn on'}"></div>
      </div>
      <div class="home-panel-sub">
        ${enabled
          ? '<span class="ok">● ON</span> · auto-responding for opted-in contacts'
          : '<span style="color:var(--text-faint);">○ OFF</span> · auto-responder is disabled'}
      </div>
      <form class="home-greeting-form" data-form="away-greeting">
        <label class="home-field-label">Greeting <span class="desc">first canned reply</span></label>
        <textarea name="away_message" rows="4" placeholder="What should I send when an opted-in contact messages while you're away?">${escapeHtml(greeting)}</textarea>
        <div class="home-panel-actions">
          <button type="submit" class="btn primary">Save greeting</button>
          <a class="btn ghost" data-action="open-away">More away settings →</a>
          <span class="settings-status" data-error></span>
        </div>
      </form>
    </div>
  `;
}

function summonPanel(activeSessions) {
  const enabled = !!settingsCache.summon_enabled;
  const trigger = settingsCache.summon_trigger_phrase || 'GALT!!';
  const endP = settingsCache.summon_end_phrase || 'go away galt';
  const activeBlock = activeSessions.length === 0
    ? `<div class="empty-row" style="padding:6px 0;">no active summon sessions — type <code>${escapeHtml(trigger)}</code> in any chat to invoke Galt</div>`
    : activeSessions.map((s) => `
        <div class="home-summon-row">
          <span class="session-pulse"></span>
          <div class="home-summon-text">
            <div class="home-summon-name">${escapeHtml(s.contact_name || s.handle)}</div>
            <div class="home-summon-meta">${s.ai_reply_count} ${s.ai_reply_count === 1 ? 'reply' : 'replies'} · started ${escapeHtml(/* relTime */ ((Date.now() - s.started_at) / 60000).toFixed(0) + 'm ago')}</div>
          </div>
          <button class="btn ghost small" data-action="end-summon-session" data-id="${s.id}">Dismiss</button>
        </div>
      `).join('');
  return `
    <div class="home-panel summon-panel ${activeSessions.length > 0 ? 'on' : ''}">
      <div class="home-panel-head">
        <h3>Summon mode</h3>
        <span class="home-panel-link" style="cursor:default;">${enabled ? 'enabled' : 'disabled'}</span>
      </div>
      <div class="home-panel-sub">
        ${activeSessions.length > 0
          ? `<span class="ok">● ${activeSessions.length} active</span> · Galt is in conversation`
          : `Type <code>${escapeHtml(trigger)}</code> in any chat to invoke Galt · <code>${escapeHtml(endP)}</code> to dismiss`}
      </div>
      ${activeBlock}
      <div class="home-panel-actions">
        <a class="btn ghost" data-action="open-summon">Configure summon →</a>
      </div>
    </div>
  `;
}

function autoNoteCard(n) {
  const sender = n.contact_name || n.handle;
  const time = relTime(n.created_at);
  return `
    <div class="home-note-row" data-note-id="${n.id}">
      <div class="home-note-cat ${escapeHtml(n.category)}">${escapeHtml(n.category)}</div>
      <div class="home-note-text">
        <div class="home-note-summary">${escapeHtml(n.summary)}</div>
        <div class="home-note-from">from <span class="name">${escapeHtml(sender)}</span> · ${escapeHtml(time)}</div>
      </div>
      <div class="home-note-actions">
        <button class="btn ghost small" data-action="review-auto-note" data-id="${n.id}">Mark reviewed</button>
        <button class="btn ghost small" data-action="open-thread-by-handle" data-handle="${escapeHtml(n.handle)}">Open</button>
      </div>
    </div>
  `;
}

function calEventRow(p) {
  const sender = p.contact_name || p.handle;
  return `
    <div class="home-cal-row" data-cal-id="${p.id}">
      <div class="home-cal-when">📅 ${escapeHtml(fmtCalEventTime(p.start_ms, p.end_ms))}</div>
      <div class="home-cal-text">
        <div class="home-cal-title">${escapeHtml(p.title || 'Event')}</div>
        <div class="home-cal-meta">
          from <span class="name">${escapeHtml(sender)}</span>
          ${p.location ? ` · 📍 ${escapeHtml(p.location)}` : ''}
        </div>
      </div>
      <div class="home-cal-actions">
        <button class="btn primary small" data-action="cal-export" data-id="${p.id}">Add</button>
        <button class="btn ghost small" data-action="cal-dismiss" data-id="${p.id}">Skip</button>
      </div>
    </div>
  `;
}

export async function renderHomeView() {
  setMainHeader({
    title: 'Home',
    subHTML: '<span class="accent">dashboard</span> · what needs your attention',
  });
  const list = document.getElementById('drafts-list');
  if (!list) return;
  list.innerHTML = '<div class="empty"><div class="empty-title">loading…</div></div>';

  // Pull everything in parallel — page paints once when all five resolve.
  let chats = [];
  let notes = [];
  let proposals = [];
  let activeSummon = [];
  try {
    const [c, n, cal, summ] = await Promise.all([
      api('/api/chats?limit=6'),
      api('/api/auto-notes?reviewed=false&limit=5'),
      api('/api/calendar/proposals?status=pending&limit=5'),
      api('/api/summon/sessions?active=true&limit=20'),
    ]);
    chats = c.chats || [];
    notes = n.notes || [];
    proposals = cal.proposals || [];
    activeSummon = summ.sessions || [];
    // Cache chats so 'open-thread' actions can resolve handle→id from anywhere.
    if (chats.length) setChatsCache(chats);
  } catch (err) {
    list.innerHTML = `<div class="empty"><div class="empty-title">Failed to load.</div><div class="empty-sub">${escapeHtml(err.message)}</div></div>`;
    return;
  }

  const threadsBlock = chats.length === 0
    ? '<div class="empty-row" style="padding:8px 0;">no chats found — chat.db may not be readable yet</div>'
    : chats.map(recentThreadRow).join('');

  const notesBlock = notes.length === 0
    ? '<div class="empty-row" style="padding:8px 0;">no unreviewed auto notes — all caught up</div>'
    : notes.map(autoNoteCard).join('');

  const calBlock = proposals.length === 0
    ? '<div class="empty-row" style="padding:8px 0;">no upcoming events</div>'
    : proposals.map(calEventRow).join('');

  list.innerHTML = `
    <div class="home-grid">
      <div class="home-panel home-panel-search">
        <div class="search-view">
          <input type="search" class="search-input" id="search-input" placeholder="Search all messages…" autocomplete="off" />
          <div class="search-status" id="search-status">type 2+ characters to begin · LIKE search against chat.db</div>
          <div class="search-results" id="search-results"></div>
        </div>
      </div>

      <div class="home-panel home-panel-priority">
        <div class="home-panel-head">
          <h3>Latest auto notes</h3>
          <a class="home-panel-link" data-action="open-auto-notes">all notes →</a>
        </div>
        ${notesBlock}
      </div>

      <div class="home-panel">
        <div class="home-panel-head">
          <h3>Recent threads</h3>
          <a class="home-panel-link" data-action="open-inbox">all chats →</a>
        </div>
        ${threadsBlock}
      </div>

      ${awayPanel()}

      ${summonPanel(activeSummon)}

      <div class="home-panel">
        <div class="home-panel-head">
          <h3>Upcoming events</h3>
          <a class="home-panel-link" data-action="open-calendar">all events →</a>
        </div>
        ${calBlock}
      </div>
    </div>
  `;
}
