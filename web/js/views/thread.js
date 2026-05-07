// Thread view — message bubbles, plus the toolbar/compose UI in the right panel.
// renderVariantCards is called from the click-handler when /api/ai/draft returns 3 options.

import { api } from '../api.js';
import { setMainHeader } from '../shell.js';
import { escapeHtml, relTime, fmtBytes } from '../utils.js';
import {
  chatsCache, settingsCache, settingsBounds,
  radarHandlesCache, TEMPERAMENTS,
} from '../state.js';
import { loadAndRenderNotes } from './inbox.js';

function renderReactions(reactions) {
  if (!reactions || reactions.length === 0) return '';
  // Group by emoji, count, list senders for tooltip.
  const groups = new Map();
  for (const r of reactions) {
    const key = r.emoji || '·';
    const entry = groups.get(key) || { emoji: key, count: 0, senders: [] };
    entry.count++;
    const who = r.is_from_me ? 'You' : (r.sender_contact_name || r.sender_handle || '?');
    entry.senders.push(who);
    groups.set(key, entry);
  }
  const badges = [...groups.values()].map((g) => {
    const tooltip = `${g.senders.join(', ')}`;
    return `<span class="reaction-badge" title="${escapeHtml(tooltip)}"><span class="emoji">${escapeHtml(g.emoji)}</span>${g.count > 1 ? `<span class="count">${g.count}</span>` : ''}</span>`;
  });
  return `<div class="reactions">${badges.join('')}</div>`;
}

function renderAttachments(attachments) {
  if (!attachments || attachments.length === 0) return '';
  return `<div class="attachments">${attachments.map((a) => {
    const name = a.transfer_name || a.filename?.split('/').pop() || 'file';
    const size = fmtBytes(a.total_bytes);
    if (a.is_image) {
      return `<a href="/api/attachments/${a.rowid}" target="_blank" rel="noopener"><img class="att-image" src="/api/attachments/${a.rowid}" alt="${escapeHtml(name)}" loading="lazy" /></a>`;
    }
    return `<a class="att-file" href="/api/attachments/${a.rowid}" target="_blank" rel="noopener" title="${escapeHtml(name)}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <span class="name">${escapeHtml(name)}</span>
      ${size ? `<span class="size">${size}</span>` : ''}
    </a>`;
  }).join('')}</div>`;
}

function renderMessageBubble(m) {
  const fromMe = m.is_from_me === 1;
  const time = relTime(m.date_ms);
  const text = m.text ?? '';
  const senderLabel = fromMe ? '' : (m.contact_name || m.handle || '');
  const hasText = text && text.trim().length > 0 && text !== '￼';
  const bubbleInner = hasText
    ? escapeHtml(text)
    : (m.attachments && m.attachments.length
        ? '' // attachments below stand on their own
        : '<span class="bubble-empty">[encoded message — decoder skipped]</span>');
  return `
    <div class="bubble-row ${fromMe ? 'me' : ''}">
      <div>
        ${hasText || !(m.attachments && m.attachments.length)
          ? `<div class="bubble ${fromMe ? 'me' : 'them'}">${bubbleInner}</div>` : ''}
        ${renderAttachments(m.attachments)}
        ${renderReactions(m.reactions)}
        <div class="bubble-meta ${fromMe ? 'right' : ''}">${escapeHtml(time)}${senderLabel ? ' · ' + escapeHtml(senderLabel) : ''}</div>
      </div>
    </div>
  `;
}

export function renderThreadToolbar(chatId) {
  const max = settingsBounds.ai_context_count?.max || 100;
  const dflt = settingsCache.ai_context_count;
  const meta = chatsCache.find((c) => c.id === chatId);
  const handle = meta?.identifier || '';
  const onRadar = !!radarHandlesCache.has(handle);
  return `
    <div class="thread-toolbar">
      <button class="btn primary" data-action="ai-draft" data-chat-id="${chatId}" title="Draft an AI reply using the last ${dflt} messages as context">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/></svg>
        Draft AI reply
      </button>
      <button class="btn" data-action="ai-summarize" data-chat-id="${chatId}" title="Quick AI summary of recent messages">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
        Summarize
      </button>
      <button class="btn" data-action="toggle-radar" data-handle="${escapeHtml(handle)}" title="${onRadar ? 'On radar — click to remove' : 'Add this contact to radar (memory bank)'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="${onRadar ? 'color: var(--green);' : ''}"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/><line x1="12" y1="12" x2="20.5" y2="3.5"/></svg>
        ${onRadar ? 'On Radar' : 'Add to Radar'}
      </button>
      <label>
        <span>context window</span>
        <input class="ctx-input" type="number" min="1" max="${max}" value="${dflt}" data-ctx-input title="How many recent messages to attach to AI calls" />
      </label>
      <span class="toolbar-status" data-toolbar-status></span>
    </div>
    <div class="summary-panel" data-summary-panel hidden></div>
  `;
}

export function renderThreadCompose(chatId) {
  const tempOpts = TEMPERAMENTS.map(
    (t) => `<option value="${t}">${t}</option>`,
  ).join('');
  const vpApplied = (settingsCache.voice_profile || '').trim().length > 0;
  return `
    <div class="compose-bar">
      <textarea data-compose-input placeholder="Type a message — or a hint for the AI (e.g. 'be warm but brief', 'ask for the address'). ⌘+Enter sends."></textarea>
      <div class="compose-actions">
        <button class="btn primary" data-action="send-direct" data-chat-id="${chatId}" title="Send what you typed directly. No AI.">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>
          Send
        </button>
        <button class="btn" data-action="ai-draft-variants" data-chat-id="${chatId}" title="Generate 3 alternative AI drafts, pick one to save">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/></svg>
          3 AI options
        </button>
        <label class="compose-tone">
          <span>tone</span>
          <select data-temperament-input>${tempOpts}</select>
        </label>
        <span class="compose-meta">last ${settingsCache.ai_context_count} msgs${vpApplied ? ' + voice profile' : ''} as context</span>
        <span class="compose-status" data-compose-status></span>
      </div>
      <div class="variants" data-variants></div>
    </div>
  `;
}

export function renderVariantCards(state) {
  const usable = state.variants.filter((v) => !v.skipped && v.body.trim().length > 0);
  if (usable.length === 0) {
    return '<div class="empty-row" style="padding:8px 0;">model returned SKIP for all variants — try adjusting your prompt or temperament</div>';
  }
  const tempBadge = state.temperament && state.temperament !== 'normal'
    ? `<span class="badge">tone: ${escapeHtml(state.temperament)}</span>` : '';
  const tokens = state.usage ? `${state.usage.total_tokens} tok total` : '';
  const noteBadge = state.contextNote ? '<span class="badge">+ context</span>' : '';
  return usable.map((v, i) => `
    <div class="variant-card" data-variant-index="${i}">
      <div class="variant-meta">
        <span class="badge">variant ${i + 1} of ${usable.length}</span>
        ${tempBadge}
        ${noteBadge}
        <span style="margin-left:auto;">${escapeHtml(tokens)}</span>
      </div>
      <div class="variant-body">${escapeHtml(v.body)}</div>
      <div class="variant-actions">
        <button class="btn primary" data-action="save-variant" data-index="${i}">Use this →</button>
        <button class="btn ghost" data-action="dismiss-variants" style="margin-left:auto;">Discard all</button>
      </div>
    </div>
  `).join('');
}

export async function renderThreadView(chatId) {
  const meta = chatsCache.find((c) => c.id === chatId);
  const title = meta?.contact_name || meta?.display_name || meta?.identifier || `Chat #${chatId}`;
  setMainHeader({
    title,
    subHTML: `<a class="back-link" data-action="back-to-inbox">← back to inbox</a>${meta?.identifier ? ' · ' + escapeHtml(meta.identifier) : ''}`,
    showFilters: false,
  });
  const tb = document.getElementById('thread-toolbar');
  if (tb) tb.innerHTML = renderThreadToolbar(chatId);
  const compose = document.getElementById('thread-compose-bar');
  if (compose) compose.innerHTML = renderThreadCompose(chatId);
  if (meta?.identifier) loadAndRenderNotes(meta.identifier);

  const list = document.getElementById('drafts-list');
  if (list) list.innerHTML = '<div class="empty"><div class="empty-title">loading…</div></div>';

  try {
    const { messages } = await api(`/api/chats/${chatId}/messages?limit=200`);
    if (!list) return;
    if (!messages.length) {
      list.innerHTML = '<div class="empty"><div class="empty-title">No messages in this chat.</div></div>';
      return;
    }
    const ascending = messages.slice().reverse();
    list.innerHTML = ascending.map(renderMessageBubble).join('');
    // The scrolling container is `.main`, not `#drafts-list`.
    requestAnimationFrame(() => {
      const main = document.querySelector('.main');
      if (main) main.scrollTop = main.scrollHeight;
    });
  } catch (e) {
    if (list) {
      list.innerHTML = `<div class="empty"><div class="empty-title">Failed to load messages.</div><div class="empty-sub">${escapeHtml(e.message)}</div></div>`;
    }
  }
}
