// Drafts queue rendering. The standalone Drafts view was removed during
// the sidebar cleanup — drafts now live at the top of the Inbox view.
// This module still owns the per-draft card markup, the "+ new draft"
// toolbar, and the refresh-into-target helper that the inbox calls.

import { api, setPill } from '../api.js';
import { escapeHtml, initials, avatarClass, relTime } from '../utils.js';
import { chatsCache } from '../state.js';

export function renderDraftCard(d) {
  const displayName = d.contact_name || d.handle;
  const av = avatarClass(d.handle);
  const init = initials(d.contact_name, d.handle);
  const time = relTime(d.created_at);
  const reasoning = d.reasoning
    ? `<div style="margin-top:10px;font-family:var(--mono);font-size:11px;color:var(--text-faint);line-height:1.55;">${escapeHtml(d.reasoning)}</div>`
    : '';
  const subline = d.contact_name
    ? `${escapeHtml(d.handle)} · chat #${d.chat_id} · ${escapeHtml(time)}`
    : `chat #${d.chat_id} · ${escapeHtml(time)}`;
  return `
    <div class="draft" data-draft-id="${d.id}">
      <div class="draft-header">
        <div class="draft-contact">
          <div class="avatar ${av}">${escapeHtml(init)}</div>
          <div>
            <div class="draft-name">${escapeHtml(displayName)}</div>
            <div class="draft-handle">${subline}</div>
          </div>
        </div>
      </div>
      <div class="draft-body">
        <div class="draft-reply-label">
          <span>Suggested reply</span>
          <span class="model">// gpt-4o-mini</span>
        </div>
        <div class="draft-text">${escapeHtml(d.body)}</div>
        ${reasoning}
      </div>
      <div class="draft-actions">
        <button class="btn primary" data-action="approve" data-id="${d.id}" title="Send via AppleScript right now">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          Approve &amp; send
        </button>
        <button class="btn" data-action="stage" data-id="${d.id}" title="Open in Messages.app with the body pre-filled — review and send there">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
          Stage in Messages
        </button>
        <button class="btn" data-action="schedule" data-id="${d.id}" title="Schedule this draft to send later">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          Schedule
        </button>
        ${d.staged_at ? `<span style="font-family:var(--mono);font-size:10.5px;color:var(--text-faint);">staged ${escapeHtml(relTime(d.staged_at))}</span>` : ''}
        <div class="spacer"></div>
        <button class="btn ghost" data-action="discard" data-id="${d.id}">Dismiss</button>
      </div>
    </div>
  `;
}

export async function refreshDrafts() {
  let drafts = [];
  try {
    const j = await api('/api/drafts?status=pending');
    drafts = j.drafts || [];
  } catch (e) { console.warn('drafts fetch failed:', e); }

  const count = drafts.length;
  setPill('pill-drafts', count > 0 ? 'warn' : 'ok',
    `${count} draft${count === 1 ? '' : 's'} pending`);

  // Sidebar badge — show count when > 0, hide when empty.
  const badge = document.getElementById('nav-drafts-badge');
  if (badge) {
    if (count > 0) {
      badge.style.display = '';
      badge.textContent = String(count);
    } else {
      badge.style.display = 'none';
    }
  }

  // Render into the inbox-embedded drafts container. No-op when the inbox
  // isn't the current view (the next inbox render will pull fresh data).
  const list = document.getElementById('inbox-drafts-list');
  if (!list) return;
  if (drafts.length === 0) {
    list.innerHTML = '<div class="empty-row" style="padding:6px 0;color:var(--text-faint);">no pending drafts</div>';
  } else {
    list.innerHTML = drafts.map(renderDraftCard).join('');
  }
}

export function renderNewDraftToolbar() {
  const opts = chatsCache.length
    ? chatsCache.map((c) => {
        const label = (c.display_name || c.identifier || `chat #${c.id}`)
          + (c.identifier && c.display_name ? ` · ${c.identifier}` : '');
        return `<option value="${c.id}">${escapeHtml(label)}</option>`;
      }).join('')
    : '<option value="" disabled>no chats loaded — visit Inbox first</option>';
  return `
    <button class="btn add-btn" data-action="show-form" data-target="form-draft">+ new draft</button>
    <form class="form" id="form-draft" data-form="draft">
      <select name="chat_id" required>
        <option value="">Select a chat…</option>
        ${opts}
      </select>
      <textarea name="body" placeholder="Draft reply text…" required></textarea>
      <div class="form-row">
        <button type="submit" class="btn primary">Save draft</button>
        <button type="button" class="btn ghost" data-action="hide-form" data-target="form-draft">Cancel</button>
      </div>
      <div class="form-error" data-error></div>
    </form>
  `;
}

