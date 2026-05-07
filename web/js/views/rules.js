// Sidebar monitor-rules list. Lives in the left sidebar above the
// "+ add rule" form. Pure rendering; create/edit happens via the form.

import { api } from '../api.js';
import { escapeHtml } from '../utils.js';
import { chatsCache } from '../state.js';

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

export async function refreshRules() {
  let rules = [];
  try {
    const j = await api('/api/monitor/rules');
    rules = j.rules || [];
  } catch (e) { console.warn('monitor rules fetch failed:', e); }

  const sb = document.getElementById('rules-list-sidebar');
  if (sb) sb.innerHTML = renderRulesSidebar(rules);
}
