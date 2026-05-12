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

// Tool names with dedicated card rendering (excluded from generic strip).
const REPO_WRITE_TOOLS  = new Set(['write_task', 'move_task', 'git_commit_push']);
const REPO_READ_TOOLS   = new Set(['list_repos', 'repo_status', 'search_tasks', 'active_tasks_all']);
const NOTE_TOOLS        = new Set(['list_auto_notes']);
const CLAUDE_INFO_TOOLS = new Set(['claude_list_sessions']);
const BRAIN_TOOLS       = new Set(['read_memory', 'list_memory', 'write_memory']);

function relTime(ms) {
  if (!ms) return '';
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function bubble(m) {
  const cls = m.role === 'user' ? 'me' : 'galt';
  const proposalCards = renderProposalCards(m.tool_calls);
  const approvalCards = renderApprovalCards(m.tool_calls);
  const eventCards    = renderEventListCards(m.tool_calls);
  const claudeTasks   = renderTaskCards(m.tool_calls);
  const repoReads     = renderRepoReadCards(m.tool_calls);
  const repoWrites    = renderRepoWriteCards(m.tool_calls);
  const noteCards     = renderNoteCards(m.tool_calls);
  const claudeCards   = renderClaudeInfoCards(m.tool_calls);
  const brainCards    = renderBrainCards(m.tool_calls);
  const otherCalls = Array.isArray(m.tool_calls)
    ? m.tool_calls.filter((tc) =>
        !tc.name.startsWith('propose_') &&
        tc.name !== 'request_user_approval' &&
        tc.name !== 'list_calendar_events' &&
        tc.name !== 'claude_ask' &&
        !REPO_WRITE_TOOLS.has(tc.name) &&
        !REPO_READ_TOOLS.has(tc.name) &&
        !NOTE_TOOLS.has(tc.name) &&
        !CLAUDE_INFO_TOOLS.has(tc.name) &&
        !BRAIN_TOOLS.has(tc.name))
    : [];
  const tools = otherCalls.length > 0 ? renderToolCalls(otherCalls) : '';

  // Suppress text when data/brain cards are rendered — cards are the answer.
  const hasDataCards = !!(repoReads || repoWrites || noteCards || claudeCards || eventCards || brainCards);
  const textBubble = m.text && !hasDataCards
    ? `<div class="chat-bubble">${escape(m.text)}</div>`
    : '';

  return `
    <div class="chat-bubble-row ${cls}">
      <div class="chat-bubble-stack">
        ${tools}
        ${brainCards}
        ${repoReads}
        ${repoWrites}
        ${noteCards}
        ${claudeCards}
        ${eventCards}
        ${proposalCards}
        ${approvalCards}
        ${claudeTasks}
        ${textBubble}
      </div>
    </div>
  `;
}

/* ============================================================
   Repo read cards — list_repos / repo_status / search_tasks / active_tasks_all
   ============================================================ */

function renderRepoReadCards(toolCalls) {
  if (!Array.isArray(toolCalls)) return '';
  return toolCalls.map((tc) => {
    if (tc.name === 'list_repos')       return renderListReposCard(tc);
    if (tc.name === 'repo_status')      return renderRepoStatusCard(tc);
    if (tc.name === 'search_tasks')     return renderTaskListCard(tc, 'search');
    if (tc.name === 'active_tasks_all') return renderTaskListCard(tc, 'all-active');
    return '';
  }).filter(Boolean).join('');
}

function renderListReposCard(tc) {
  let repos;
  try { repos = JSON.parse(tc.result_preview || '[]'); } catch { return ''; }
  if (!Array.isArray(repos) || repos.length === 0) return '';
  const rows = repos.map((r) => {
    const count = typeof r.active_task_count === 'number' ? r.active_task_count : '?';
    const countCls = count > 0 ? 'repo-task-count active' : 'repo-task-count';
    const co = r.company ? `<span class="repo-company">${escape(r.company)}</span>` : '';
    return `<div class="repo-row">
      <span class="repo-name">${escape(r.name || `#${r.id}`)}</span>
      ${co}
      <span class="${countCls}">${count} active</span>
    </div>`;
  }).join('');
  return `
    <div class="chat-repo-card">
      <div class="chat-repo-head">
        <span class="chat-repo-kind">Repos</span>
        <span class="chat-repo-meta">${repos.length} tracked</span>
      </div>
      <div class="repo-rows">${rows}</div>
    </div>`;
}

function renderRepoStatusCard(tc) {
  let r;
  try { r = JSON.parse(tc.result_preview || '{}'); } catch { return ''; }
  if (!r || typeof r !== 'object') return '';

  const name = r.repo_name || 'Repo';
  const co   = r.repo_company ? ` · ${r.repo_company}` : '';
  const phases = Array.isArray(r.phases) ? r.phases : [];
  const active = Array.isArray(r.active_tasks) ? r.active_tasks : [];

  const phaseHtml = phases.map((p) => {
    const dot = p.status === 'shipped' ? '●' : p.status === 'active' ? '◉' : '○';
    const cls = `repo-phase-dot ${p.status || 'queued'}`;
    const count = typeof p.task_count === 'number' ? ` (${p.task_count})` : '';
    return `<span class="${cls}">${dot}</span><span class="repo-phase-name">${escape(p.name || `Phase ${p.phase_num}`)}${count}</span>`;
  }).join('<span class="repo-phase-sep">→</span>');

  const taskRows = active.slice(0, 8).map((t) => {
    const age = typeof t.days_since_update === 'number'
      ? `<span class="repo-task-age${t.days_since_update >= 10 ? ' stale' : ''}">${t.days_since_update}d</span>`
      : '';
    return `<div class="repo-task-row">
      <span class="repo-task-id">${escape(t.task_id || '')}</span>
      <span class="repo-task-title">${escape(t.title || '—')}</span>
      ${age}
    </div>`;
  }).join('');
  const moreStr = active.length > 8 ? `<div class="repo-task-more">+${active.length - 8} more active</div>` : '';
  const backlog = typeof r.backlog_count === 'number' && r.backlog_count > 0
    ? `<div class="repo-task-more">${r.backlog_count} in backlog</div>` : '';

  return `
    <div class="chat-repo-card">
      <div class="chat-repo-head">
        <span class="chat-repo-kind">${escape(name)}${escape(co)}</span>
        <span class="chat-repo-meta">${active.length} active</span>
      </div>
      ${phases.length ? `<div class="repo-phase-strip">${phaseHtml}</div>` : ''}
      ${active.length ? `<div class="repo-task-list">${taskRows}${moreStr}</div>` : ''}
      ${backlog}
    </div>`;
}

function renderTaskListCard(tc, kind) {
  let tasks;
  try { tasks = JSON.parse(tc.result_preview || '[]'); } catch { return ''; }
  if (!Array.isArray(tasks)) return '';

  const label = kind === 'search'
    ? `Tasks · "${tc.arguments?.query || '…'}"`
    : 'Active tasks · all repos';

  if (tasks.length === 0) {
    return `
      <div class="chat-repo-card">
        <div class="chat-repo-head">
          <span class="chat-repo-kind">${escape(label)}</span>
          <span class="chat-repo-meta">0 results</span>
        </div>
        <div class="repo-task-more">nothing found</div>
      </div>`;
  }

  const rows = tasks.slice(0, 12).map((t) => {
    const state = t.state || 'backlog';
    const age = typeof t.days_since_update === 'number'
      ? `<span class="repo-task-age${t.days_since_update >= 10 ? ' stale' : ''}">${t.days_since_update}d</span>`
      : '';
    const repo = t.repo_name ? `<span class="repo-task-repo">${escape(t.repo_name)}</span>` : '';
    return `<div class="repo-task-row">
      ${taskStateBadge(state)}
      <span class="repo-task-id">${escape(t.task_id || '')}</span>
      <span class="repo-task-title">${escape(t.title || '—')}</span>
      ${repo}${age}
    </div>`;
  }).join('');
  const more = tasks.length > 12 ? `<div class="repo-task-more">+${tasks.length - 12} more</div>` : '';

  return `
    <div class="chat-repo-card">
      <div class="chat-repo-head">
        <span class="chat-repo-kind">${escape(label)}</span>
        <span class="chat-repo-meta">${tasks.length} result${tasks.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="repo-task-list">${rows}${more}</div>
    </div>`;
}

/* ============================================================
   Repo write cards — write_task / move_task / git_commit_push
   ============================================================ */

function renderRepoWriteCards(toolCalls) {
  if (!Array.isArray(toolCalls)) return '';
  return toolCalls.map((tc) => {
    if (tc.name === 'write_task')      return renderWriteTaskCard(tc);
    if (tc.name === 'move_task')       return renderMoveTaskCard(tc);
    if (tc.name === 'git_commit_push') return renderGitPushCard(tc);
    return '';
  }).filter(Boolean).join('');
}

function renderWriteTaskCard(tc) {
  let r;
  try { r = JSON.parse(tc.result_preview || '{}'); } catch { return ''; }
  if (!r || !r.task_id) return '';
  const filePath = (r.file_path || '').replace(/^.*\/tasks\//, 'tasks/');
  const verb = r.is_new ? 'Created' : 'Updated';
  return `
    <div class="chat-repo-write-card">
      <div class="chat-repo-head">
        <span class="chat-repo-kind repo-write-kind">Task ${escape(verb)}</span>
        ${taskStateBadge(r.state || 'backlog')}
      </div>
      <div class="repo-write-task-id">${escape(r.task_id)}</div>
      <div class="repo-write-task-title">${escape(r.title || '—')}</div>
      ${filePath ? `<div class="repo-write-path">${escape(filePath)}</div>` : ''}
    </div>`;
}

function renderMoveTaskCard(tc) {
  let r;
  try { r = JSON.parse(tc.result_preview || '{}'); } catch { return ''; }
  if (!r || !r.task_id) return '';
  return `
    <div class="chat-repo-write-card">
      <div class="chat-repo-head">
        <span class="chat-repo-kind repo-write-kind">Task Moved</span>
        ${taskStateBadge(r.new_state || '')}
      </div>
      <div class="repo-write-task-id">${escape(r.task_id)}</div>
      <div class="repo-write-task-meta">→ ${escape(r.new_state || '')}</div>
    </div>`;
}

function renderGitPushCard(tc) {
  let r;
  try { r = JSON.parse(tc.result_preview || '{}'); } catch { return ''; }
  if (tc.error) {
    return `
      <div class="chat-repo-write-card git-error">
        <div class="chat-repo-head">
          <span class="chat-repo-kind repo-write-kind">Git Push</span>
          <span class="repo-git-status err">✗ failed</span>
        </div>
        <div class="repo-write-path err">${escape(tc.error || 'unknown error')}</div>
      </div>`;
  }
  if (r && r.committed === false) {
    return `
      <div class="chat-repo-write-card">
        <div class="chat-repo-head">
          <span class="chat-repo-kind repo-write-kind">Git</span>
          <span class="repo-git-status muted">nothing to commit</span>
        </div>
      </div>`;
  }
  const msg = tc.arguments?.message || '';
  return `
    <div class="chat-repo-write-card git-ok">
      <div class="chat-repo-head">
        <span class="chat-repo-kind repo-write-kind">Git Pushed</span>
        <span class="repo-git-status ok">↑ pushed</span>
      </div>
      ${msg ? `<div class="repo-write-task-title">${escape(msg)}</div>` : ''}
    </div>`;
}

function taskStateBadge(state) {
  const label = state || 'backlog';
  return `<span class="repo-state-badge ${escape(label)}">${escape(label)}</span>`;
}

/* ============================================================
   Auto-notes card — list_auto_notes
   ============================================================ */

function renderNoteCards(toolCalls) {
  if (!Array.isArray(toolCalls)) return '';
  return toolCalls
    .map((tc) => tc.name === 'list_auto_notes' ? renderAutoNotesCard(tc) : '')
    .filter(Boolean).join('');
}

function renderAutoNotesCard(tc) {
  let r;
  try { r = JSON.parse(tc.result_preview || '{}'); } catch { return ''; }
  if (!r || typeof r !== 'object') return '';
  const notes = Array.isArray(r.notes) ? r.notes : [];
  const total = typeof r.count === 'number' ? r.count : notes.length;
  const unreviewed = notes.filter((n) => !n.reviewed_at_ms).length;

  const rows = notes.slice(0, 10).map((n) => {
    const cat = (n.category || 'other').toLowerCase();
    const catClass = cat === 'urgent' ? 'urgent' : cat === 'business' ? 'business' : 'other';
    const dot = n.reviewed_at_ms
      ? '<span class="note-dot reviewed">●</span>'
      : '<span class="note-dot open">○</span>';
    const name = escape(n.contact_name || n.handle || '?');
    const summary = escape((n.summary || '').slice(0, 90));
    return `
      <div class="note-row">
        <span class="note-cat-badge ${catClass}">${escape(cat)}</span>
        <span class="note-contact">${name}</span>
        <span class="note-summary">${summary}</span>
        ${dot}
      </div>`;
  }).join('');

  const more = notes.length > 10
    ? `<div class="chat-task-more">+${notes.length - 10} more</div>` : '';
  const unreviewedLabel = unreviewed > 0
    ? `<span class="note-unreviewed-badge">${unreviewed} open</span>` : '';

  return `
    <div class="chat-note-card">
      <div class="chat-repo-card-head">
        <span class="chat-repo-card-kind">Auto Notes</span>
        <span class="chat-repo-card-meta">${total} total ${unreviewedLabel}</span>
      </div>
      ${notes.length ? `<div class="note-rows">${rows}${more}</div>` : '<div class="chat-task-more">nothing to follow up on</div>'}
    </div>`;
}

/* ============================================================
   Claude session card — claude_list_sessions
   ============================================================ */

function renderClaudeInfoCards(toolCalls) {
  if (!Array.isArray(toolCalls)) return '';
  return toolCalls
    .map((tc) => tc.name === 'claude_list_sessions' ? renderClaudeSessionsCard(tc) : '')
    .filter(Boolean).join('');
}

function renderClaudeSessionsCard(tc) {
  let r;
  try { r = JSON.parse(tc.result_preview || '{}'); } catch { return ''; }
  if (!r || typeof r !== 'object') return '';
  const sessions = Array.isArray(r.sessions) ? r.sessions : [];
  const runningCount = typeof r.running_count === 'number' ? r.running_count : 0;

  const rows = sessions.slice(0, 10).map((s) => {
    const project = (s.cwd || '').split('/').filter(Boolean).pop() || '?';
    const title = escape((s.title || 'Untitled session').slice(0, 60));
    const age = s.last_active_at_ms ? relTime(s.last_active_at_ms) : '';
    const runDot = s.is_running
      ? '<span class="claude-session-dot running">●</span>'
      : '<span class="claude-session-dot idle">○</span>';
    return `
      <div class="claude-session-row">
        ${runDot}
        <span class="claude-session-project">${escape(project)}</span>
        <span class="claude-session-title">${title}</span>
        ${age ? `<span class="claude-session-age">${escape(age)}</span>` : ''}
      </div>`;
  }).join('');

  const more = sessions.length > 10
    ? `<div class="chat-task-more">+${sessions.length - 10} more</div>` : '';
  const runningLabel = runningCount > 0
    ? `<span class="claude-running-badge">${runningCount} live</span>` : '';

  return `
    <div class="chat-claude-card">
      <div class="chat-repo-card-head">
        <span class="chat-repo-card-kind">Claude Sessions</span>
        <span class="chat-repo-card-meta">${sessions.length} recent ${runningLabel}</span>
      </div>
      ${sessions.length ? `<div class="claude-session-rows">${rows}${more}</div>` : '<div class="chat-task-more">no sessions found</div>'}
    </div>`;
}

/* ============================================================
   Galt Brain shell — read_memory / list_memory / write_memory
   ============================================================ */

function brainShell(module, bodyHtml) {
  return `
    <div class="chat-brain-shell">
      <div class="chat-brain-header">
        <span class="brain-sigil">◈</span>
        <span class="brain-label">GALT BRAIN</span>
        <span class="brain-module-sep">·</span>
        <span class="brain-module">${escape(module)}</span>
      </div>
      <div class="brain-body">${bodyHtml}</div>
    </div>`;
}

function renderBrainCards(toolCalls) {
  if (!Array.isArray(toolCalls)) return '';
  return toolCalls
    .map((tc) => {
      if (tc.name === 'read_memory')  return renderMemoryReadCard(tc);
      if (tc.name === 'list_memory')  return renderMemoryListCard(tc);
      if (tc.name === 'write_memory') return renderMemoryWriteCard(tc);
      return '';
    })
    .filter(Boolean).join('');
}

function renderMemoryReadCard(tc) {
  let r;
  try { r = JSON.parse(tc.result_preview || '{}'); } catch { return ''; }
  if (!r) return '';
  const filePath = escape((r.file_path || tc.arguments?.file_path || '').replace(/^memories\//, ''));
  if (!r.found) {
    return brainShell('MEMORY', `
      <div class="brain-memory-path">${filePath}</div>
      <div class="brain-memory-empty">nothing saved yet</div>`);
  }
  const preview = escape((r.content || '').slice(0, 300));
  const trimmed = (r.content || '').length > 300;
  return brainShell('MEMORY', `
    <div class="brain-memory-path">${filePath}</div>
    <div class="brain-memory-content">${preview}${trimmed ? '<span class="brain-memory-more">…</span>' : ''}</div>`);
}

function renderMemoryListCard(tc) {
  let r;
  try { r = JSON.parse(tc.result_preview || '{}'); } catch { return ''; }
  if (!r) return '';
  const dir = escape((r.dir || '').replace(/^memories\//, ''));
  const entries = Array.isArray(r.entries) ? r.entries : [];
  if (entries.length === 0) {
    return brainShell('MEMORY', `
      <div class="brain-memory-path">${dir}</div>
      <div class="brain-memory-empty">nothing here yet</div>`);
  }
  const rows = entries.map((e) => {
    const icon = e.type === 'dir' ? '▸' : '·';
    const cls  = e.type === 'dir' ? 'brain-entry-dir' : 'brain-entry-file';
    return `<div class="brain-entry ${cls}"><span class="brain-entry-icon">${icon}</span><span class="brain-entry-name">${escape(e.name)}</span></div>`;
  }).join('');
  return brainShell('MEMORY', `
    <div class="brain-memory-path">${dir}</div>
    <div class="brain-entry-list">${rows}</div>
    <div class="brain-entry-count">${entries.length} item${entries.length !== 1 ? 's' : ''}</div>`);
}

function renderMemoryWriteCard(tc) {
  let r;
  try { r = JSON.parse(tc.result_preview || '{}'); } catch { return ''; }
  if (!r) return '';
  const filePath = escape((r.file_path || tc.arguments?.file_path || '').replace(/^memories\//, ''));
  const verb = r.is_new ? 'created' : 'appended';
  const ok = r.ok !== false;
  if (!ok) {
    return brainShell('MEMORY', `
      <div class="brain-memory-path">${filePath}</div>
      <div class="brain-write-status err">✗ ${escape(r.error || 'write failed')}</div>`);
  }
  return brainShell('MEMORY', `
    <div class="brain-memory-path">${filePath}</div>
    <div class="brain-write-status ok">✓ ${escape(verb)}</div>`);
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
