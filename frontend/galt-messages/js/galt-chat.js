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

import { db, ref, onValue, off, onChildAdded } from './firebase.js';
import { sendCommand, getStore } from './state.js';
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
  await submitChatTurn(text, { clearInput: true });
}

/** Send a specific text as a chat turn. Used by the approval-card
 *  buttons so a click ("Approve" / "Deny") flows back as if the
 *  user had typed and sent it. */
export async function sendChatText(text) {
  await submitChatTurn(text, { clearInput: false });
}

async function submitChatTurn(text, { clearInput }) {
  if (!text || !text.trim()) return;
  if (_waitingForGalt) return;  // gate against double-send

  if (clearInput) {
    const input = document.querySelector('[data-id="chat-input"]');
    if (input) {
      input.value = '';
      autosizeInput(input);
    }
  }
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
  // Re-attach live subscriptions for any task cards that just (re-)
  // rendered. ensureTaskSubscriptions() is idempotent — a task
  // already subscribed gets skipped.
  ensureTaskSubscriptions();
  // Auto-scroll to the bottom on new content.
  const scroll = document.querySelector('[data-id="chat-scroll"]');
  if (scroll) {
    // requestAnimationFrame so the layout is settled before we measure.
    requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
  }
}

/* ============================================================
   Live task-card subscriptions
   ============================================================
   Each .chat-task-card[data-task-id="..."] in the DOM gets a live
   feed from RTDB:
     - /tasks/<id>        → task row updates (status, result, model, …)
     - /tasks/<id>/events → streamed events (tool_use, tool_result, …)
   Subscriptions are idempotent (we skip re-subscribing) and persist
   across re-renders. When a task hits a terminal state, we keep the
   subscription alive briefly to ensure final-state writes land, then
   it's effectively dormant. */

const _taskSubs = new Map(); // task_id → { unsubRow, unsubEvents, terminal: bool }

function ensureTaskSubscriptions() {
  const cards = document.querySelectorAll('.chat-task-card[data-task-id]');
  for (const card of cards) {
    const id = card.dataset.taskId;
    if (!id || _taskSubs.has(id)) continue;
    subscribeToTask(id);
  }
}

function subscribeToTask(taskId) {
  const rowRef = ref(db, `/tasks/${taskId}`);
  const eventsRef = ref(db, `/tasks/${taskId}/events`);

  const rowCb = (snap) => {
    const task = snap.val();
    if (!task) return;
    updateTaskCardRow(taskId, task);
  };
  onValue(rowRef, rowCb);

  // onChildAdded fires for existing children too, so we get backfill
  // for free when the user first opens the chat on a task that's
  // already running.
  const eventCb = (snap) => {
    const ev = snap.val();
    if (!ev) return;
    appendTaskCardEvent(taskId, ev);
  };
  onChildAdded(eventsRef, eventCb);

  _taskSubs.set(taskId, {
    unsubRow: () => off(rowRef, 'value', rowCb),
    unsubEvents: () => off(eventsRef, 'child_added', eventCb),
    terminal: false,
  });
}

function updateTaskCardRow(taskId, task) {
  const card = document.querySelector(`.chat-task-card[data-task-id="${cssEsc(taskId)}"]`);
  if (!card) return;
  const status = task.status || 'queued';
  card.dataset.status = status;
  const statusEl = card.querySelector(`[data-id="task-status-${cssEsc(taskId)}"]`);
  if (statusEl) statusEl.textContent = status;
  const msgEl = card.querySelector(`[data-id="task-message-${cssEsc(taskId)}"]`);
  if (msgEl) {
    if (status === 'succeeded' && task.result) {
      msgEl.textContent = task.result;
    } else if (status === 'failed') {
      msgEl.textContent = task.error || task.result || 'failed';
    } else if (status === 'cancelled') {
      msgEl.textContent = 'cancelled';
    } else {
      msgEl.textContent = '';
    }
  }
  const metaEl = card.querySelector(`[data-id="task-meta-${cssEsc(taskId)}"]`);
  if (metaEl) {
    const parts = [];
    if (task.model)          parts.push(escape(task.model));
    if (task.num_turns != null) parts.push(`${task.num_turns} round${task.num_turns === 1 ? '' : 's'}`);
    if (task.total_cost_usd != null && task.total_cost_usd > 0) {
      parts.push(`$${task.total_cost_usd.toFixed(3)}`);
    }
    if (task.started_at && task.finished_at) {
      const seconds = Math.round((task.finished_at - task.started_at) / 1000);
      parts.push(`${seconds}s`);
    }
    metaEl.innerHTML = parts.join(' · ');
  }
  // Hide cancel once terminal.
  const cancelBtn = card.querySelector('.chat-task-cancel');
  if (cancelBtn) {
    const terminal = status === 'succeeded' || status === 'failed' || status === 'cancelled';
    if (terminal) cancelBtn.style.display = 'none';
  }
}

function appendTaskCardEvent(taskId, ev) {
  const root = document.querySelector(`[data-id="task-events-${cssEsc(taskId)}"]`);
  if (!root) return;
  const html = renderTaskEventLine(ev);
  if (!html) return;
  root.insertAdjacentHTML('beforeend', html);
  // Auto-scroll if the event lives near the bottom of the chat.
  const scroll = document.querySelector('[data-id="chat-scroll"]');
  if (scroll) requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
}

function renderTaskEventLine(ev) {
  if (!ev || !ev.kind) return '';
  const kind = ev.kind;
  const data = ev.data || {};
  if (kind === 'tool_use') {
    return `
      <div class="chat-task-event">
        <span class="chat-task-event-icon">⏵</span>
        <span class="chat-task-event-tool">${escape(data.tool || '?')}</span>
        ${data.input_preview ? `<span class="chat-task-event-arg">${escape(data.input_preview)}</span>` : ''}
      </div>`;
  }
  if (kind === 'tool_result') {
    const errCls = data.is_error ? ' chat-task-event-err' : '';
    const preview = (data.preview || '').slice(0, 200);
    if (!preview) return '';
    return `
      <details class="chat-task-event tool-result${errCls}">
        <summary>
          <span class="chat-task-event-icon">↵</span>
          <span class="chat-task-event-tool">${escape(preview.split('\n')[0] || '').slice(0, 80)}</span>
        </summary>
        <pre class="chat-task-event-body">${escape(data.preview || '')}</pre>
      </details>`;
  }
  if (kind === 'message') {
    if (!data.text) return '';
    return `<div class="chat-task-event message">${escape(data.text)}</div>`;
  }
  if (kind === 'init') {
    return `
      <div class="chat-task-event init">
        <span class="chat-task-event-icon">⏵</span>
        <span class="chat-task-event-arg">started ${data.model ? '(' + escape(data.model) + ')' : ''}</span>
      </div>`;
  }
  if (kind === 'stderr') {
    return '';  // stderr is noisy; skip for now
  }
  return '';
}

/** Escape a string for use as a CSS attribute selector value
 *  (CSS.escape is widely supported but a tiny shim is safer). */
function cssEsc(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}

function bubble(m) {
  const cls = m.role === 'user' ? 'me' : 'galt';
  // Tool calls render in five flavors:
  //   - "propose_*"             → structured proposal cards (side effect on approve)
  //   - "request_user_approval" → inline approve/deny prompt (decision flows back as next turn)
  //   - "list_calendar_events"  → read-only event cards (display only, no actions)
  //   - "claude_ask"            → live task card subscribed to /tasks/<id>
  //   - everything else         → compact <details> chip strip
  const proposalCards = renderProposalCards(m.tool_calls);
  const approvalCards = renderApprovalCards(m.tool_calls);
  const eventCards = renderEventListCards(m.tool_calls);
  const taskCards = renderTaskCards(m.tool_calls);
  const otherCalls = Array.isArray(m.tool_calls)
    ? m.tool_calls.filter((tc) =>
        !tc.name.startsWith('propose_') &&
        tc.name !== 'request_user_approval' &&
        tc.name !== 'list_calendar_events' &&
        tc.name !== 'claude_ask')
    : [];
  const tools = otherCalls.length > 0 ? renderToolCalls(otherCalls) : '';
  return `
    <div class="chat-bubble-row ${cls}">
      <div class="chat-bubble-stack">
        ${tools}
        ${eventCards}
        ${proposalCards}
        ${approvalCards}
        ${taskCards}
        <div class="chat-bubble">${escape(m.text)}</div>
      </div>
    </div>
  `;
}

/** Render live task cards for any claude_ask tool calls on this turn.
 *  Each card subscribes to /tasks/<id> via RTDB and re-renders as
 *  events stream in. */
function renderTaskCards(toolCalls) {
  if (!Array.isArray(toolCalls)) return '';
  return toolCalls
    .filter((tc) => tc.name === 'claude_ask')
    .map(renderTaskCardShell)
    .filter(Boolean)
    .join('');
}

function renderTaskCardShell(tc) {
  let r;
  try { r = JSON.parse(tc.result_preview || '{}'); } catch { return ''; }
  if (!r || !r.task_id) return '';
  // Empty shell — the live subscription wires up after the DOM exists
  // and fills the body. data-task-id is the anchor.
  return `
    <div class="chat-task-card" data-task-id="${escape(r.task_id)}" data-status="queued">
      <div class="chat-task-head">
        <div class="chat-task-kind">⚡ Claude</div>
        <div class="chat-task-status" data-id="task-status-${escape(r.task_id)}">queued</div>
      </div>
      <div class="chat-task-body" data-id="task-body-${escape(r.task_id)}">
        <div class="chat-task-events" data-id="task-events-${escape(r.task_id)}"></div>
        <div class="chat-task-message" data-id="task-message-${escape(r.task_id)}"></div>
      </div>
      <div class="chat-task-foot">
        <div class="chat-task-meta" data-id="task-meta-${escape(r.task_id)}"></div>
        <button class="chat-proposal-btn dismiss chat-task-cancel" data-action="task-cancel" data-task-id="${escape(r.task_id)}">Cancel</button>
      </div>
    </div>
  `;
}

/** Render read-only event cards from list_calendar_events tool calls.
 *  Same visual language as the propose-card but with no actions —
 *  pure information display. Galt's natural-language reply still
 *  appears below; cards give the structured view. */
function renderEventListCards(toolCalls) {
  if (!Array.isArray(toolCalls)) return '';
  const cards = [];
  for (const tc of toolCalls) {
    if (tc.name !== 'list_calendar_events') continue;
    let r;
    try { r = JSON.parse(tc.result_preview || '{}'); } catch { continue; }
    const events = Array.isArray(r?.events) ? r.events : [];
    for (const ev of events) cards.push(renderReadOnlyEventCard(ev));
  }
  return cards.filter(Boolean).join('');
}

function renderReadOnlyEventCard(ev) {
  if (!ev || !ev.title) return '';
  const start = ev.start_iso ? formatProposalTime(ev.start_iso) : '— no time —';
  const end = ev.end_iso ? formatProposalTime(ev.end_iso) : null;
  const when = end ? `${start} → ${end.split(' · ')[1] || end}` : start;
  return `
    <div class="chat-event-card">
      <div class="chat-proposal-head">
        <div class="chat-proposal-kind">Calendar event</div>
        ${ev.calendar ? `<div class="chat-event-cal">${escape(ev.calendar)}</div>` : ''}
      </div>
      <div class="chat-proposal-title">${escape(ev.title)}</div>
      <div class="chat-proposal-when">${escape(when)}</div>
      ${ev.location ? `<div class="chat-proposal-meta">📍 ${escape(ev.location)}</div>` : ''}
      ${ev.notes ? `<div class="chat-proposal-notes">${escape(ev.notes)}</div>` : ''}
    </div>
  `;
}

/** Render approval cards for any `propose_*` tool calls on this turn.
 *  Each card shows the structured proposal with [Approve] [Deny]
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

/** Render approve/deny prompts for any `request_user_approval` tool
 *  calls on this turn. Click sends a chat turn with the chosen
 *  label so Galt sees the decision on the next round and acts. */
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
  // Stable-ish id so the local data-status survives a click. Use
  // the question's first chars + ts as a soft fingerprint. Also
  // used as the localStorage key so the decision persists across
  // re-renders.
  const fingerprint = encodeURIComponent((r.question.slice(0, 32) + ':' + (tc.ms || 0)));

  // request_user_approval has no server-side state — the decision
  // is implicit in the conversation history. We persist locally
  // via localStorage keyed on the fingerprint so a re-render
  // (poll/subscription tick) doesn't reset the card to "awaiting"
  // after the user already decided.
  const decided = approvalDecisionFromStore(fingerprint);
  const disabled = decided !== null;

  const buttons = disabled
    ? `
      <div class="chat-approval-actions">
        <button class="chat-proposal-btn dismiss" disabled>${escape(denyLabel)}</button>
        <button class="chat-proposal-btn approve" disabled>${escape(approveLabel)}</button>
      </div>`
    : `
      <div class="chat-approval-actions">
        <button class="chat-proposal-btn dismiss" data-action="approval-deny" data-approval-fp="${fingerprint}" data-label="${escape(denyLabel)}">${escape(denyLabel)}</button>
        <button class="chat-proposal-btn approve" data-action="approval-approve" data-approval-fp="${fingerprint}" data-label="${escape(approveLabel)}">${escape(approveLabel)}</button>
      </div>`;

  const status = decided ?? 'awaiting';

  return `
    <div class="chat-approval-card" data-approval-fp="${fingerprint}" data-status="${escape(status)}">
      <div class="chat-approval-head">
        <div class="chat-approval-kind">Decision</div>
        <div class="chat-approval-status" data-id="approval-status-${fingerprint}">${escape(status)}</div>
      </div>
      <div class="chat-approval-question">${escape(r.question)}</div>
      ${r.context ? `<div class="chat-approval-context">${escape(r.context)}</div>` : ''}
      ${buttons}
    </div>
  `;
}

const APPROVAL_DECISIONS_KEY = 'galt:approvalDecisions';

function approvalDecisionFromStore(fingerprint) {
  try {
    const raw = localStorage.getItem(APPROVAL_DECISIONS_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw);
    return map[fingerprint] || null;
  } catch {
    return null;
  }
}

/** Public: record an approval decision keyed by fingerprint. Called
 *  from actions.js on click so subsequent re-renders show the card
 *  in its decided state. */
export function recordApprovalDecision(fingerprint, status) {
  try {
    const raw = localStorage.getItem(APPROVAL_DECISIONS_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[fingerprint] = status;
    // Cap stored decisions at ~200 — older ones drop off so we
    // don't grow the local-storage entry unboundedly.
    const keys = Object.keys(map);
    if (keys.length > 200) {
      for (const k of keys.slice(0, keys.length - 200)) delete map[k];
    }
    localStorage.setItem(APPROVAL_DECISIONS_KEY, JSON.stringify(map));
  } catch {
    // localStorage full / disabled → decision just won't persist
  }
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

  // Final decision sticks across re-renders. Backend stamps
  // tc.decision_status onto the RTDB tool_calls entry when the
  // proposal is exported / dismissed. Card data-status drives the
  // CSS variant + button-disabled state.
  const decided = tc.decision_status; // 'exported' | 'dismissed' | undefined
  const status = decided === 'exported' ? 'approved'
              : decided === 'dismissed' ? 'denied'
              : 'pending';
  const disabled = status !== 'pending';

  const calendars = (getStore().state && getStore().state.calendars) || [];
  const calendarPicker = disabled ? '' : renderCalendarPicker(r.proposal_id, calendars);

  const buttons = disabled
    ? `
      <div class="chat-proposal-actions">
        <button class="chat-proposal-btn dismiss" disabled>${escape(decided === 'dismissed' ? 'Denied' : 'Deny')}</button>
        <button class="chat-proposal-btn approve" disabled>${escape(decided === 'exported' ? 'Approved' : 'Approve')}</button>
      </div>`
    : `
      <div class="chat-proposal-actions">
        <button class="chat-proposal-btn dismiss" data-action="proposal-dismiss" data-proposal-id="${escape(r.proposal_id)}">Deny</button>
        <button class="chat-proposal-btn approve" data-action="proposal-approve" data-proposal-id="${escape(r.proposal_id)}">Approve & add to Calendar</button>
      </div>`;

  return `
    <div class="chat-proposal-card" data-proposal-id="${escape(r.proposal_id)}" data-status="${escape(status)}">
      <div class="chat-proposal-head">
        <div class="chat-proposal-kind">Calendar event</div>
        <div class="chat-proposal-status" data-id="proposal-status-${escape(r.proposal_id)}">${escape(status)}</div>
      </div>
      <div class="chat-proposal-title">${escape(r.title || 'Untitled')}</div>
      <div class="chat-proposal-when">${escape(when)}</div>
      ${r.location ? `<div class="chat-proposal-meta">📍 ${escape(r.location)}</div>` : ''}
      ${r.participants ? `<div class="chat-proposal-meta">👥 ${escape(r.participants)}</div>` : ''}
      ${r.notes ? `<div class="chat-proposal-notes">${escape(r.notes)}</div>` : ''}
      ${calendarPicker}
      ${buttons}
    </div>
  `;
}

/** "Add to: [Personal ▼]" dropdown. Empty option = use Calendar.app
 *  default (no X-WR-CALNAME stamped). Selecting a calendar fires
 *  data-action="proposal-set-calendar" which patches the proposal
 *  row via an RTDB command. */
function renderCalendarPicker(proposalId, calendars) {
  if (!Array.isArray(calendars) || calendars.length === 0) {
    // No calendar list yet (haven't seen a /state push with it, or
    // backend couldn't read the db). Render nothing — Calendar.app's
    // import dialog will still let the user pick at approve time.
    return '';
  }
  // Stable-uuid keyed options so duplicate titles (Work synced from
  // two accounts) don't collide.
  const options = calendars.map((c) => `
    <option value="${escape(c.title || '')}" data-uuid="${escape(c.uuid || '')}">${escape(c.title || '(untitled)')}</option>
  `).join('');
  return `
    <label class="chat-proposal-picker">
      <span class="chat-proposal-picker-label">Add to</span>
      <select data-action="proposal-set-calendar" data-proposal-id="${escape(proposalId)}">
        <option value="">— Calendar.app default —</option>
        ${options}
      </select>
    </label>
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
