// Queue — consolidated review queue. Folds three former top-level pages
// (Calendar proposals, Flags, Scheduled sends) into one tabbed view to
// reduce sidebar clutter. The underlying renderers stay in their own
// modules; this host wires them into a shared chrome with sub-tabs.
//
// Counts shown on each tab pill come from a single API sweep at mount; the
// sidebar Queue badge totals the three.

import { api } from '../api.js';
import { setMainHeader } from '../shell.js';
import { queueTab } from '../state.js';
import { renderCalendarView } from './calendar.js';
import { renderFlagsView } from './flags.js';
import { renderScheduledView } from './scheduled.js';

/* ---------- count fetching for the tab pills + sidebar badge ---------- */

async function fetchQueueCounts() {
  const out = { calendar: 0, flags: 0, scheduled: 0 };
  // Three small fan-out requests. Each returns a count in its own shape.
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

/** Update the sidebar Queue badge with the total count across the three tabs. */
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

/** Refresh just the badge — used at boot and after SSE events when Queue
 *  isn't the current view. Cheap (3 small queries). */
export async function refreshQueueBadge() {
  try {
    const counts = await fetchQueueCounts();
    updateQueueBadge(counts);
  } catch { /* keep prior badge */ }
}

/* ---------- the tabbed host view ---------- */

function tabPill(key, label, count, active) {
  const countLbl = count > 0 ? ` <span class="queue-tab-count">${count}</span>` : '';
  return `
    <button class="filter queue-tab ${active ? 'active' : ''}" data-action="queue-tab" data-tab="${key}">
      ${label}${countLbl}
    </button>
  `;
}

export async function renderQueueView() {
  setMainHeader({
    title: 'Queue',
    subHTML: '<span class="accent">review queue</span> · calendar · flags · scheduled',
  });
  const list = document.getElementById('drafts-list');
  if (!list) return;
  list.innerHTML = `
    <div class="queue-tabstrip" style="display:flex;gap:6px;margin-bottom:12px;">
      ${tabPill('calendar', 'Calendar', 0, queueTab === 'calendar')}
      ${tabPill('flags', 'Flags', 0, queueTab === 'flags')}
      ${tabPill('scheduled', 'Scheduled', 0, queueTab === 'scheduled')}
    </div>
    <div id="queue-content"><div class="empty"><div class="empty-title">loading…</div></div></div>
  `;

  // Counts for the tab pills + sidebar badge — fire alongside the active
  // tab's content render so we don't block on it.
  fetchQueueCounts().then((counts) => {
    updateQueueBadge(counts);
    // Re-render just the tab pills with the fresh counts (active state
    // unchanged — tab didn't switch).
    const strip = list.querySelector('.queue-tabstrip');
    if (strip) {
      strip.innerHTML = `
        ${tabPill('calendar', 'Calendar', counts.calendar, queueTab === 'calendar')}
        ${tabPill('flags', 'Flags', counts.flags, queueTab === 'flags')}
        ${tabPill('scheduled', 'Scheduled', counts.scheduled, queueTab === 'scheduled')}
      `;
    }
  }).catch(() => { /* counts stay at 0 */ });

  // Delegate the active tab's content rendering. Each sub-view writes
  // into the target element passed in (queue-content) instead of the
  // top-level main column.
  const content = document.getElementById('queue-content');
  if (!content) return;
  if (queueTab === 'flags') {
    await renderFlagsView(content);
  } else if (queueTab === 'scheduled') {
    await renderScheduledView(content);
  } else {
    await renderCalendarView(content);
  }
}
