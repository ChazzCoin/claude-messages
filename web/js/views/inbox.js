// Inbox view — the chat list, plus the per-thread "memory notes" block
// that the thread view also relies on.

import { api } from '../api.js';
import { setMainHeader } from '../shell.js';
import { escapeHtml, initials, avatarClass, relTime } from '../utils.js';
import {
  chatsCache, settingsCache, setChatsCache,
} from '../state.js';

export function renderChatRow(c) {
  // Prefer contact_name (resolved from macOS Contacts) → group display_name → handle.
  const name = c.contact_name || c.display_name || c.identifier || '(unknown)';
  const seed = c.identifier || c.guid || String(c.id);
  const av = avatarClass(seed);
  const init = initials(c.contact_name, c.display_name, c.identifier);
  const time = relTime(c.last_date_ms);
  const previewText = c.last_text
    ? (c.last_is_from_me ? 'You: ' : '') + c.last_text
    : '[encoded message — decoder skipped]';
  // Only show the raw identifier under the name when we DON'T already display the contact name.
  const subline = c.contact_name && c.contact_name !== c.identifier
    ? `${escapeHtml(c.identifier || '')}${c.service_name ? ' · ' + escapeHtml(c.service_name) : ''}`
    : (c.service_name ? escapeHtml(c.service_name) : '');
  return `
    <div class="chat-row" data-action="open-thread" data-chat-id="${c.id}">
      <div class="avatar ${av}">${escapeHtml(init)}</div>
      <div class="row-text">
        <div class="row-name">${escapeHtml(name)}</div>
        <div class="row-handle">${subline}</div>
        <div class="row-preview">${escapeHtml(previewText)}</div>
      </div>
      <div class="row-meta">${escapeHtml(time)}</div>
      <button class="row-ai" data-action="ai-draft-row" data-chat-id="${c.id}" title="Predict and draft a reply (last ${settingsCache.ai_context_count} messages)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/></svg>
      </button>
    </div>
  `;
}

export async function renderInboxView() {
  setMainHeader({
    title: 'Inbox',
    subHTML: '<span class="accent" id="main-pending-count">— chats</span> · live read of chat.db',
    showFilters: false,
  });
  const list = document.getElementById('drafts-list');
  if (list) list.innerHTML = '<div class="empty"><div class="empty-title">loading…</div></div>';

  try {
    const { chats } = await api('/api/chats?limit=200');
    setChatsCache(chats || []);
    const ic = document.getElementById('nav-inbox-count');
    if (ic) ic.textContent = chatsCache.length;
    const sub = document.getElementById('main-pending-count');
    if (sub) sub.textContent = `${chatsCache.length} chats`;
    if (!list) return;
    list.innerHTML = chatsCache.length
      ? chatsCache.map(renderChatRow).join('')
      : '<div class="empty"><div class="empty-title">No chats found.</div></div>';
  } catch (e) {
    if (list) {
      list.innerHTML = `
        <div class="empty">
          <div class="empty-title">Failed to load chats.</div>
          <div class="empty-sub">${escapeHtml(e.message)}</div>
          <div class="empty-sub" style="margin-top:8px;">Most likely cause: Full Disk Access not granted. System Settings → Privacy &amp; Security → Full Disk Access.</div>
        </div>`;
    }
  }
}

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

export async function loadAndRenderNotes(handle) {
  const el = document.getElementById('thread-notes');
  if (!el) return;
  if (!handle) { el.innerHTML = ''; return; }
  try {
    const r = await api(`/api/contacts/notes?handle=${encodeURIComponent(handle)}`);
    el.innerHTML = renderNotesBlock(handle, r.notes || []);
  } catch (e) {
    el.innerHTML = '';
    console.warn('notes fetch failed:', e);
  }
}
