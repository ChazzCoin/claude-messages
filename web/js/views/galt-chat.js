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
const _taskPolls = new Map();  // task_id → { intervalId, eventsSinceId }

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
  ensureTaskPolls();
  scrollToBottom();
}

/** Walk all .galt-chat-task elements; start a polling loop for any
 *  not already being polled. Each loop hits /api/tasks/:id every
 *  2s, fetches the row + new events (since_id cursor), updates DOM.
 *  Idempotent. Polls stop once the task hits a terminal state. */
function ensureTaskPolls() {
  const cards = document.querySelectorAll('.galt-chat-task[data-task-id]');
  for (const card of cards) {
    const id = card.dataset.taskId;
    if (!id || _taskPolls.has(id)) continue;
    startTaskPoll(id);
  }
}

function startTaskPoll(taskId) {
  let sinceId = 0;
  let lastStatus = '';
  const tick = async () => {
    try {
      const { task, events } = await api(`/api/tasks/${taskId}?since_id=${sinceId}`);
      if (!task) return;
      updateTaskCard(taskId, task);
      for (const ev of (events || [])) {
        appendTaskEventLine(taskId, ev);
        if (ev.id > sinceId) sinceId = ev.id;
      }
      lastStatus = task.status;
      if (lastStatus === 'succeeded' || lastStatus === 'failed' || lastStatus === 'cancelled') {
        const entry = _taskPolls.get(taskId);
        if (entry) { clearInterval(entry.intervalId); _taskPolls.delete(taskId); }
      }
    } catch {
      // 404 → task gone, just stop polling. Network blip → wait for
      // the next tick.
    }
  };
  // Fire once immediately, then every 2s.
  void tick();
  const intervalId = setInterval(tick, 2_000);
  _taskPolls.set(taskId, { intervalId, eventsSinceId: 0 });
}

function updateTaskCard(taskId, task) {
  const card = document.querySelector(`.galt-chat-task[data-task-id="${cssEsc(taskId)}"]`);
  if (!card) return;
  card.dataset.status = task.status || 'queued';
  const statusEl = card.querySelector(`[data-id="galt-task-status-${cssEsc(taskId)}"]`);
  if (statusEl) statusEl.textContent = task.status;
  const msgEl = card.querySelector(`[data-id="galt-task-message-${cssEsc(taskId)}"]`);
  if (msgEl) {
    if (task.status === 'succeeded' && task.result) msgEl.textContent = task.result;
    else if (task.status === 'failed') msgEl.textContent = task.error || task.result || 'failed';
    else if (task.status === 'cancelled') msgEl.textContent = 'cancelled';
    else msgEl.textContent = '';
  }
  const metaEl = card.querySelector(`[data-id="galt-task-meta-${cssEsc(taskId)}"]`);
  if (metaEl) {
    const parts = [];
    if (task.model)          parts.push(escapeHtml(task.model));
    if (task.num_turns != null) parts.push(`${task.num_turns} round${task.num_turns === 1 ? '' : 's'}`);
    if (task.total_cost_usd != null && task.total_cost_usd > 0) parts.push(`$${task.total_cost_usd.toFixed(3)}`);
    if (task.started_at && task.finished_at) {
      parts.push(`${Math.round((task.finished_at - task.started_at) / 1000)}s`);
    }
    metaEl.innerHTML = parts.join(' · ');
  }
  const cancelBtn = card.querySelector('.galt-chat-task-cancel');
  if (cancelBtn) {
    const terminal = ['succeeded','failed','cancelled'].includes(task.status);
    if (terminal) cancelBtn.style.display = 'none';
  }
}

function appendTaskEventLine(taskId, ev) {
  const root = document.querySelector(`[data-id="galt-task-events-${cssEsc(taskId)}"]`);
  if (!root) return;
  const html = renderTaskEventLine(ev);
  if (html) root.insertAdjacentHTML('beforeend', html);
}

function renderTaskEventLine(ev) {
  if (!ev || !ev.kind) return '';
  const data = ev.data || {};
  if (ev.kind === 'tool_use') {
    return `
      <div class="galt-chat-task-event">
        <span class="galt-chat-task-event-icon">⏵</span>
        <span class="galt-chat-task-event-tool">${escapeHtml(data.tool || '?')}</span>
        ${data.input_preview ? `<span class="galt-chat-task-event-arg">${escapeHtml(data.input_preview)}</span>` : ''}
      </div>`;
  }
  if (ev.kind === 'tool_result') {
    if (!data.preview) return '';
    const errCls = data.is_error ? ' err' : '';
    const head = (data.preview || '').split('\n')[0].slice(0, 80);
    return `
      <details class="galt-chat-task-event tool-result${errCls}">
        <summary>
          <span class="galt-chat-task-event-icon">↵</span>
          <span class="galt-chat-task-event-arg">${escapeHtml(head)}</span>
        </summary>
        <pre class="galt-chat-task-event-body">${escapeHtml(data.preview || '')}</pre>
      </details>`;
  }
  if (ev.kind === 'message') {
    if (!data.text) return '';
    return `<div class="galt-chat-task-event message">${escapeHtml(data.text)}</div>`;
  }
  if (ev.kind === 'init') {
    return `<div class="galt-chat-task-event init">started ${data.model ? '(' + escapeHtml(data.model) + ')' : ''}</div>`;
  }
  return '';
}

function cssEsc(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}

// Tool names that get dedicated card rendering (excluded from generic tool strip).
const REPO_WRITE_TOOLS = new Set(['write_task', 'move_task', 'git_commit_push']);
const REPO_READ_TOOLS  = new Set(['list_repos', 'repo_status', 'search_tasks', 'active_tasks_all']);

function renderBubble(m) {
  const cls = m.role === 'user' ? 'me' : 'galt';
  const meta = m.role === 'galt' && m.model
    ? `<div class="galt-chat-bubble-meta">${escapeHtml(m.model)}${m.ts ? ' · ' + escapeHtml(relTime(m.ts)) : ''}${m.rounds ? ' · ' + m.rounds + ' round' + (m.rounds === 1 ? '' : 's') : ''}</div>`
    : '';
  // Dedicated card flavors — each handles its own tool name set.
  const proposals   = renderProposalCards(m.tool_calls);
  const approvals   = renderApprovalCards(m.tool_calls);
  const events      = renderEventListCards(m.tool_calls);
  const claudeTasks = renderTaskCards(m.tool_calls);
  const repoReads   = renderRepoReadCards(m.tool_calls);
  const repoWrites  = renderRepoWriteCards(m.tool_calls);

  // Everything else collapses into the generic pill strip.
  const readCalls = Array.isArray(m.tool_calls)
    ? m.tool_calls.filter((tc) =>
        !tc.name?.startsWith('propose_') &&
        tc.name !== 'request_user_approval' &&
        tc.name !== 'list_calendar_events' &&
        tc.name !== 'claude_ask' &&
        !REPO_WRITE_TOOLS.has(tc.name) &&
        !REPO_READ_TOOLS.has(tc.name))
    : [];
  const tools = readCalls.length > 0 ? renderToolStrip(readCalls) : '';
  return `
    <div class="galt-chat-row ${cls}">
      ${tools}
      ${repoReads}
      ${repoWrites}
      ${events}
      ${proposals}
      ${approvals}
      ${claudeTasks}
      <div class="galt-chat-bubble">${escapeHtml(m.text)}</div>
      ${meta}
    </div>
  `;
}

/* ============================================================
   Repo read cards — list_repos / repo_status / search_tasks / active_tasks_all
   ============================================================ */

function renderRepoReadCards(toolCalls) {
  if (!Array.isArray(toolCalls)) return '';
  return toolCalls
    .map((tc) => {
      if (tc.name === 'list_repos')       return renderListReposCard(tc);
      if (tc.name === 'repo_status')      return renderRepoStatusCard(tc);
      if (tc.name === 'search_tasks')     return renderTaskListCard(tc, 'search');
      if (tc.name === 'active_tasks_all') return renderTaskListCard(tc, 'all-active');
      return '';
    })
    .filter(Boolean)
    .join('');
}

function renderListReposCard(tc) {
  let repos;
  try { repos = JSON.parse(tc.result_preview || '[]'); } catch { return ''; }
  if (!Array.isArray(repos) || repos.length === 0) return '';
  const rows = repos.map((r) => {
    const count = typeof r.active_task_count === 'number' ? r.active_task_count : '?';
    const countCls = count > 0 ? 'repo-card-task-count active' : 'repo-card-task-count';
    const co = r.company ? `<span class="repo-card-company">${escapeHtml(r.company)}</span>` : '';
    return `
      <div class="repo-card-row">
        <span class="repo-card-name">${escapeHtml(r.name || `#${r.id}`)}</span>
        ${co}
        <span class="${countCls}">${count} active</span>
      </div>`;
  }).join('');
  return `
    <div class="galt-repo-card">
      <div class="galt-repo-card-head">
        <span class="repo-card-kind">Repos</span>
        <span class="repo-card-meta">${repos.length} tracked</span>
      </div>
      <div class="repo-card-rows">${rows}</div>
    </div>`;
}

function renderRepoStatusCard(tc) {
  let r;
  try { r = JSON.parse(tc.result_preview || '{}'); } catch { return ''; }
  if (!r || typeof r !== 'object') return '';

  const name = r.repo_name || 'Repo';
  const co   = r.repo_company ? ` · ${r.repo_company}` : '';

  // Phases strip.
  const phases = Array.isArray(r.phases) ? r.phases : [];
  const phaseHtml = phases.map((p) => {
    const dot = p.status === 'shipped' ? '●' : p.status === 'active' ? '◉' : '○';
    const cls = `repo-phase-dot ${p.status || 'queued'}`;
    const label = escapeHtml(p.name || `Phase ${p.phase_num}`);
    const count = typeof p.task_count === 'number' ? ` (${p.task_count})` : '';
    return `<span class="${cls}">${dot}</span><span class="repo-phase-name">${label}${count}</span>`;
  }).join('<span class="repo-phase-sep">→</span>');

  // Active tasks table.
  const active = Array.isArray(r.active_tasks) ? r.active_tasks : [];
  const taskRows = active.slice(0, 8).map((t) => {
    const age = typeof t.days_since_update === 'number'
      ? `<span class="repo-task-age${t.days_since_update >= 10 ? ' stale' : ''}">${t.days_since_update}d</span>`
      : '';
    return `
      <div class="repo-task-row">
        <span class="repo-task-id">${escapeHtml(t.task_id || '')}</span>
        <span class="repo-task-title">${escapeHtml(t.title || '—')}</span>
        ${age}
      </div>`;
  }).join('');
  const moreStr = active.length > 8
    ? `<div class="repo-task-more">+${active.length - 8} more active</div>` : '';
  const backlog = typeof r.backlog_count === 'number' && r.backlog_count > 0
    ? `<div class="repo-task-more">${r.backlog_count} in backlog</div>` : '';

  return `
    <div class="galt-repo-card">
      <div class="galt-repo-card-head">
        <span class="repo-card-kind">${escapeHtml(name)}${escapeHtml(co)}</span>
        <span class="repo-card-meta">${active.length} active</span>
      </div>
      ${phases.length ? `<div class="repo-phase-strip">${phaseHtml}</div>` : ''}
      ${active.length ? `<div class="repo-task-list">${taskRows}${moreStr}</div>` : ''}
      ${backlog}
    </div>`;
}

function renderTaskListCard(tc, kind) {
  let tasks;
  try { tasks = JSON.parse(tc.result_preview || '[]'); } catch { return ''; }
  if (!Array.isArray(tasks)) return ''; // empty array is fine — still render zero state

  const label = kind === 'search'
    ? `Tasks · "${tc.arguments?.query || '…'}"`
    : 'Active tasks · all repos';

  if (tasks.length === 0) {
    return `
      <div class="galt-repo-card">
        <div class="galt-repo-card-head">
          <span class="repo-card-kind">${escapeHtml(label)}</span>
          <span class="repo-card-meta">0 results</span>
        </div>
        <div class="repo-task-more">nothing found</div>
      </div>`;
  }

  const rows = tasks.slice(0, 12).map((t) => {
    const state = t.state || 'backlog';
    const age = typeof t.days_since_update === 'number'
      ? `<span class="repo-task-age${t.days_since_update >= 10 ? ' stale' : ''}">${t.days_since_update}d</span>`
      : '';
    const repo = t.repo_name
      ? `<span class="repo-task-repo">${escapeHtml(t.repo_name)}</span>` : '';
    return `
      <div class="repo-task-row">
        ${taskStateBadge(state)}
        <span class="repo-task-id">${escapeHtml(t.task_id || '')}</span>
        <span class="repo-task-title">${escapeHtml(t.title || '—')}</span>
        ${repo}${age}
      </div>`;
  }).join('');
  const more = tasks.length > 12
    ? `<div class="repo-task-more">+${tasks.length - 12} more</div>` : '';

  return `
    <div class="galt-repo-card">
      <div class="galt-repo-card-head">
        <span class="repo-card-kind">${escapeHtml(label)}</span>
        <span class="repo-card-meta">${tasks.length} result${tasks.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="repo-task-list">${rows}${more}</div>
    </div>`;
}

/* ============================================================
   Repo write cards — write_task / move_task / git_commit_push
   ============================================================ */

function renderRepoWriteCards(toolCalls) {
  if (!Array.isArray(toolCalls)) return '';
  return toolCalls
    .map((tc) => {
      if (tc.name === 'write_task')       return renderWriteTaskCard(tc);
      if (tc.name === 'move_task')        return renderMoveTaskCard(tc);
      if (tc.name === 'git_commit_push')  return renderGitPushCard(tc);
      return '';
    })
    .filter(Boolean)
    .join('');
}

function renderWriteTaskCard(tc) {
  let r;
  try { r = JSON.parse(tc.result_preview || '{}'); } catch { return ''; }
  if (!r || !r.task_id) return '';

  // Show path relative to tasks/ for brevity.
  const filePath = (r.file_path || '').replace(/^.*\/tasks\//, 'tasks/');
  const verb = r.is_new ? 'Created' : 'Updated';
  const state = r.state || 'backlog';

  return `
    <div class="galt-repo-write-card">
      <div class="galt-repo-card-head">
        <span class="repo-card-kind repo-write-kind">Task ${verb}</span>
        ${taskStateBadge(state)}
      </div>
      <div class="repo-write-task-id">${escapeHtml(r.task_id)}</div>
      <div class="repo-write-task-title">${escapeHtml(r.title || '—')}</div>
      ${filePath ? `<div class="repo-write-path">${escapeHtml(filePath)}</div>` : ''}
    </div>`;
}

function renderMoveTaskCard(tc) {
  let r;
  try { r = JSON.parse(tc.result_preview || '{}'); } catch { return ''; }
  if (!r || !r.task_id) return '';
  const newState = r.new_state || '';

  return `
    <div class="galt-repo-write-card">
      <div class="galt-repo-card-head">
        <span class="repo-card-kind repo-write-kind">Task Moved</span>
        ${taskStateBadge(newState)}
      </div>
      <div class="repo-write-task-id">${escapeHtml(r.task_id)}</div>
      <div class="repo-write-task-title repo-write-meta">→ ${escapeHtml(newState)}</div>
    </div>`;
}

function renderGitPushCard(tc) {
  let r;
  try { r = JSON.parse(tc.result_preview || '{}'); } catch { return ''; }
  if (r == null) return '';

  const hasError = !!tc.error;
  if (hasError) {
    return `
      <div class="galt-repo-write-card git-error">
        <div class="galt-repo-card-head">
          <span class="repo-card-kind repo-write-kind">Git Push</span>
          <span class="repo-git-status err">✗ failed</span>
        </div>
        <div class="repo-write-path err">${escapeHtml(tc.error || 'unknown error')}</div>
      </div>`;
  }
  if (r.committed === false) {
    return `
      <div class="galt-repo-write-card">
        <div class="galt-repo-card-head">
          <span class="repo-card-kind repo-write-kind">Git</span>
          <span class="repo-git-status muted">nothing to commit</span>
        </div>
      </div>`;
  }
  // Get commit message from args if available.
  const msg = tc.arguments?.message || '';
  return `
    <div class="galt-repo-write-card git-ok">
      <div class="galt-repo-card-head">
        <span class="repo-card-kind repo-write-kind">Git Pushed</span>
        <span class="repo-git-status ok">↑ pushed</span>
      </div>
      ${msg ? `<div class="repo-write-task-title">${escapeHtml(msg)}</div>` : ''}
    </div>`;
}

/* -- shared helpers -- */

function taskStateBadge(state) {
  const labels = { backlog: 'backlog', active: 'active', done: 'done' };
  const label = labels[state] || state;
  return `<span class="repo-state-badge ${state}">${escapeHtml(label)}</span>`;
}

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
  return `
    <div class="galt-chat-task" data-task-id="${escapeHtml(r.task_id)}" data-status="queued">
      <div class="galt-chat-task-head">
        <span class="galt-chat-task-kind">⚡ Claude</span>
        <span class="galt-chat-task-status" data-id="galt-task-status-${escapeHtml(r.task_id)}">queued</span>
      </div>
      <div class="galt-chat-task-events" data-id="galt-task-events-${escapeHtml(r.task_id)}"></div>
      <div class="galt-chat-task-message" data-id="galt-task-message-${escapeHtml(r.task_id)}"></div>
      <div class="galt-chat-task-foot">
        <div class="galt-chat-task-meta" data-id="galt-task-meta-${escapeHtml(r.task_id)}"></div>
        <button class="galt-chat-proposal-btn dismiss galt-chat-task-cancel" data-action="task-cancel" data-task-id="${escapeHtml(r.task_id)}">Cancel</button>
      </div>
    </div>
  `;
}

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
  const start = ev.start_iso ? fmtProposalTime(ev.start_iso) : '— no time —';
  const end = ev.end_iso ? fmtProposalTime(ev.end_iso) : null;
  const when = end ? `${start} → ${end.split(' · ')[1] || end}` : start;
  return `
    <div class="galt-chat-event">
      <div class="galt-chat-proposal-head">
        <span class="galt-chat-proposal-kind muted">Calendar event</span>
        ${ev.calendar ? `<span class="galt-chat-event-cal">${escapeHtml(ev.calendar)}</span>` : ''}
      </div>
      <div class="galt-chat-proposal-title">${escapeHtml(ev.title)}</div>
      <div class="galt-chat-proposal-when">${escapeHtml(when)}</div>
      ${ev.location ? `<div class="galt-chat-proposal-meta">📍 ${escapeHtml(ev.location)}</div>` : ''}
      ${ev.notes ? `<div class="galt-chat-proposal-notes">${escapeHtml(ev.notes)}</div>` : ''}
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

  // Persisted decision (localStorage) — survives re-renders so a
  // polling tick after the user clicks doesn't reset the card.
  const decided = approvalDecisionFromStore(fingerprint);
  const disabled = decided !== null;
  const status = decided ?? 'awaiting';

  const buttons = disabled
    ? `
      <div class="galt-chat-proposal-actions">
        <button class="galt-chat-proposal-btn dismiss" disabled>${escapeHtml(denyLabel)}</button>
        <button class="galt-chat-proposal-btn approve" disabled>${escapeHtml(approveLabel)}</button>
      </div>`
    : `
      <div class="galt-chat-proposal-actions">
        <button class="galt-chat-proposal-btn dismiss" data-action="approval-deny" data-approval-fp="${fingerprint}" data-label="${escapeHtml(denyLabel)}">${escapeHtml(denyLabel)}</button>
        <button class="galt-chat-proposal-btn approve" data-action="approval-approve" data-approval-fp="${fingerprint}" data-label="${escapeHtml(approveLabel)}">${escapeHtml(approveLabel)}</button>
      </div>`;

  return `
    <div class="galt-chat-approval" data-approval-fp="${fingerprint}" data-status="${escapeHtml(status)}">
      <div class="galt-chat-proposal-head">
        <span class="galt-chat-proposal-kind">Decision</span>
        <span class="galt-chat-proposal-status" data-id="galt-approval-status-${fingerprint}">${escapeHtml(status)}</span>
      </div>
      <div class="galt-chat-approval-question">${escapeHtml(r.question)}</div>
      ${r.context ? `<div class="galt-chat-approval-context">${escapeHtml(r.context)}</div>` : ''}
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

function recordApprovalDecisionLocal(fingerprint, status) {
  try {
    const raw = localStorage.getItem(APPROVAL_DECISIONS_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[fingerprint] = status;
    const keys = Object.keys(map);
    if (keys.length > 200) {
      for (const k of keys.slice(0, keys.length - 200)) delete map[k];
    }
    localStorage.setItem(APPROVAL_DECISIONS_KEY, JSON.stringify(map));
  } catch { /* storage full/disabled */ }
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

  // Final decision sticks across re-renders — backend stamps
  // decision_status onto the tool_calls entry when the proposal is
  // exported/dismissed.
  const decided = tc.decision_status;
  const status = decided === 'exported' ? 'approved'
              : decided === 'dismissed' ? 'denied'
              : 'pending';
  const disabled = status !== 'pending';

  const picker = disabled ? '' : renderCalendarPicker(id);
  const buttons = disabled
    ? `
      <div class="galt-chat-proposal-actions">
        <button class="galt-chat-proposal-btn dismiss" disabled>${escapeHtml(decided === 'dismissed' ? 'Denied' : 'Deny')}</button>
        <button class="galt-chat-proposal-btn approve" disabled>${escapeHtml(decided === 'exported' ? 'Approved' : 'Approve')}</button>
      </div>`
    : `
      <div class="galt-chat-proposal-actions">
        <button class="galt-chat-proposal-btn dismiss" data-action="proposal-dismiss" data-proposal-id="${escapeHtml(id)}">Deny</button>
        <button class="galt-chat-proposal-btn approve" data-action="proposal-approve" data-proposal-id="${escapeHtml(id)}">Approve &amp; add to Calendar</button>
      </div>`;

  return `
    <div class="galt-chat-proposal" data-proposal-id="${escapeHtml(id)}" data-status="${escapeHtml(status)}">
      <div class="galt-chat-proposal-head">
        <span class="galt-chat-proposal-kind">Calendar event</span>
        <span class="galt-chat-proposal-status" data-id="galt-proposal-status-${escapeHtml(id)}">${escapeHtml(status)}</span>
      </div>
      <div class="galt-chat-proposal-title">${escapeHtml(r.title || 'Untitled')}</div>
      <div class="galt-chat-proposal-when">${escapeHtml(when)}</div>
      ${r.location ? `<div class="galt-chat-proposal-meta">📍 ${escapeHtml(r.location)}</div>` : ''}
      ${r.participants ? `<div class="galt-chat-proposal-meta">👥 ${escapeHtml(r.participants)}</div>` : ''}
      ${r.notes ? `<div class="galt-chat-proposal-notes">${escapeHtml(r.notes)}</div>` : ''}
      ${picker}
      ${buttons}
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
    if (action === 'task-cancel') {
      const taskId = btn.dataset.taskId;
      if (!taskId) return;
      btn.setAttribute('disabled', 'true');
      btn.textContent = 'Cancelling…';
      try {
        await api(`/api/tasks/${taskId}/cancel`, { method: 'POST', body: {} });
      } catch (err) {
        btn.removeAttribute('disabled');
        btn.textContent = 'Cancel';
        alert('cancel failed: ' + (err.message || 'unknown'));
      }
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
  const fp = btn.dataset.approvalFp;
  const newStatus = action === 'approval-approve' ? 'approved' : 'denied';
  // Persist locally so the card stays decided across re-renders
  // (polling ticks would otherwise reset it to 'awaiting').
  if (fp) recordApprovalDecisionLocal(fp, newStatus);
  setApprovalStatus(card, newStatus);
  try {
    const input = document.getElementById('galt-chat-input');
    if (input) input.value = label;
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
