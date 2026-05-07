// Calendar proposals view — auto-extracted events from incoming messages
// (kind="auto-calendar" rules). Tabs filter by status; nav badge counts pending.

import { api } from '../api.js';
import { setMainHeader } from '../shell.js';
import { escapeHtml, fmtCalEventTime } from '../utils.js';
import { calendarTab } from '../state.js';

export async function refreshCalendarBadgeOnly() {
  try {
    const r = await api('/api/calendar/proposals?status=pending&limit=1');
    const n = r.pending ?? 0;
    const badge = document.getElementById('nav-calendar-badge');
    if (!badge) return;
    if (n > 0) {
      badge.style.display = '';
      badge.textContent = n;
      badge.style.background = 'var(--cyan)';
      badge.style.color = '#0a0c10';
    } else {
      badge.style.display = 'none';
    }
  } catch { /* ignore */ }
}

export function renderCalCard(p) {
  const sender = p.contact_name || p.handle;
  return `
    <div class="cal-card ${p.status}" data-cal-id="${p.id}">
      <div class="cal-head">
        <div class="cal-title">${escapeHtml(p.title || 'Event')}</div>
        <div class="cal-status ${p.status}">${p.status}</div>
      </div>
      <div class="cal-when">📅 ${escapeHtml(fmtCalEventTime(p.start_ms, p.end_ms))}</div>
      ${p.location ? `<div class="cal-where">📍 ${escapeHtml(p.location)}</div>` : ''}
      <div class="cal-from">from <span class="name">${escapeHtml(sender)}</span>${p.participants ? ` · with ${escapeHtml(p.participants)}` : ''}</div>
      ${p.notes ? `<div class="cal-notes">${escapeHtml(p.notes)}</div>` : ''}
      ${p.reasoning ? `<div class="cal-reasoning">${escapeHtml(p.reasoning)}${typeof p.confidence === 'number' ? ' · conf ' + p.confidence.toFixed(2) : ''}</div>` : ''}
      <div class="cal-actions">
        ${p.status === 'pending' ? `
          <button class="btn primary" data-action="cal-export" data-id="${p.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            Add to Calendar
          </button>
          <button class="btn" data-action="cal-dismiss" data-id="${p.id}">Dismiss</button>
        ` : ''}
        <button class="btn ghost" data-action="open-thread" data-chat-id="${p.chat_id}">Open thread</button>
        <div class="spacer" style="flex:1;"></div>
        <button class="btn ghost" data-action="cal-remove" data-id="${p.id}">Delete</button>
      </div>
    </div>
  `;
}

/**
 * Render the Calendar pane. When called standalone (no target arg), takes
 * over the main column with its own header. When embedded inside the Queue
 * view, pass the host element so the Queue's header/tab-strip stay intact.
 */
export async function renderCalendarView(targetEl) {
  if (!targetEl) {
    setMainHeader({
      title: 'Calendar',
      subHTML: '<span class="accent" id="cal-count">— pending</span> · auto-extracted events',
    });
  }
  const list = targetEl || document.getElementById('drafts-list');
  if (!list) return;
  list.innerHTML = `
    <div style="display:flex;gap:6px;margin-bottom:12px;">
      <button class="filter ${calendarTab === 'pending' ? 'active' : ''}" data-action="cal-tab" data-tab="pending">pending</button>
      <button class="filter ${calendarTab === 'exported' ? 'active' : ''}" data-action="cal-tab" data-tab="exported">exported</button>
      <button class="filter ${calendarTab === 'dismissed' ? 'active' : ''}" data-action="cal-tab" data-tab="dismissed">dismissed</button>
      <button class="filter ${calendarTab === 'all' ? 'active' : ''}" data-action="cal-tab" data-tab="all">all</button>
    </div>
    <div id="cal-list"><div class="empty"><div class="empty-title">loading…</div></div></div>
  `;
  await refreshCalendarList();
}

export async function refreshCalendarList() {
  const target = document.getElementById('cal-list');
  if (!target) return;
  try {
    const q = calendarTab === 'all' ? '' : `?status=${calendarTab}`;
    const r = await api(`/api/calendar/proposals${q}`);
    const items = r.proposals || [];
    const countEl = document.getElementById('cal-count');
    if (countEl) countEl.textContent = `${r.pending ?? 0} pending`;
    refreshCalendarBadgeOnly();
    if (!items.length) {
      target.innerHTML = `<div class="empty"><div class="empty-title">No ${calendarTab !== 'all' ? calendarTab : ''} proposals.</div><div class="empty-sub">Set up a monitor rule with type <strong>auto-calendar</strong>; matching incoming messages will produce event proposals here.</div></div>`;
    } else {
      target.innerHTML = items.map(renderCalCard).join('');
    }
  } catch (err) {
    target.innerHTML = `<div class="empty"><div class="empty-title">Failed to load.</div><div class="empty-sub">${escapeHtml(err.message)}</div></div>`;
  }
}
