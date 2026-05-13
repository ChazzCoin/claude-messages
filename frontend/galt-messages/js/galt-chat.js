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

  // Cut off Galt if he's mid-sentence — user is taking the turn
  cancelSpeech();

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

// Track the last Galt message we spoke so we don't re-speak on every
// re-render (RTDB pushes can fire multiple times for the same message).
let _lastSpokenId = null;

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
  // Auto-speak the latest Galt message if voice is enabled and it's new.
  const last = messages[messages.length - 1];
  if (last && last.role === 'galt' && last.id !== _lastSpokenId) {
    const textToSpeak = last.text || '';
    if (textToSpeak.trim()) {
      _lastSpokenId = last.id;

      // If a memory mic request was in flight, route the reply through the
      // memory response panel (voice-off path) or speak it (voice-on path).
      if (_memoryWaiting) {
        _memoryWaiting = false;
        if (voiceEnabled()) {
          // Voice on: speak, and show speaking state on the memory button.
          _setMemoryState('speaking');
          speakText(textToSpeak, { onEnd: () => _setMemoryState('idle') });
        } else {
          // Voice off: show reply inline below the memory mic button.
          _setMemoryState('idle');
          _setMemoryPanel('reply', textToSpeak);
        }
      } else {
        // Normal chat page flow — speak unconditionally if voice is on.
        speakText(textToSpeak);
      }
    }
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

export function subscribeToTask(taskId) {
  const rowRef = ref(db, `/tasks/${taskId}`);
  const eventsRef = ref(db, `/tasks/${taskId}/events`);

  const rowCb = (snap) => {
    const task = snap.val();
    if (!task) return;
    updateTaskCardRow(taskId, task);
    // Keep COS pill dots + task view status in sync
    _cosOnTaskUpdate(taskId, task.status, task.pr ?? null);
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
  // querySelectorAll so both mobile and desktop quick-action panels update.
  const cards = document.querySelectorAll(`.chat-task-card[data-task-id="${cssEsc(taskId)}"]`);
  if (!cards.length) return;
  for (const card of cards) {
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

  // PR card — appears when the onComplete callback mirrors task.pr to RTDB.
  if (task.pr) {
    const pr = task.pr;
    let prSlot = card.querySelector('.chat-task-pr-card');
    if (!prSlot) {
      prSlot = document.createElement('div');
      prSlot.className = 'chat-task-pr-card';
      card.appendChild(prSlot);
    }
    // Only re-render if the state actually changed (avoids button flicker).
    if (prSlot.dataset.prState === pr.state && prSlot.dataset.prNumber === String(pr.number)) {
      // state unchanged — skip re-render
    } else {
      const isOpen   = pr.state === 'open';
      const isMerged = pr.state === 'merged';
      const stateIcon = isMerged ? '✓' : pr.state === 'closed' ? '✗' : '⎇';

      // Truncate body for preview (first non-empty line, max 120 chars)
      const bodyPreview = (() => {
        if (!pr.body) return '';
        const first = pr.body.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('>'));
        if (!first) return '';
        return first.length > 120 ? first.slice(0, 120) + '…' : first;
      })();

      prSlot.innerHTML = `
        <div class="task-pr-top">
          <div class="task-pr-breadcrumb">
            <span class="task-pr-repo">${escape(pr.repo_name)}</span>
            <span class="task-pr-sep">›</span>
            <span class="task-pr-num">#${escape(pr.number)}</span>
            <span class="task-pr-state-badge task-pr-state-${escape(pr.state)}">${stateIcon} ${escape(pr.state)}</span>
          </div>
          <a class="task-pr-open-btn" href="${escape(pr.url)}" target="_blank" rel="noopener" title="Open on GitHub">
            View PR →
          </a>
        </div>
        <div class="task-pr-title">${escape(pr.title)}</div>
        ${bodyPreview ? `<div class="task-pr-body">${escape(bodyPreview)}</div>` : ''}
        <div class="task-pr-branch">⎇ ${escape(pr.branch)}</div>
        ${isOpen ? `
          <div class="task-pr-actions">
            <button class="task-pr-merge-btn" data-action="approve-pr" data-task-id="${escape(taskId)}" data-repo-id="${escape(pr.repo_id)}" data-pr-number="${escape(pr.number)}">✓ Merge</button>
            <button class="task-pr-close-btn" data-action="deny-pr" data-task-id="${escape(taskId)}" data-repo-id="${escape(pr.repo_id)}" data-pr-number="${escape(pr.number)}">✗ Close</button>
          </div>` : ''}
      `;
      prSlot.dataset.prState  = pr.state;
      prSlot.dataset.prNumber = String(pr.number);
    }
  }
  } // end for (const card of cards)
}

function appendTaskCardEvent(taskId, ev) {
  // querySelectorAll so both mobile and desktop quick-action panels update.
  const roots = document.querySelectorAll(`[data-id="task-events-${cssEsc(taskId)}"]`);
  if (!roots.length) return;
  const html = renderTaskEventLine(ev);
  if (!html) return;
  for (const root of roots) {
    root.insertAdjacentHTML('beforeend', html);
  }
  // Auto-scroll the chat page if open.
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
  // Restore voice state from localStorage on boot
  initVoice();
}

/** Focus the input after the sheet animates in. */
export function focusChatInput() {
  const input = document.querySelector('[data-id="chat-input"]');
  if (!input) return;
  // 150ms ≈ matches the sheet slide-up; focusing earlier scrolls the
  // viewport oddly on iOS.
  setTimeout(() => input.focus(), 180);
}

/* ============================================================
   Voice module — two-way voice for the companion PWA.

   STT: Web Speech API (SpeechRecognition / webkitSpeechRecognition)
   TTS: Web Speech Synthesis API (speechSynthesis)

   localStorage keys:
     galt_voice_enabled — 'true' | 'false'
     galt_voice_name    — selected SpeechSynthesisVoice name

   Flow (STT):
     user taps mic → startListening() → onresult → fills input →
     auto-submits via submitChatTurn()

   Flow (TTS):
     renderMessages() sees new Galt reply → speakText(text) →
     speechSynthesis.speak(). cancelSpeech() fires at the top of
     submitChatTurn so Galt stops talking when user sends a new turn.

   iOS note: speechSynthesis requires a silent utterance fired on
   the first user gesture to unlock the API. unlockSpeechSynthesis()
   is called inside toggleVoice() when the user first enables voice.
   ============================================================ */

const _LS_ENABLED = 'galt_voice_enabled';
const _LS_VOICE   = 'galt_voice_name';

let _recognition    = null;
let _listening      = false;
let _speechUnlocked = false;
let _isSpeaking     = false;    // true while speechSynthesis is mid-utterance
let _memoryWaiting  = false;    // true after memory mic submit, waiting for Galt reply

export function voiceEnabled() {
  return localStorage.getItem(_LS_ENABLED) === 'true';
}

function _setVoiceEnabled(on) {
  localStorage.setItem(_LS_ENABLED, String(on));
  _applyVoiceUI();
}

function _applyVoiceUI() {
  const on          = voiceEnabled();
  const chatPage    = document.querySelector('.chat-page');
  const primaryBtn  = document.querySelector('[data-id="chat-primary-btn"]');
  const chatInput   = document.querySelector('[data-id="chat-input"]');
  const settingsBtn = document.querySelector('[data-id="voice-settings-toggle"]');
  const picker      = document.querySelector('[data-id="voice-picker"]');
  const testBtn     = document.querySelector('[data-id="voice-test-btn"]');

  // data-voice on .chat-page drives icon swap + input dimming via CSS
  if (chatPage) chatPage.dataset.voice = String(on);

  // ALL global voice toggle buttons (mobile header, desktop sidebar, chat header)
  for (const btn of document.querySelectorAll('.voice-global-btn')) {
    btn.dataset.on = String(on);
  }

  // Swap the single chat send/mic button's action
  if (primaryBtn) {
    primaryBtn.dataset.action = on ? 'chat-mic' : 'chat-send';
    primaryBtn.setAttribute('aria-label', on ? 'Speak' : 'Send');
  }

  // Read-only in voice mode — interim text still streams in via JS
  if (chatInput)   chatInput.readOnly      = on;
  if (settingsBtn) settingsBtn.textContent = on ? 'On' : 'Off';
  if (picker)      picker.style.display    = on ? 'block' : 'none';
  if (testBtn)     testBtn.style.display   = on ? 'block' : 'none';

  if (!on && _listening) _stopListening();
}

/** Update data-speaking on all voice buttons + chat send button. */
function _setSpeakingUI(on) {
  _isSpeaking = on;
  for (const btn of document.querySelectorAll('.voice-global-btn')) {
    btn.dataset.speaking = String(on);
  }
  const primaryBtn = document.querySelector('[data-id="chat-primary-btn"]');
  if (primaryBtn) primaryBtn.dataset.speaking = String(on);
}

/** Set the memory mic button state (idle | listening | waiting | speaking)
 *  and update the hint text across both mobile and desktop instances. */
function _setMemoryState(state) {
  const hintMap = { idle: 'Tap to speak', listening: 'Listening…', waiting: 'Thinking…', speaking: 'Speaking…' };
  const hint = hintMap[state] || 'Tap to speak';
  for (const btn of document.querySelectorAll('[data-id="memory-mic-btn"], [data-id="d-memory-mic-btn"]')) {
    btn.dataset.memState = state;
    const hintEl = btn.querySelector('.memory-mic-hint');
    if (hintEl) hintEl.textContent = hint;
    const stateLabel = btn.querySelector('.memory-mic-state-label');
    if (stateLabel) stateLabel.textContent = state === 'idle' ? 'Memory' : hint;
  }
}

/** Show / update / hide the inline memory response panel.
 *  Injects HTML so there's no show/hide fight with CSS display rules.
 *
 *  state: 'waiting' | 'reply' | 'hidden' */
function _setMemoryPanel(state, text = '') {
  const panels = [
    document.querySelector('[data-id="memory-response"]'),
    document.querySelector('[data-id="d-memory-response"]'),
  ].filter(Boolean);

  if (state === 'hidden') {
    for (const p of panels) { p.hidden = true; p.innerHTML = ''; }
    return;
  }

  if (state === 'waiting') {
    const html = `
      <div class="memory-response-loading">
        <span></span><span></span><span></span>
      </div>`;
    for (const p of panels) { p.hidden = false; p.innerHTML = html; }
    return;
  }

  if (state === 'reply') {
    // Exact same structure as brainShell() in the chat renderer —
    // purple header, ◈ GALT BRAIN · MEMORY, body with the reply text.
    const html = `
      <div class="memory-brain-card">
        <div class="chat-brain-header">
          <span class="brain-sigil">◈</span>
          <span class="brain-label">GALT BRAIN</span>
          <span class="brain-module-sep">·</span>
          <span class="brain-module">MEMORY</span>
          <button class="memory-response-dismiss" data-action="memory-dismiss" aria-label="Dismiss">×</button>
        </div>
        <div class="brain-body">
          <div class="brain-memory-content">${escape(text)}</div>
        </div>
      </div>`;
    for (const p of panels) { p.hidden = false; p.innerHTML = html; }
  }
}

/** Hide the memory response panel. Exported so actions.js can wire the dismiss button. */
export function dismissMemoryResponse() {
  _setMemoryPanel('hidden');
}

function _unlockSpeechSynthesis() {
  if (_speechUnlocked || typeof speechSynthesis === 'undefined') return;
  const u = new SpeechSynthesisUtterance('');
  u.volume = 0;
  speechSynthesis.speak(u);
  _speechUnlocked = true;
}

/** Strip markdown so it doesn't get read aloud. */
function _stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')           // fenced code
    .replace(/`[^`]+`/g, '')                   // inline code
    .replace(/#+\s/g, '')                      // headings
    .replace(/\*\*([^*]+)\*\*/g, '$1')        // **bold**
    .replace(/\*([^*]+)\*/g, '$1')            // *italic*
    .replace(/__([^_]+)__/g, '$1')            // __bold__
    .replace(/_([^_]+)_/g, '$1')              // _italic_
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [label](url)
    .replace(/^\s*[-*+]\s/gm, '')             // list bullets
    .replace(/\n{2,}/g, '. ')                 // paragraph breaks → pause
    .replace(/\n/g, ' ')
    .trim();
}

function _getSelectedVoice() {
  if (typeof speechSynthesis === 'undefined') return null;
  const name   = localStorage.getItem(_LS_VOICE);
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  if (name) {
    const v = voices.find(v => v.name === name);
    if (v) return v;
  }
  return voices.find(v => v.lang.startsWith('en')) || voices[0] || null;
}

/** Speak a Galt reply aloud. No-op if voice is disabled or unsupported.
 *  Tracks _isSpeaking so buttons animate during playback. */
export function speakText(text, { onEnd } = {}) {
  if (!voiceEnabled()) return;
  if (!text || !text.trim()) return;
  if (typeof speechSynthesis === 'undefined') return;
  cancelSpeech();
  const u = new SpeechSynthesisUtterance(_stripMarkdown(text));
  const v = _getSelectedVoice();
  if (v) u.voice = v;
  u.rate  = 1.05;
  u.pitch = 1;
  u.onstart = () => { _setSpeakingUI(true); };
  u.onend   = () => { _setSpeakingUI(false); if (onEnd) onEnd(); };
  u.onerror  = () => { _setSpeakingUI(false); if (onEnd) onEnd(); };
  speechSynthesis.speak(u);
}

/** Cancel any in-flight speech. Called at the top of submitChatTurn. */
export function cancelSpeech() {
  if (typeof speechSynthesis === 'undefined') return;
  if (speechSynthesis.speaking || speechSynthesis.pending) {
    speechSynthesis.cancel();
    _setSpeakingUI(false);
  }
}

function _setListeningUI(on) {
  for (const btn of document.querySelectorAll('.voice-global-btn')) {
    btn.dataset.listening = String(on);
  }
  const primaryBtn = document.querySelector('[data-id="chat-primary-btn"]');
  if (primaryBtn) primaryBtn.dataset.listening = String(on);
}

function _stopListening() {
  if (_recognition) {
    try { _recognition.stop(); } catch (_) {}
    _recognition = null;
  }
  _listening = false;
  _setListeningUI(false);
}

function _startListening() {
  if (_listening) { _stopListening(); return; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    showToast('Speech input not supported in this browser', 'error');
    return;
  }

  _recognition = new SR();
  _recognition.lang            = 'en-US';
  _recognition.interimResults  = true;   // real-time transcript feedback
  _recognition.maxAlternatives = 1;
  _recognition.continuous      = false;

  _recognition.onresult = (e) => {
    // Concatenate all result segments into one live transcript string.
    // The API delivers a growing array: earlier items may be final,
    // the last item is interim until it stabilises.
    let transcript = '';
    let hasFinal   = false;
    for (let i = 0; i < e.results.length; i++) {
      transcript += e.results[i][0].transcript;
      if (e.results[i].isFinal) hasFinal = true;
    }

    // Populate the input field in real-time so the user can read along.
    // The field is readOnly in voice mode so this is the only way text
    // appears there — no conflict with manual typing.
    const input = document.querySelector('[data-id="chat-input"]');
    if (input) { input.value = transcript; autosizeInput(input); }

    // Only fire the send when the engine has committed a final result.
    if (hasFinal && transcript.trim()) {
      _stopListening();
      setTimeout(() => void submitChatTurn(transcript.trim(), { clearInput: true }), 80);
    }
  };

  _recognition.onerror = (e) => {
    _stopListening();
    if (e.error !== 'no-speech' && e.error !== 'aborted') {
      showToast(`Voice error: ${e.error}`, 'error');
    }
  };

  _recognition.onend = () => { if (_listening) _stopListening(); };

  _recognition.start();
  _listening = true;
  _setListeningUI(true);
}

/** Toggle voice on/off (header button + settings toggle). */
export function toggleVoice() {
  const on = !voiceEnabled();
  if (on) {
    _unlockSpeechSynthesis();
    populateVoicePicker();
  } else {
    _stopListening();
    cancelSpeech();
  }
  _setVoiceEnabled(on);
}

/** Toggle the mic (listen / stop listening). */
export function toggleMic() {
  if (!voiceEnabled()) return;
  cancelSpeech();        // cut Galt off if he's talking
  _startListening();
}

/** Populate the voice picker <select> in settings with English voices. */
export function populateVoicePicker() {
  const select = document.querySelector('[data-id="voice-picker"]');
  if (!select || typeof speechSynthesis === 'undefined') return;

  function fill() {
    const voices = speechSynthesis.getVoices()
      .filter(v => v.lang.startsWith('en'))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!voices.length) return;
    const saved = localStorage.getItem(_LS_VOICE);
    select.innerHTML = voices.map(v =>
      `<option value="${escape(v.name)}"${v.name === saved ? ' selected' : ''}>${escape(v.name)} (${v.lang})</option>`
    ).join('');
    select.onchange = () => localStorage.setItem(_LS_VOICE, select.value);
  }

  // Chrome fires 'voiceschanged'; Safari/iOS may have them immediately
  if (speechSynthesis.getVoices().length > 0) {
    fill();
  } else {
    speechSynthesis.addEventListener('voiceschanged', fill, { once: true });
  }
}

/** Test the currently selected voice. */
export function testVoice() {
  speakText("Hey, this is Galt. Voice is working.");
}

/** Restore voice UI state from localStorage. Called once at boot. */
export function initVoice() {
  _applyVoiceUI();
  if (voiceEnabled()) populateVoicePicker();
}

/* ============================================================
   Claude quick-action — home-screen direct Claude delegation.

   Flow:
     tap → listen → send 'quick_claude' command →
       backend creates task (startClaudeTask) → returns task_id →
       subscribe to /tasks/<task_id> → stream events inline

   The injected .chat-task-card reuses ALL existing task-card
   update machinery (updateTaskCardRow / appendTaskCardEvent).
   The outer .claude-quick-card provides the blue Claude header.
   ============================================================ */

let _claudeRec         = null;
let _claudeListening   = false;

function _setClaudeState(state) {
  const hintMap = { idle: 'Tap to ask', listening: 'Listening…', waiting: 'Connecting…' };
  const hint = hintMap[state] || 'Tap to ask';
  for (const btn of document.querySelectorAll('[data-id="claude-mic-btn"], [data-id="d-claude-mic-btn"]')) {
    btn.dataset.claudeState = state;
    const hintEl = btn.querySelector('.claude-mic-hint');
    if (hintEl) hintEl.textContent = hint;
    const stateLabel = btn.querySelector('.claude-mic-state-label');
    if (stateLabel) stateLabel.textContent = state === 'idle' ? 'Claude' : hint;
  }
}

function _stopClaudeListening() {
  if (_claudeRec) { try { _claudeRec.stop(); } catch (_) {} _claudeRec = null; }
  _claudeListening = false;
}

/** Inject content into the Claude response panels.
 *  state: 'hidden' | 'waiting' | 'task'  */
function _setClaudePanel(state, taskId = '') {
  const panels = [
    document.querySelector('[data-id="claude-response"]'),
    document.querySelector('[data-id="d-claude-response"]'),
  ].filter(Boolean);

  if (state === 'hidden') {
    for (const p of panels) { p.hidden = true; p.innerHTML = ''; }
    return;
  }

  if (state === 'waiting') {
    const html = `
      <div class="claude-quick-card">
        <div class="claude-quick-header">
          <span class="claude-sigil">◆</span>
          <span class="claude-label">CLAUDE</span>
          <span class="brain-module-sep">·</span>
          <span class="brain-module">connecting</span>
          <button class="memory-response-dismiss" data-action="claude-dismiss" aria-label="Dismiss">×</button>
        </div>
        <div class="memory-response-loading" style="padding:10px 12px;">
          <span></span><span></span><span></span>
        </div>
      </div>`;
    for (const p of panels) { p.hidden = false; p.innerHTML = html; }
    return;
  }

  if (state === 'task') {
    // Both panels get the same shell. The first panel's data-ids get
    // picked up by subscribeToTask; the second panel mirrors via the
    // querySelectorAll fix in updateTaskCardRow / appendTaskCardEvent.
    const id = escape(taskId);
    const cardHtml = `
      <div class="claude-quick-card">
        <div class="claude-quick-header">
          <span class="claude-sigil">◆</span>
          <span class="claude-label">CLAUDE</span>
          <span class="brain-module-sep">·</span>
          <span class="claude-status-badge" data-id="task-status-${id}">queued</span>
          <button class="memory-response-dismiss" data-action="claude-dismiss" aria-label="Dismiss">×</button>
        </div>
        <div class="chat-task-card" data-task-id="${id}" data-status="queued">
          <div class="chat-task-body">
            <div class="chat-task-events" data-id="task-events-${id}"></div>
            <div class="chat-task-message" data-id="task-message-${id}"></div>
          </div>
          <div class="chat-task-foot">
            <div class="chat-task-meta" data-id="task-meta-${id}"></div>
            <button class="chat-proposal-btn dismiss chat-task-cancel" data-action="task-cancel" data-task-id="${id}">Cancel</button>
          </div>
        </div>
      </div>`;
    for (const p of panels) { p.hidden = false; p.innerHTML = cardHtml; }
    // Wire the live RTDB subscription — idempotent guard inside.
    subscribeToTask(taskId);
  }
}

/** Open the repo-task-sheet body with a live task card for the given UUID.
 *  Called by actions.js after `start_repo_task` returns the task UUID.
 *  The caller opens the sheet; this function just writes the content + wires the sub. */
export function openRepoTaskPanel(taskId, title) {
  const titleEl = document.querySelector('[data-id="repo-task-sheet-title"]');
  const bodyEl  = document.querySelector('[data-id="repo-task-sheet-body"]');
  if (!bodyEl) return;
  if (titleEl) titleEl.textContent = title || 'Task';

  const id = escape(taskId);
  bodyEl.innerHTML = `
    <div class="chat-task-card" data-task-id="${id}" data-status="queued">
      <div class="chat-task-head">
        <div class="chat-task-kind">⚡ Claude Code</div>
        <div class="chat-task-status" data-id="task-status-${id}">queued</div>
      </div>
      <div class="chat-task-body" data-id="task-body-${id}">
        <div class="chat-task-events" data-id="task-events-${id}"></div>
        <div class="chat-task-message" data-id="task-message-${id}"></div>
      </div>
      <div class="chat-task-foot">
        <div class="chat-task-meta" data-id="task-meta-${id}"></div>
        <button class="chat-proposal-btn dismiss chat-task-cancel" data-action="task-cancel" data-task-id="${id}">Cancel</button>
      </div>
    </div>
  `;
  subscribeToTask(taskId);
}

/* ============================================================
   Claude Output Sheet (COS) — global multi-task stream viewer.

   Design: Galt Brain visual language, Claude-blue palette.
   Each repo task (assign / spec / create task / create phase)
   opens a live streaming view inside this sheet. Multiple
   concurrent tasks are tracked in a pill queue at the top.

   The COS reuses all existing .chat-task-card machinery:
   subscribeToTask → updateTaskCardRow → appendTaskCardEvent.
   We inject a .chat-task-card into a .cos-task-view wrapper;
   the subscription finds it via querySelectorAll.
   ============================================================ */

const _cosTasks = new Map();  // taskId → { title, repoId, status, pr }
let   _cosActiveId = null;

/** Open the COS for a new task (or re-focus an existing one). */
export function openClaudeOutputSheet(taskId, title, repoId) {
  if (!_cosTasks.has(taskId)) {
    _cosTasks.set(taskId, {
      title:   title || taskId,
      repoId:  repoId ?? null,
      status:  'queued',
      pr:      null,
    });
    _cosInjectView(taskId, title);
    subscribeToTask(taskId);
  }
  _cosActivate(taskId);
  // Open the sheet via the existing open/close helpers
  const backdrop = document.querySelector('[data-id="cos-backdrop"]');
  const sheet    = document.querySelector('[data-id="cos-sheet"]');
  if (backdrop) backdrop.dataset.visible = 'true';
  if (sheet)    sheet.dataset.visible    = 'true';
}

/** Switch the active task view from a pill tap. */
export function selectCOSTask(taskId) {
  if (_cosTasks.has(taskId)) _cosActivate(taskId);
}

/** Return tasks with open PRs for a given repo — used by renderRepoPage. */
export function getCOSOpenPRsForRepo(repoId) {
  const out = [];
  for (const [taskId, meta] of _cosTasks) {
    if (meta.repoId === repoId && meta.pr?.state === 'open') {
      out.push({ taskId, pr: meta.pr });
    }
  }
  return out;
}

/* -- internal -- */

function _cosInjectView(taskId, title) {
  const body = document.querySelector('[data-id="cos-body"]');
  if (!body) return;
  const id   = escape(taskId);
  const view = document.createElement('div');
  view.className          = 'cos-task-view';
  view.dataset.taskId     = taskId;
  view.dataset.taskStatus = 'queued';
  view.style.display      = 'none';
  view.innerHTML = `
    <div class="cos-task-header">
      <span class="cos-task-title-text">${escape(title || taskId)}</span>
      <span class="cos-task-status-chip" data-id="task-status-${id}">queued</span>
      <button class="cos-cancel-btn chat-task-cancel" data-action="task-cancel" data-task-id="${id}">Cancel</button>
    </div>
    <div class="cos-task-card-wrap">
      <div class="chat-task-card" data-task-id="${id}" data-status="queued">
        <div class="chat-task-body" data-id="task-body-${id}">
          <div class="chat-task-events" data-id="task-events-${id}"></div>
          <div class="chat-task-message" data-id="task-message-${id}"></div>
        </div>
        <div class="chat-task-foot">
          <div class="chat-task-meta" data-id="task-meta-${id}"></div>
          <button class="chat-proposal-btn dismiss chat-task-cancel" data-action="task-cancel" data-task-id="${id}">Cancel</button>
        </div>
      </div>
    </div>`;
  body.appendChild(view);
}

function _cosActivate(taskId) {
  _cosActiveId = taskId;
  for (const v of document.querySelectorAll('.cos-task-view')) {
    v.style.display = v.dataset.taskId === taskId ? '' : 'none';
  }
  const meta = _cosTasks.get(taskId);
  const bar = document.querySelector('[data-id="cos-session-bar"]');
  if (bar) bar.dataset.available = String(!!meta?.repoId);
  _cosRenderQueue();
}

/** Return the repoId for the currently active COS task, or null if
 *  there is no active task or the task has no repo association. */
export function getActiveCOSRepoId() {
  const meta = _cosTasks.get(_cosActiveId);
  return meta?.repoId ?? null;
}

function _cosRenderQueue() {
  const queueEl  = document.querySelector('[data-id="cos-queue"]');
  const countEl  = document.querySelector('[data-id="cos-task-count"]');
  const pillEl   = document.querySelector('[data-id="cos-reopen-pill"]');
  const reopenCt = document.querySelector('[data-id="cos-reopen-count"]');
  if (!queueEl) return;

  const pills = [];
  let hasRunning = false;
  for (const [id, meta] of _cosTasks) {
    const isActive = id === _cosActiveId;
    const st = meta.status || 'queued';
    if (st === 'running' || st === 'queued') hasRunning = true;
    pills.push(`
      <button class="cos-task-pill${isActive ? ' active' : ''}"
        data-action="cos-task-select" data-task-id="${escape(id)}">
        <span class="cos-pill-dot" data-status="${escape(st)}"></span>
        <span>${escape(meta.title.length > 32 ? meta.title.slice(0, 30) + '…' : meta.title)}</span>
      </button>`);
  }
  queueEl.innerHTML = pills.join('');

  const count = _cosTasks.size;
  if (countEl) countEl.textContent = count > 0 ? String(count) : '';

  // Drive the global reopen pill
  if (pillEl) {
    pillEl.dataset.visible = count > 0 ? 'true' : 'false';
    pillEl.dataset.running = hasRunning ? 'true' : 'false';
  }
  if (reopenCt) reopenCt.textContent = count > 0 ? String(count) : '';
}

/** Called from subscribeToTask's onValue handler — keeps COS in sync. */
function _cosOnTaskUpdate(taskId, status, pr) {
  const meta = _cosTasks.get(taskId);
  if (!meta) return;
  if (status) {
    meta.status = status;
    // Stamp data-task-status on the view element for CSS-driven chip colors
    const view = document.querySelector(`.cos-task-view[data-task-id="${CSS.escape(taskId)}"]`);
    if (view) view.dataset.taskStatus = status;
  }
  if (pr) meta.pr = pr;
  _cosRenderQueue();
}

/** Dismiss the Claude response panel. */
export function dismissClaudePanel() {
  _setClaudePanel('hidden');
}

/** Tap-to-talk quick action for Claude Code delegation.
 *  Sends the spoken request directly to Claude (not via Galt),
 *  then streams the task result inline below the button. */
export async function startClaudeMic() {
  if (_claudeListening) {
    _stopClaudeListening();
    _setClaudeState('idle');
    return;
  }

  // Clear any previous result + cancel in-flight speech.
  _setClaudePanel('hidden');
  cancelSpeech();

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    showToast('Speech input not supported in this browser', 'error');
    return;
  }
  _unlockSpeechSynthesis();

  const rec = new SR();
  rec.lang = 'en-US'; rec.interimResults = false; rec.continuous = false;

  rec.onresult = async (e) => {
    const transcript = e.results[0]?.[0]?.transcript?.trim();
    if (!transcript) { _stopClaudeListening(); _setClaudeState('idle'); return; }

    _stopClaudeListening();
    _setClaudeState('waiting');
    _setClaudePanel('waiting');

    // Read selected repo from either selector (mobile or desktop)
    const sel = document.querySelector('[data-id="repo-mic-select"]')
             || document.querySelector('[data-id="d-repo-mic-select"]');
    const repoId = sel?.value ? parseInt(sel.value, 10) : NaN;

    try {
      let result;
      if (Number.isFinite(repoId)) {
        result = await sendCommand('repo_claude_task', { repo_id: repoId, text: transcript });
      } else {
        result = await sendCommand('quick_claude', { text: transcript });
      }
      const taskId = result?.task_id;
      if (!taskId) throw new Error('no task_id returned');
      _setClaudeState('idle');
      _setClaudePanel('task', taskId);
    } catch (err) {
      _setClaudeState('idle');
      _setClaudePanel('hidden');
      showToast(`Claude: ${err.message}`, 'error');
    }
  };

  rec.onerror = (e) => {
    _stopClaudeListening(); _setClaudeState('idle');
    if (e.error !== 'no-speech' && e.error !== 'aborted') showToast(`Voice: ${e.error}`, 'error');
  };
  rec.onend = () => { if (_claudeListening) { _stopClaudeListening(); _setClaudeState('idle'); } };

  _claudeRec = rec;
  rec.start();
  _claudeListening = true;
  _setClaudeState('listening');
}

/* ============================================================
   Memory quick-action mic — home-screen shortcut.

   Tap → listen → send text to Galt as a chat turn.
   Galt's memory tools (write_memory / read_memory / list_memory)
   handle the rest from context.

   Output routing:
     voice ON  → reply spoken aloud via the global subscription
     voice OFF → navigate to #/chat so the user can read the reply

   iOS note: mic permission is not persisted across PWA launches in
   WebKit — this is a platform limitation. We call
   _unlockSpeechSynthesis() here so at minimum TTS is primed. The
   mic grant popup will appear each time on iOS; there is no
   workaround short of a native app.
   ============================================================ */

let _memoryRec       = null;
let _memoryListeningFlag = false;

function _stopMemoryListening() {
  if (_memoryRec) {
    try { _memoryRec.stop(); } catch (_) {}
    _memoryRec = null;
  }
  _memoryListeningFlag = false;
  // Only reset state if not already handed off to waiting/speaking
  // (caller decides what state comes next).
}

/** Tap-to-talk shortcut for the home screen.
 *
 *  State machine:
 *    idle ──tap──▶ listening ──result──▶ waiting ──Galt reply──▶
 *      voice on:  speaking ──onend──▶ idle
 *      voice off: idle (inline panel shows reply)
 *
 *  Tapping again while listening cancels and resets.
 */
export function startMemoryMic() {
  // If already listening → cancel
  if (_memoryListeningFlag) {
    _stopMemoryListening();
    _setMemoryState('idle');
    return;
  }
  // If waiting or speaking → also cancel (user tapping again means "new request")
  _setMemoryPanel('hidden');
  cancelSpeech();
  _memoryWaiting = false;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    showToast('Speech input not supported in this browser', 'error');
    return;
  }

  // Unlock TTS on this user gesture so the spoken reply works on iOS.
  _unlockSpeechSynthesis();

  const rec = new SR();
  rec.lang            = 'en-US';
  rec.interimResults  = false;
  rec.maxAlternatives = 1;
  rec.continuous      = false;

  rec.onresult = (e) => {
    const transcript = e.results[0]?.[0]?.transcript?.trim();
    if (!transcript) { _stopMemoryListening(); _setMemoryState('idle'); return; }

    _stopMemoryListening();
    // Transition to waiting — show the response panel's loading state.
    _setMemoryState('waiting');
    _memoryWaiting = true;
    if (!voiceEnabled()) {
      // Show inline loading dots so user knows reply is coming.
      _setMemoryPanel('waiting');
    }

    // Submit the turn. Reply arrives via the RTDB subscription →
    // renderMessages detects _memoryWaiting and routes accordingly.
    void submitChatTurn(transcript, { clearInput: false });
  };

  rec.onerror = (e) => {
    _stopMemoryListening();
    _setMemoryState('idle');
    if (e.error !== 'no-speech' && e.error !== 'aborted') {
      showToast(`Voice: ${e.error}`, 'error');
    }
  };

  rec.onend = () => {
    if (_memoryListeningFlag) {
      _stopMemoryListening();
      _setMemoryState('idle');
    }
  };

  _memoryRec = rec;
  rec.start();
  _memoryListeningFlag = true;
  _setMemoryState('listening');
}
