// Search view — LIKE search against chat.db. Live, debounced via the
// document-level input listener wired up in actions.js.

import { api } from '../api.js';
import { setMainHeader } from '../shell.js';
import { escapeHtml, relTime } from '../utils.js';

export async function renderSearchView() {
  setMainHeader({
    title: 'Search',
    subHTML: '<span class="accent">find any message</span> · across all chats',
    showFilters: false,
  });
  const list = document.getElementById('drafts-list');
  if (!list) return;
  list.innerHTML = `
    <div class="search-view">
      <input type="search" class="search-input" id="search-input" placeholder="Search all messages…" autocomplete="off" />
      <div class="search-status" id="search-status">type 2+ characters to begin · LIKE search against chat.db</div>
      <div class="search-results" id="search-results"></div>
    </div>
  `;
  const input = document.getElementById('search-input');
  if (input) input.focus();
}

function renderSearchResults(query, results) {
  if (!results.length) {
    return '<div class="empty-row" style="padding:8px 4px;">no matches</div>';
  }
  const re = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
  return results.map((r) => {
    const who = r.is_from_me
      ? 'You'
      : (r.contact_name || r.handle || 'them');
    const chatName = r.chat_contact_name || r.chat_display_name || r.chat_identifier || `chat #${r.chat_id}`;
    const text = (r.text || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    const highlighted = text.replace(re, '<mark>$1</mark>');
    return `
      <div class="search-result" data-action="open-thread" data-chat-id="${r.chat_id}">
        <div class="sr-head">
          <div class="sr-name">${escapeHtml(chatName)}</div>
          <div class="sr-handle">${escapeHtml(r.chat_identifier || '')}</div>
          <div class="sr-time">${escapeHtml(relTime(r.date_ms))}</div>
        </div>
        <div class="sr-text"><span class="sr-author">${escapeHtml(who)}:</span>${highlighted}</div>
      </div>
    `;
  }).join('');
}

export async function runSearch(query) {
  const status = document.getElementById('search-status');
  const results = document.getElementById('search-results');
  if (!query || query.length < 2) {
    if (status) status.textContent = 'type 2+ characters to begin · LIKE search against chat.db';
    if (results) results.innerHTML = '';
    return;
  }
  if (status) status.textContent = 'searching…';
  try {
    const r = await api(`/api/messages/search?q=${encodeURIComponent(query)}&limit=100`);
    if (status) status.textContent = `${r.results.length} match${r.results.length === 1 ? '' : 'es'} · LIKE search`;
    if (results) results.innerHTML = renderSearchResults(query, r.results);
  } catch (err) {
    if (status) status.textContent = `error: ${err.message}`;
    if (results) results.innerHTML = '';
  }
}
