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
let _calendars = [];  // cached list for the proposal-card dropdown

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

  // Fetch the calendar list once on mount — used by the proposal-
  // card "Add to:" dropdown. Rarely changes, so no need to refresh
  // per render.
  await loadCalendars();

  await loadAndRender();
  wireInput();
  wireClear();
  wireProposalActions();

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

async function loadCalendars() {
  try {
    const r = await api('/api/calendar/calendars');
    _calendars = Array.isArray(r.calendars) ? r.calendars : [];
  } catch {
    _calendars = [];  // dropdown just won't render
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
  // Split tool calls: propose_* → calendar proposal cards;
  // request_user_approval → inline Y/N prompt; everything else →
  // compact chip strip.
  const proposals = renderProposalCards(m.tool_calls);
  const approvals = renderApprovalCards(m.tool_calls);
  const readCalls = Array.isArray(m.tool_calls)
    ? m.tool_calls.filter((tc) =>
        !tc.name?.startsWith('propose_') && tc.name !== 'request_user_approval')
    : [];
  const tools = readCalls.length > 0 ? renderToolStrip(readCalls) : '';
  return `
    <div class="galt-chat-row ${cls}">
      ${tools}
      ${proposals}
      ${approvals}
      <div class="galt-chat-bubble">${escapeHtml(m.text)}</div>
      ${meta}
    </div>
  `;
}

function renderApprovalCards(toolCalls) {
  if (!Array.isArray(toolCalls)) return '';
  return toolCalls
    .filter((tc) => tc.name === 'request_user_approval')
    .map(renderApprovalRequestCard)
    .filter(Boolean)
    .join('');
}

function renderApprovalRequestCard(tc) {
  let r;
  try { r = JSON.parse(tc.result_preview || '{}'); } catch { return ''; }
  if (!r || r.ok === false || !r.question) return '';
  const approveLabel = r.approve_label || 'Approve';
  const denyLabel = r.deny_label || 'Deny';
  const fingerprint = encodeURIComponent((r.question.slice(0, 32) + ':' + (tc.ms || 0)));
  return `
    <div class="galt-chat-approval" data-approval-fp="${fingerprint}">
      <div class="galt-chat-proposal-head">
        <span class="galt-chat-proposal-kind">Decision</span>
        <span class="galt-chat-proposal-status" data-id="galt-approval-status-${fingerprint}">awaiting</span>
      </div>
      <div class="galt-chat-approval-question">${escapeHtml(r.question)}</div>
      ${r.context ? `<div class="galt-chat-approval-context">${escapeHtml(r.context)}</div>` : ''}
      <div class="galt-chat-proposal-actions">
        <button class="galt-chat-proposal-btn dismiss" data-action="approval-deny" data-label="${escapeHtml(denyLabel)}">${escapeHtml(denyLabel)}</button>
        <button class="galt-chat-proposal-btn approve" data-action="approval-approve" data-label="${escapeHtml(approveLabel)}">${escapeHtml(approveLabel)}</button>
      </div>
    </div>
  `;
}

function renderProposalCards(toolCalls) {
  if (!Array.isArray(toolCalls)) return '';
  return toolCalls
    .filter((tc) => tc.name === 'propose_calendar_event')
    .map(renderCalendarProposalCard)
    .filter(Boolean)
    .join('');
}

function renderCalendarProposalCard(tc) {
  let r;
  try { r = JSON.parse(tc.result_preview || '{}'); } catch { return ''; }
  if (!r || r.ok === false || !r.proposal_id) return '';

  const start = r.start_iso ? fmtProposalTime(r.start_iso) : '— no time —';
  const end = r.end_iso ? fmtProposalTime(r.end_iso) : null;
  const when = end ? `${start} → ${end.split(' · ')[1] || end}` : start;
  const id = r.proposal_id;

  return `
    <div class="galt-chat-proposal" data-proposal-id="${escapeHtml(id)}">
      <div class="galt-chat-proposal-head">
        <span class="galt-chat-proposal-kind">Calendar event</span>
        <span class="galt-chat-proposal-status" data-id="galt-proposal-status-${escapeHtml(id)}">pending</span>
      </div>
      <div class="galt-chat-proposal-title">${escapeHtml(r.title || 'Untitled')}</div>
      <div class="galt-chat-proposal-when">${escapeHtml(when)}</div>
      ${r.location ? `<div class="galt-chat-proposal-meta">📍 ${escapeHtml(r.location)}</div>` : ''}
      ${r.participants ? `<div class="galt-chat-proposal-meta">👥 ${escapeHtml(r.participants)}</div>` : ''}
      ${r.notes ? `<div class="galt-chat-proposal-notes">${escapeHtml(r.notes)}</div>` : ''}
      ${renderCalendarPicker(id)}
      <div class="galt-chat-proposal-actions">
        <button class="galt-chat-proposal-btn dismiss" data-action="proposal-dismiss" data-proposal-id="${escapeHtml(id)}">Deny</button>
        <button class="galt-chat-proposal-btn approve" data-action="proposal-approve" data-proposal-id="${escapeHtml(id)}">Approve &amp; add to Calendar</button>
      </div>
    </div>
  `;
}

function renderCalendarPicker(proposalId) {
  if (!Array.isArray(_calendars) || _calendars.length === 0) return '';
  const opts = _calendars.map((c) => `
    <option value="${escapeHtml(c.title || '')}" data-uuid="${escapeHtml(c.uuid || '')}">${escapeHtml(c.title || '(untitled)')}</option>
  `).join('');
  return `
    <label class="galt-chat-proposal-picker">
      <span class="galt-chat-proposal-picker-label">Add to</span>
      <select data-action="proposal-set-calendar" data-proposal-id="${escapeHtml(proposalId)}">
        <option value="">— Calendar.app default —</option>
        ${opts}
      </select>
    </label>
  `;
}

function fmtProposalTime(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const day = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time}`;
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

/** Delegate clicks for any proposal/approval card in the chat feed.
 *  Two card kinds:
 *   - .galt-chat-proposal       → propose_calendar_event (HTTP to
 *                                 /api/calendar/proposals/:id/export
 *                                 or /dismiss)
 *   - .galt-chat-approval       → request_user_approval (sends the
 *                                 chosen label back as a chat turn)
 *  Plus a `change` handler for the calendar picker dropdown. */
function wireProposalActions() {
  const scroll = document.getElementById('galt-chat-scroll');
  if (!scroll) return;
  scroll.addEventListener('click', async (e) => {
    const btn = e.target.closest?.('[data-action]');
    if (!btn || btn.tagName === 'SELECT') return;
    const action = btn.dataset.action;

    if (action === 'proposal-approve' || action === 'proposal-dismiss') {
      await handleProposalClick(btn, action);
      return;
    }
    if (action === 'approval-approve' || action === 'approval-deny') {
      await handleApprovalClick(btn, action);
      return;
    }
  });

  scroll.addEventListener('change', async (e) => {
    const sel = e.target.closest?.('select[data-action="proposal-set-calendar"]');
    if (!sel) return;
    const id = parseInt(sel.dataset.proposalId, 10);
    if (!Number.isFinite(id)) return;
    const targetCalendar = sel.value || null;
    try {
      await api(`/api/calendar/proposals/${id}`, {
        method: 'PATCH',
        body: { target_calendar: targetCalendar },
      });
    } catch (err) {
      alert('couldn\'t set calendar: ' + (err.message || 'unknown'));
    }
  });
}

async function handleProposalClick(btn, action) {
  const id = parseInt(btn.dataset.proposalId, 10);
  if (!Number.isFinite(id)) return;
  const card = btn.closest('.galt-chat-proposal');
  if (!card) return;
  setProposalStatus(card, 'sending');
  try {
    if (action === 'proposal-approve') {
      await api(`/api/calendar/proposals/${id}/export`, { method: 'POST', body: {} });
      setProposalStatus(card, 'approved');
    } else {
      await api(`/api/calendar/proposals/${id}/dismiss`, { method: 'POST', body: {} });
      setProposalStatus(card, 'dismissed');
    }
  } catch (err) {
    setProposalStatus(card, 'pending');
    alert((action === 'proposal-approve' ? 'approve' : 'dismiss') + ' failed: ' + (err.message || 'unknown'));
  }
}

async function handleApprovalClick(btn, action) {
  const card = btn.closest('.galt-chat-approval');
  if (!card) return;
  const label = btn.dataset.label || (action === 'approval-approve' ? 'Approve' : 'Deny');
  const newStatus = action === 'approval-approve' ? 'approved' : 'denied';
  // Optimistic flip — buttons disable, status text updates. Failure
  // of the underlying send is a rare network hiccup; we surface via
  // alert but don't roll the card back (the user already saw their
  // intent recorded).
  setApprovalStatus(card, newStatus);
  try {
    // Programmatically fill the input + submit, which routes through
    // the existing send path. Keep the input filled briefly so the
    // user can see what was sent.
    const input = document.getElementById('galt-chat-input');
    if (input) {
      input.value = label;
    }
    // Reuse the existing sendTurn() — it reads input value + clears it
    // + sets thinking state + polls for the reply. Same code path
    // typing manually would hit.
    await sendTurn();
  } catch (err) {
    alert('send failed: ' + (err.message || 'unknown'));
  }
}

function setProposalStatus(card, status) {
  card.dataset.status = status;
  const statusEl = card.querySelector('[data-id^="galt-proposal-status-"]');
  if (statusEl) statusEl.textContent = status;
  if (status === 'approved' || status === 'dismissed') {
    for (const btn of card.querySelectorAll('.galt-chat-proposal-btn')) {
      btn.setAttribute('disabled', 'true');
    }
  }
}

function setApprovalStatus(card, status) {
  card.dataset.status = status;
  const statusEl = card.querySelector('[data-id^="galt-approval-status-"]');
  if (statusEl) statusEl.textContent = status;
  for (const btn of card.querySelectorAll('.galt-chat-proposal-btn')) {
    btn.setAttribute('disabled', 'true');
  }
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
