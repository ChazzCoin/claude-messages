// Galt direct-chat — Phase 1: subscribe to /galt_chat/messages, send
// turns via the existing /commands bus, render bubbles.
//
// Architecture:
//   /galt_chat/messages/<auto_id> = { role, text, ts, model?, usage? }
//
//   send flow: user types → click send (or ⌘/Ctrl+Enter) →
//     sendCommand('galt_chat', { text }) → backend appends user
//     message → calls OpenAI → appends Galt's reply → both show up
//     in our /galt_chat/messages subscription within ~50ms.
//
//   "Galt is thinking…" indicator: shown after the command is in
//   flight until the next subscription tick delivers a galt message.
//
// One conversation, no session ids. Single-user app. Clearing the
// chat sends 'galt_chat_clear' which wipes the RTDB node.

import { db, ref, onValue, off } from './firebase.js';
import { sendCommand } from './state.js';
import { showToast } from './render.js';

let _unsub = null;
let _waitingForGalt = false;

/** Subscribe to /galt_chat/messages. Called once when the sheet
 *  first opens; subscription stays alive afterward so new messages
 *  stream in regardless of whether the sheet is visible. */
export function startChatSubscription() {
  if (_unsub) return;
  const messagesRef = ref(db, '/galt_chat/messages');
  const cb = (snap) => {
    const val = snap.val() || {};
    const arr = Object.entries(val)
      .map(([id, m]) => ({ id, ...m }))
      .filter((m) => m.role === 'user' || m.role === 'galt')
      .sort((a, b) => (a.ts || 0) - (b.ts || 0));
    renderMessages(arr);
    // If the latest message is from Galt, we've received the reply —
    // clear the "thinking" state.
    if (arr.length > 0 && arr[arr.length - 1].role === 'galt') {
      setThinking(false);
    }
  };
  onValue(messagesRef, cb);
  _unsub = () => off(messagesRef, 'value', cb);
}

/** Send a new chat turn. Optimistically marks the "thinking" state;
 *  the subscription clears it when Galt's reply lands. */
export async function sendChatTurn() {
  const input = document.querySelector('[data-id="chat-input"]');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  if (_waitingForGalt) return;  // gate against double-send

  // Optimistically clear the input so the user can type the next
  // message. The user message will appear in the rendered list
  // when the subscription ticks (~50ms after backend appends).
  input.value = '';
  autosizeInput(input);
  setThinking(true);

  try {
    await sendCommand('galt_chat', { text });
    // Reply will arrive via the subscription. setThinking(false) is
    // called in the subscription callback when the last message is
    // role='galt'.
  } catch (err) {
    setThinking(false);
    showToast(err.message, 'error');
  }
}

/** Wipe the conversation. Confirms first. */
export async function clearChat() {
  if (!confirm('Clear all chat history with Galt?')) return;
  try {
    await sendCommand('galt_chat_clear');
    showToast('chat cleared', 'ok');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ---------- render ---------- */

function escape(v) {
  if (v == null) return '';
  return String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderMessages(messages) {
  const root = document.querySelector('[data-id="chat-messages"]');
  if (!root) return;
  if (messages.length === 0) {
    root.innerHTML = `
      <div class="chat-empty">
        <div class="chat-empty-mark">G</div>
        <div class="chat-empty-text">Direct line to Galt. Ask anything, draft something, brainstorm. No tool access yet — just conversation.</div>
      </div>
    `;
    return;
  }
  root.innerHTML = messages.map(bubble).join('');
  // Auto-scroll to the bottom on new content.
  const scroll = document.querySelector('[data-id="chat-scroll"]');
  if (scroll) {
    // requestAnimationFrame so the layout is settled before we measure.
    requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
  }
}

function bubble(m) {
  const cls = m.role === 'user' ? 'me' : 'galt';
  // Tool calls render in two flavors:
  //   - "propose_*" calls become structured approval cards
  //   - everything else becomes the compact <details> chip strip
  const proposalCards = renderProposalCards(m.tool_calls);
  const tools = Array.isArray(m.tool_calls) && m.tool_calls.length > 0
    ? renderToolCalls(m.tool_calls.filter((tc) => !tc.name.startsWith('propose_')))
    : '';
  return `
    <div class="chat-bubble-row ${cls}">
      <div class="chat-bubble-stack">
        ${tools}
        ${proposalCards}
        <div class="chat-bubble">${escape(m.text)}</div>
      </div>
    </div>
  `;
}

/** Render approval cards for any `propose_*` tool calls on this turn.
 *  Each card shows the structured proposal with [Approve] [Dismiss]
 *  buttons; the chat-action handlers in actions.js call into the
 *  RTDB commands bus. */
function renderProposalCards(toolCalls) {
  if (!Array.isArray(toolCalls)) return '';
  const cards = toolCalls
    .filter((tc) => tc.name === 'propose_calendar_event')
    .map(renderCalendarProposalCard)
    .filter(Boolean);
  return cards.join('');
}

function renderCalendarProposalCard(tc) {
  // Parse the result preview as JSON. The tool's structured
  // execute() result is what was persisted — proposal_id, title,
  // start_iso, end_iso, location, participants, notes.
  let r;
  try { r = JSON.parse(tc.result_preview || '{}'); } catch { return ''; }
  if (!r || r.ok === false || !r.proposal_id) return '';

  const start = r.start_iso ? formatProposalTime(r.start_iso) : '— no time —';
  const end = r.end_iso ? formatProposalTime(r.end_iso) : null;
  const when = end ? `${start} → ${end.split(' · ')[1] || end}` : start;

  return `
    <div class="chat-proposal-card" data-proposal-id="${escape(r.proposal_id)}">
      <div class="chat-proposal-head">
        <div class="chat-proposal-kind">Calendar event</div>
        <div class="chat-proposal-status" data-id="proposal-status-${escape(r.proposal_id)}">pending</div>
      </div>
      <div class="chat-proposal-title">${escape(r.title || 'Untitled')}</div>
      <div class="chat-proposal-when">${escape(when)}</div>
      ${r.location ? `<div class="chat-proposal-meta">📍 ${escape(r.location)}</div>` : ''}
      ${r.participants ? `<div class="chat-proposal-meta">👥 ${escape(r.participants)}</div>` : ''}
      ${r.notes ? `<div class="chat-proposal-notes">${escape(r.notes)}</div>` : ''}
      <div class="chat-proposal-actions">
        <button class="chat-proposal-btn dismiss" data-action="proposal-dismiss" data-proposal-id="${escape(r.proposal_id)}">Dismiss</button>
        <button class="chat-proposal-btn approve" data-action="proposal-approve" data-proposal-id="${escape(r.proposal_id)}">Approve & add to Calendar</button>
      </div>
    </div>
  `;
}

/** "2026-05-14T15:00:00.000Z" → "Thu, May 14 · 3:00 PM" in user's
 *  local timezone. */
function formatProposalTime(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const day = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time}`;
}

/** Render the tool-call strip that sits ABOVE Galt's bubble — shows
 *  the user that Galt actually went and fetched something. Compact
 *  by default; <details> expands the args + result preview. */
function renderToolCalls(calls) {
  const chips = calls.map((c) => {
    const argSummary = summarizeArgs(c.arguments);
    const ms = typeof c.ms === 'number' ? `${c.ms}ms` : '';
    const errCls = c.error ? ' chat-tool-err' : '';
    return `
      <details class="chat-tool${errCls}">
        <summary>
          <span class="chat-tool-name">${escape(c.name)}</span>
          ${argSummary ? `<span class="chat-tool-args">${escape(argSummary)}</span>` : ''}
          ${ms ? `<span class="chat-tool-ms">${escape(ms)}</span>` : ''}
        </summary>
        <pre class="chat-tool-body">${escape(c.error || c.result_preview || '')}</pre>
      </details>
    `;
  }).join('');
  return `<div class="chat-tool-strip">${chips}</div>`;
}

function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const entries = Object.entries(args);
  if (entries.length === 0) return '';
  return entries
    .slice(0, 3)
    .map(([k, v]) => {
      const sv = typeof v === 'string'
        ? `"${v.length > 30 ? v.slice(0, 30) + '…' : v}"`
        : String(v);
      return `${k}: ${sv}`;
    })
    .join(', ') + (entries.length > 3 ? ', …' : '');
}

function setThinking(on) {
  _waitingForGalt = on;
  const el = document.querySelector('[data-id="chat-typing"]');
  if (el) el.style.display = on ? '' : 'none';
  // Auto-scroll so the dots stay visible.
  if (on) {
    const scroll = document.querySelector('[data-id="chat-scroll"]');
    if (scroll) requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
  }
}

/* ---------- input UX ---------- */

/** Auto-grow the textarea up to a cap so multi-line messages still fit. */
function autosizeInput(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

/** Wire keyboard shortcuts (Enter to send, Shift+Enter for newline)
 *  and auto-resize on input. Called once at boot. */
export function wireChatInput() {
  const input = document.querySelector('[data-id="chat-input"]');
  if (!input) return;
  input.addEventListener('input', () => autosizeInput(input));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendChatTurn();
    }
  });
}

/** Focus the input after the sheet animates in. */
export function focusChatInput() {
  const input = document.querySelector('[data-id="chat-input"]');
  if (!input) return;
  // 150ms ≈ matches the sheet slide-up; focusing earlier scrolls the
  // viewport oddly on iOS.
  setTimeout(() => input.focus(), 180);
}
