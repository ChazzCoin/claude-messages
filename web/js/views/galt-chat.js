// Galt direct-chat — full-page view on the local web dashboard at #/galt-chat.
//
// Reads + writes chat history through /api/galt-chat (history) and
// /api/galt-chat (POST send). RTDB is the source of truth — the same
// conversation surfaces on the companion PWA at #/chat.
//
// Page layout:
//   - Chat history (bubbles) + input
//   - Configuration sections (collapsed by default) — placeholders for
//     prompt pipelines, tool toggles, etc. Phase 2 fills these in.

import { api } from '../api.js';
import { setMainHeader } from '../shell.js';
import { escapeHtml, relTime } from '../utils.js';

let _pollTimer = null;
let _lastTs = 0;

/* ---------- top-level render ---------- */

export async function renderGaltChatView() {
  setMainHeader({
    title: 'Galt chat',
    subHTML: 'direct line to Galt · same conversation as companion at <a href="https://galt-messages.web.app/#/chat" target="_blank" rel="noopener">galt-messages.web.app/#/chat</a>',
  });

  const list = document.getElementById('drafts-list');
  if (!list) return;

  list.innerHTML = `
    <div class="galt-chat">
      <div class="galt-chat-scroll" id="galt-chat-scroll">
        <div id="galt-chat-messages"></div>
        <div class="galt-chat-typing" id="galt-chat-typing" style="display:none;">
          <span></span><span></span><span></span>
        </div>
      </div>
      <form class="galt-chat-input-bar" id="galt-chat-form" autocomplete="off">
        <textarea
          id="galt-chat-input"
          class="galt-chat-input"
          rows="1"
          placeholder="Message Galt…"
          autocorrect="on"
          spellcheck="true"></textarea>
        <button type="submit" class="galt-chat-send" aria-label="Send">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18">
            <path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>
          </svg>
        </button>
        <button type="button" class="v9-btn subtle" id="galt-chat-clear">Clear</button>
      </form>
    </div>

    <details class="galt-chat-section">
      <summary>Prompt pipeline · coming soon</summary>
      <div class="galt-chat-section-body">
        Per-turn prompt assembly for Galt chat will surface here — system prompt, voice profile, conversation memory, and tool definitions. For now the assembly is read-only and matches the away/summon mode prompt-pipeline philosophy (see <a href="#/galt">Galt</a>).
      </div>
    </details>

    <details class="galt-chat-section">
      <summary>Tools · coming soon</summary>
      <div class="galt-chat-section-body">
        Galt's tool access for this chat: calendar lookup, message search, contact lookup, notes, call history. Toggles + per-tool inspection land here once tool-calling ships.
      </div>
    </details>
  `;

  await loadAndRender();
  wireInput();
  wireClear();

  // Light polling so messages from the companion / backend appear
  // without a refresh. Tight cadence on this page; gets canceled
  // when the user navigates away (see stopPolling).
  startPolling();
}

/** Stop the chat poll timer. Called from router when we leave this view. */
export function stopGaltChatPolling() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

/* ---------- history fetch + render ---------- */

async function loadAndRender() {
  try {
    const r = await api('/api/galt-chat/history?limit=200');
    renderMessages(r.messages || []);
  } catch (err) {
    const root = document.getElementById('galt-chat-messages');
    if (root) {
      root.innerHTML = `<div class="empty"><div class="empty-title">couldn't load history</div><div class="empty-sub">${escapeHtml(err.message || 'unknown error')}</div></div>`;
    }
  }
}

function renderMessages(messages) {
  const root = document.getElementById('galt-chat-messages');
  if (!root) return;
  if (messages.length === 0) {
    root.innerHTML = `
      <div class="galt-chat-empty">
        <div class="galt-chat-empty-mark">G</div>
        <div class="galt-chat-empty-text">Direct line to Galt. Ask anything, draft something, brainstorm. Tools land in Phase 2 — calendar / notes / messages / call history.</div>
      </div>
    `;
  } else {
    root.innerHTML = messages.map(renderBubble).join('');
    _lastTs = messages[messages.length - 1].ts || 0;
  }
  scrollToBottom();
}

function renderBubble(m) {
  const cls = m.role === 'user' ? 'me' : 'galt';
  const meta = m.role === 'galt' && m.model
    ? `<div class="galt-chat-bubble-meta">${escapeHtml(m.model)}${m.ts ? ' · ' + escapeHtml(relTime(m.ts)) : ''}${m.rounds ? ' · ' + m.rounds + ' round' + (m.rounds === 1 ? '' : 's') : ''}</div>`
    : '';
  const tools = Array.isArray(m.tool_calls) && m.tool_calls.length > 0
    ? renderToolStrip(m.tool_calls)
    : '';
  return `
    <div class="galt-chat-row ${cls}">
      ${tools}
      <div class="galt-chat-bubble">${escapeHtml(m.text)}</div>
      ${meta}
    </div>
  `;
}

function renderToolStrip(calls) {
  const chips = calls.map((c) => {
    const argSummary = summarizeArgs(c.arguments);
    const ms = typeof c.ms === 'number' ? `${c.ms}ms` : '';
    const errCls = c.error ? ' err' : '';
    return `
      <details class="galt-chat-tool${errCls}">
        <summary>
          <span class="galt-chat-tool-name">${escapeHtml(c.name)}</span>
          ${argSummary ? `<span class="galt-chat-tool-args">${escapeHtml(argSummary)}</span>` : ''}
          ${ms ? `<span class="galt-chat-tool-ms">${escapeHtml(ms)}</span>` : ''}
        </summary>
        <pre class="galt-chat-tool-body">${escapeHtml(c.error || c.result_preview || '')}</pre>
      </details>
    `;
  }).join('');
  return `<div class="galt-chat-tool-strip">${chips}</div>`;
}

function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const entries = Object.entries(args);
  if (entries.length === 0) return '';
  return entries.slice(0, 3).map(([k, v]) => {
    const sv = typeof v === 'string'
      ? `"${v.length > 30 ? v.slice(0, 30) + '…' : v}"`
      : String(v);
    return `${k}: ${sv}`;
  }).join(', ') + (entries.length > 3 ? ', …' : '');
}

function scrollToBottom() {
  const scroll = document.getElementById('galt-chat-scroll');
  if (!scroll) return;
  requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
}

/* ---------- send / clear ---------- */

function wireInput() {
  const form  = document.getElementById('galt-chat-form');
  const input = document.getElementById('galt-chat-input');
  if (!form || !input) return;

  // Auto-grow.
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  });

  // Enter to send, Shift+Enter for newline.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendTurn();
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void sendTurn();
  });

  input.focus();
}

function wireClear() {
  const btn = document.getElementById('galt-chat-clear');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!confirm('Clear all chat history with Galt?')) return;
    try {
      await api('/api/galt-chat/clear', { method: 'POST', body: {} });
      _lastTs = 0;
      renderMessages([]);
    } catch (err) {
      alert('clear failed: ' + (err.message || 'unknown'));
    }
  });
}

let _sending = false;
async function sendTurn() {
  if (_sending) return;
  const input = document.getElementById('galt-chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  _sending = true;
  input.value = '';
  input.style.height = 'auto';
  setTyping(true);

  // Optimistic append of the user's message so the chat feels live.
  appendOptimisticUser(text);

  try {
    await api('/api/galt-chat', { method: 'POST', body: { text } });
    // Re-fetch to pick up the canonical user + galt messages from RTDB.
    await loadAndRender();
  } catch (err) {
    appendErrorBubble(err.message || 'send failed');
  } finally {
    setTyping(false);
    _sending = false;
    input.focus();
  }
}

function appendOptimisticUser(text) {
  const root = document.getElementById('galt-chat-messages');
  if (!root) return;
  // Remove the empty placeholder if it's still there.
  const empty = root.querySelector('.galt-chat-empty');
  if (empty) empty.remove();
  root.insertAdjacentHTML(
    'beforeend',
    `<div class="galt-chat-row me"><div class="galt-chat-bubble">${escapeHtml(text)}</div></div>`,
  );
  scrollToBottom();
}

function appendErrorBubble(msg) {
  const root = document.getElementById('galt-chat-messages');
  if (!root) return;
  root.insertAdjacentHTML(
    'beforeend',
    `<div class="galt-chat-row galt"><div class="galt-chat-bubble error">${escapeHtml(msg)}</div></div>`,
  );
  scrollToBottom();
}

function setTyping(on) {
  const el = document.getElementById('galt-chat-typing');
  if (!el) return;
  el.style.display = on ? '' : 'none';
  if (on) scrollToBottom();
}

/* ---------- polling for companion-side updates ---------- */

function startPolling() {
  stopGaltChatPolling();
  _pollTimer = setInterval(async () => {
    // Don't poll while a send is in flight — we'll refresh after it
    // completes anyway.
    if (_sending) return;
    try {
      const r = await api('/api/galt-chat/history?limit=200');
      const messages = r.messages || [];
      const latest = messages.length ? messages[messages.length - 1].ts || 0 : 0;
      if (latest > _lastTs) renderMessages(messages);
    } catch { /* keep last render */ }
  }, 4000);
}
