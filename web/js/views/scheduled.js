// Scheduled-messages view — queue of pending sends, plus a form to schedule
// new ones. Uses the visual datepicker component for time selection.

import { api } from '../api.js';
import { setMainHeader } from '../shell.js';
import { escapeHtml, fmtSendAt } from '../utils.js';
import { chatsCache, setScheduleFormPicker } from '../state.js';
import { mountDatePicker } from '../components/datepicker.js';

export function renderSchedCard(s) {
  const due = s.status === 'pending' && s.send_at <= Date.now() + 60_000;
  const cls = s.status === 'sent' ? 'sent' : s.status === 'failed' ? 'failed' : (due ? 'due-soon' : '');
  const recipient = s.contact_name || s.handle;
  return `
    <div class="sched-card ${cls}" data-sched-id="${s.id}">
      <div class="sched-head">
        <span class="sched-when ${due ? 'due' : ''}">${escapeHtml(fmtSendAt(s.send_at))}</span>
        <span class="sched-status ${s.status}">${s.status}</span>
      </div>
      <div class="sched-to">to <span class="name">${escapeHtml(recipient)}</span>${s.contact_name ? ' · ' + escapeHtml(s.handle) : ''}</div>
      <div class="sched-body">${escapeHtml(s.body)}</div>
      ${s.error ? `<div class="sched-error">error: ${escapeHtml(s.error)}</div>` : ''}
      <div class="sched-actions">
        ${s.status === 'pending'
          ? `<button class="btn ghost" data-action="cancel-sched" data-id="${s.id}">Cancel</button>`
          : ''}
        <button class="btn ghost" data-action="open-thread-by-handle" data-handle="${escapeHtml(s.handle)}">Open thread</button>
      </div>
    </div>
  `;
}

export async function renderScheduledView() {
  setMainHeader({
    title: 'Scheduled',
    subHTML: '<span class="accent" id="sched-count">— pending</span> · queued to send later',
    showFilters: false,
  });
  const list = document.getElementById('drafts-list');
  if (!list) return;
  setScheduleFormPicker(null); // reset; remounted below if/when the form is shown
  list.innerHTML = `
    <button class="btn add-btn" data-action="show-form" data-target="form-schedule" style="width:auto;padding:8px 14px;margin-bottom:12px;">+ schedule a message</button>
    <form class="form" id="form-schedule" data-form="schedule" style="margin-bottom:14px;">
      <select name="chat_id" required>
        <option value="">Select a chat…</option>
        ${chatsCache.map((c) => {
          const label = (c.contact_name || c.display_name || c.identifier || `chat #${c.id}`)
            + (c.identifier && (c.contact_name || c.display_name) ? ` · ${c.identifier}` : '');
          return `<option value="${c.id}">${escapeHtml(label)}</option>`;
        }).join('')}
      </select>
      <textarea name="body" placeholder="Message body…" required></textarea>
      <div data-schedule-picker style="margin-bottom: 8px;"></div>
      <div class="form-row">
        <button type="submit" class="btn primary">Schedule</button>
        <button type="button" class="btn ghost" data-action="hide-form" data-target="form-schedule">Cancel</button>
      </div>
      <div class="form-error" data-error></div>
    </form>
    <div id="sched-list"><div class="empty"><div class="empty-title">loading…</div></div></div>
  `;
  // Mount the visual picker into the schedule form.
  const pickerEl = list.querySelector('[data-schedule-picker]');
  if (pickerEl) setScheduleFormPicker(mountDatePicker(pickerEl));
  await refreshScheduledList();
}

export async function refreshScheduledList() {
  const target = document.getElementById('sched-list');
  if (!target) return;
  try {
    const r = await api('/api/scheduled');
    const all = r.scheduled || [];
    const pending = all.filter((s) => s.status === 'pending');
    const past = all.filter((s) => s.status !== 'pending');
    const countEl = document.getElementById('sched-count');
    if (countEl) countEl.textContent = `${pending.length} pending`;
    const navCount = document.getElementById('nav-scheduled-count');
    if (navCount) navCount.textContent = pending.length || '—';
    if (!all.length) {
      target.innerHTML = '<div class="empty"><div class="empty-title">No scheduled messages.</div><div class="empty-sub">Use the form above, or hit "Schedule" on any draft card.</div></div>';
    } else {
      const sortedPending = [...pending].sort((a, b) => a.send_at - b.send_at);
      const sortedPast = [...past].sort((a, b) => b.send_at - a.send_at);
      target.innerHTML = [...sortedPending, ...sortedPast].map(renderSchedCard).join('');
    }
  } catch (err) {
    target.innerHTML = `<div class="empty"><div class="empty-title">Failed to load.</div><div class="empty-sub">${escapeHtml(err.message)}</div></div>`;
  }
}

/** Just the nav-count, used by SSE handlers without re-rendering the list. */
export function refreshScheduledCount() {
  api('/api/scheduled?status=pending').then((r) => {
    const navCount = document.getElementById('nav-scheduled-count');
    if (navCount) navCount.textContent = (r.scheduled?.length ?? 0) || '—';
  }).catch(() => {});
}

/** Init-time variant: same as refreshScheduledCount but await-able. */
export async function refreshScheduledCountOnly() {
  try {
    const r = await api('/api/scheduled?status=pending');
    const n = r.scheduled?.length ?? 0;
    const el = document.getElementById('nav-scheduled-count');
    if (el) el.textContent = n || '—';
  } catch { /* ignore */ }
}
