// Flags view — monitor-rule matches. Top-level tabs (unreviewed | all),
// each card has a thread-jump and review/delete controls. Nav badge counts
// only unreviewed flags.

import { api } from '../api.js';
import { setMainHeader } from '../shell.js';
import { escapeHtml, relTime } from '../utils.js';
import { flagsTab, setFlagsTab } from '../state.js';

export function renderFlagCard(f) {
  const time = relTime(f.flagged_at);
  const sender = f.contact_name || f.handle || '(unknown)';
  const conf = typeof f.confidence === 'number' ? `· conf ${f.confidence.toFixed(2)}` : '';
  const reviewed = f.reviewed_at != null;
  return `
    <div class="flag-card ${reviewed ? 'reviewed' : 'unreviewed'}" data-flag-id="${f.id}">
      <div class="flag-rule">
        <strong>${escapeHtml(f.rule_name || 'rule')}</strong> matched
        <span class="conf">${conf}</span>
      </div>
      <div>
        <div class="flag-from">from <span class="name">${escapeHtml(sender)}</span> · ${escapeHtml(f.handle || '')}</div>
        <div class="flag-body">${escapeHtml(f.text || '')}</div>
        ${f.reasoning ? `<div class="flag-reasoning">${escapeHtml(f.reasoning)}</div>` : ''}
      </div>
      <div class="flag-meta">${escapeHtml(time)}</div>
      <div class="flag-actions">
        <button class="btn primary" data-action="open-thread" data-chat-id="${f.chat_id}">Open thread</button>
        ${!reviewed ? `<button class="btn" data-action="review-flag" data-id="${f.id}">Mark reviewed</button>` : '<span style="font-family:var(--mono);font-size:11px;color:var(--text-faint);align-self:center;">reviewed</span>'}
        <div class="spacer" style="flex:1;"></div>
        <button class="btn ghost" data-action="remove-flag" data-id="${f.id}">Delete</button>
      </div>
    </div>
  `;
}

export async function renderFlagsView() {
  setMainHeader({
    title: 'Flags',
    subHTML: '<span class="accent" id="flags-count">— unreviewed</span> · monitor-rule matches',
    showFilters: false,
  });
  const list = document.getElementById('drafts-list');
  if (!list) return;
  list.innerHTML = `
    <div style="display:flex;gap:6px;margin-bottom:12px;">
      <button class="filter ${flagsTab === 'unreviewed' ? 'active' : ''}" data-action="flags-tab" data-tab="unreviewed">unreviewed</button>
      <button class="filter ${flagsTab === 'all' ? 'active' : ''}" data-action="flags-tab" data-tab="all">all</button>
    </div>
    <div id="flags-list"><div class="empty"><div class="empty-title">loading…</div></div></div>
  `;
  await refreshFlagsList();
}

export async function refreshFlagsList() {
  const target = document.getElementById('flags-list');
  if (!target) return;
  try {
    const reviewedQuery = flagsTab === 'unreviewed' ? '?reviewed=false&limit=200' : '?limit=200';
    const r = await api(`/api/monitor/flags${reviewedQuery}`);
    const flags = r.flags || [];
    const countEl = document.getElementById('flags-count');
    if (countEl) countEl.textContent = `${r.unreviewed} unreviewed`;
    updateFlagsBadge(r.unreviewed);
    if (!flags.length) {
      target.innerHTML = `<div class="empty"><div class="empty-title">No ${flagsTab === 'unreviewed' ? 'unreviewed' : ''} flags.</div><div class="empty-sub">Set up a monitor rule in the sidebar; matching incoming messages will appear here.</div></div>`;
    } else {
      target.innerHTML = flags.map(renderFlagCard).join('');
    }
  } catch (err) {
    target.innerHTML = `<div class="empty"><div class="empty-title">Failed to load flags.</div><div class="empty-sub">${escapeHtml(err.message)}</div></div>`;
  }
}

export function updateFlagsBadge(unreviewed) {
  const badge = document.getElementById('nav-flags-badge');
  if (!badge) return;
  if (unreviewed > 0) {
    badge.style.display = '';
    badge.textContent = unreviewed;
    badge.style.background = 'var(--orange)';
    badge.style.color = '#0a0c10';
  } else {
    badge.style.display = 'none';
  }
}

export async function refreshFlagsBadgeOnly() {
  try {
    const r = await api('/api/monitor/flags?reviewed=false&limit=1');
    updateFlagsBadge(r.unreviewed ?? 0);
  } catch { /* badge stays */ }
}

export { setFlagsTab };
