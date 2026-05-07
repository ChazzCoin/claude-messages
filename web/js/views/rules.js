// Sidebar "watched" contacts + monitor rules. Lives in the left sidebar
// and on the Rules detail panel; not a top-level main-column view.

import { api } from '../api.js';
import { escapeHtml, initials, avatarClass } from '../utils.js';
import { chatsCache } from '../state.js';

function renderWatched(items) {
  if (!items.length) {
    return '<div class="empty-row">none yet · use + add contact below</div>';
  }
  return items.map((w) => `
    <div class="contact-row" data-watched-id="${w.id}" title="${escapeHtml(w.handle)}">
      <div class="avatar ${avatarClass(w.handle)}">${escapeHtml(initials(w.label, w.handle))}</div>
      <div class="contact-name">${escapeHtml(w.label || w.handle)}</div>
      <span class="row-remove" data-action="remove-watched" data-id="${w.id}" title="remove">✕</span>
    </div>
  `).join('');
}

export async function refreshWatched() {
  let watched = [];
  try {
    const j = await api('/api/watched');
    watched = j.watched || [];
  } catch (e) { console.warn('watched fetch failed:', e); }
  const el = document.getElementById('watched-list');
  if (el) el.innerHTML = renderWatched(watched);
}

function scopeBadge(r) {
  if (r.scope_type === 'all') return 'all';
  if (r.scope_type === 'unknown') return 'unknown';
  // contact: prefer the contact_name from chats cache if we have it
  const meta = chatsCache.find((c) => c.identifier === r.scope_handle);
  return meta?.contact_name || meta?.display_name || r.scope_handle || '?';
}

function renderRulesSidebar(rules) {
  if (!rules.length) {
    return '<div class="empty-row">none yet · use + add rule below</div>';
  }
  return rules.map((r) => `
    <div class="contact-row" title="${escapeHtml(r.prompt)}">
      <div style="flex: 1; min-width: 0;">
        <div style="font-size: 12.5px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(r.name)}</div>
        <div style="font-family: var(--mono); font-size: 10.5px; color: var(--text-faint);">→ ${escapeHtml(scopeBadge(r))}</div>
      </div>
      <span style="font-family: var(--mono); font-size: 11px; color: ${r.enabled ? 'var(--green)' : 'var(--text-faint)'}; flex-shrink: 0;" data-action="toggle-rule" data-id="${r.id}" data-enabled="${r.enabled}" title="click to toggle">${r.enabled ? 'on' : 'off'}</span>
      <span class="row-remove" data-action="remove-rule" data-id="${r.id}" title="remove">✕</span>
    </div>
  `).join('');
}

function renderRulesPanel(rules) {
  if (!rules.length) {
    return '<div class="empty-row" style="padding:8px 0;">No monitor rules. Use the sidebar\'s "+ add rule" to create one.</div>';
  }
  return rules.map((r) => `
    <div class="rule-card">
      <div class="rule-name">${escapeHtml(r.name)}${r.enabled ? '' : ' <span style="color:var(--text-faint);font-weight:400;">(off)</span>'}</div>
      <div class="rule-trigger">scope: <span class="op">${escapeHtml(r.scope_type)}</span>${r.scope_type === 'contact' ? ' → <span class="str">' + escapeHtml(scopeBadge(r)) + '</span>' : ''}</div>
      <div style="font-size: 11.5px; color: var(--text-dim); margin-top: 6px; line-height: 1.45;">${escapeHtml(r.prompt)}</div>
    </div>
  `).join('');
}

export async function refreshRules() {
  let rules = [];
  try {
    const j = await api('/api/monitor/rules');
    rules = j.rules || [];
  } catch (e) { console.warn('monitor rules fetch failed:', e); }

  const sb = document.getElementById('rules-list-sidebar');
  if (sb) sb.innerHTML = renderRulesSidebar(rules);
  const panel = document.getElementById('rules-list-panel');
  if (panel) panel.innerHTML = renderRulesPanel(rules);
  const nc = document.getElementById('nav-rules-count');
  if (nc) nc.textContent = rules.length;
}
