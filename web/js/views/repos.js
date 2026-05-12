// Repos view — browse all registered claude-kit repos.
// Two-column layout: repo list (left) + detail panel (right).

import { api } from '../api.js';

let selectedRepoId = null;
let allRepos = [];
let refreshTimer = null;

export function stopReposPolling() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  // Remove any modal overlay that was left open when the user navigated away.
  document.getElementById('repos-add-modal')?.remove();
  // Note: repos-active class removal is handled by the router's setView()
  // cleanup so other views always see a clean .main when they take over.
}

/* ------------------------------------------------------------------ */
/* Company color palette — deterministic from company name             */
/* ------------------------------------------------------------------ */

const COMPANY_COLORS = [
  { bg: 'rgba(91,155,213,.18)',  border: '#5b9bd5', text: '#5b9bd5' },   // blue
  { bg: 'rgba(155,127,212,.18)', border: '#9b7fd4', text: '#9b7fd4' },   // purple
  { bg: 'rgba(232,168,56,.18)',  border: '#e8a838', text: '#e8a838' },   // amber
  { bg: 'rgba(212,91,138,.18)',  border: '#d45b8a', text: '#d45b8a' },   // pink
  { bg: 'rgba(77,184,176,.18)',  border: '#4db8b0', text: '#4db8b0' },   // teal
  { bg: 'rgba(224,82,82,.18)',   border: '#e05252', text: '#e05252' },   // red
  { bg: 'rgba(124,183,118,.18)', border: '#7cb776', text: '#7cb776' },   // green
  { bg: 'rgba(201,200,74,.18)',  border: '#c9c84a', text: '#c9c84a' },   // yellow
];

function companyColor(company) {
  if (!company || company === '—') return null;
  let hash = 0;
  for (let i = 0; i < company.length; i++) hash = (hash * 31 + company.charCodeAt(i)) >>> 0;
  return COMPANY_COLORS[hash % COMPANY_COLORS.length];
}

/* ------------------------------------------------------------------ */
/* Main render                                                          */
/* ------------------------------------------------------------------ */

export async function renderReposView() {
  const main = document.querySelector('.main');
  // Add repos-active so the CSS collapses .main-header and makes
  // #drafts-list fill the full panel (matching home-v9-active pattern).
  main.classList.add('repos-active');

  // Write into #drafts-list (NOT main.innerHTML) so the element stays in
  // the DOM. Every other view uses getElementById('drafts-list') as its
  // render target and guards with `if (!list) return` — destroying it here
  // would make all subsequent view navigations silently bail and render nothing.
  const list = document.getElementById('drafts-list');
  list.innerHTML = `
    <div class="repos-layout">
      <div class="repos-sidebar" id="repos-sidebar">
        <div class="repos-sidebar-header">
          <div class="repos-title-row">
            <div class="repos-title">Repos</div>
            <button class="repos-briefing-btn" id="repos-briefing-btn" title="Briefing — all repos at a glance">⚡ Briefing</button>
          </div>
          <div class="repos-actions">
            <input class="repos-search-input" id="repos-search" type="text" placeholder="Search tasks…" autocomplete="off">
            <button class="repos-add-btn" id="repos-add-btn" title="Register repo">＋</button>
          </div>
        </div>
        <div id="repos-list">
          <div class="repos-loading">Loading…</div>
        </div>
      </div>
      <div class="repos-detail" id="repos-detail">
        <div class="repos-empty-state">
          <div class="repos-empty-icon">🗂</div>
          <div class="repos-empty-text">Select a repo to see its status</div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('repos-add-btn').addEventListener('click', showAddRepoModal);
  document.getElementById('repos-briefing-btn').addEventListener('click', () => {
    // Deselect any repo so the briefing stands alone.
    document.querySelectorAll('.repos-item').forEach((el) => {
      el.classList.remove('selected');
      el.removeAttribute('style');
    });
    selectedRepoId = null;
    loadBriefing();
  });

  let searchTimeout = null;
  document.getElementById('repos-search').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const q = e.target.value.trim();
    if (q.length < 2) { renderSidebar(allRepos); return; }
    searchTimeout = setTimeout(() => runTaskSearch(q), 300);
  });

  await loadRepos();
  stopReposPolling();
  refreshTimer = setInterval(async () => { await loadRepos(true); }, 5 * 60_000);
}

async function loadRepos(silent = false) {
  try {
    const data = await api('/api/repos');
    allRepos = data.repos ?? [];
    renderSidebar(allRepos);
    if (selectedRepoId) {
      const still = allRepos.find((r) => r.id === selectedRepoId);
      if (still) await loadRepoDetail(selectedRepoId, silent);
    }
  } catch (err) {
    if (!silent) {
      const errList = document.getElementById('repos-list');
      if (errList) errList.innerHTML =
        `<div class="repos-error">Failed to load repos: ${err.message}</div>`;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Sidebar                                                              */
/* ------------------------------------------------------------------ */

function renderSidebar(repos) {
  const list = document.getElementById('repos-list');
  if (!list) return;   // navigated away — don't overwrite the new view
  if (!repos.length) {
    list.innerHTML = `
      <div class="repos-empty-list">
        <div>No repos registered yet.</div>
        <div class="repos-hint">Click ＋ to add a claude-kit repo.</div>
      </div>
    `;
    return;
  }

  // Group by company
  const byCompany = {};
  for (const r of repos) {
    const co = r.company || '—';
    if (!byCompany[co]) byCompany[co] = [];
    byCompany[co].push(r);
  }

  let html = '';
  for (const [company, group] of Object.entries(byCompany)) {
    const color = companyColor(company);
    const labelStyle = color ? `style="color:${color.text}"` : '';
    const stripStyle = color ? `style="background:${color.border}"` : '';
    html += `
      <div class="repos-company-group">
        <div class="repos-company-strip" ${stripStyle}></div>
        <div class="repos-company-content">
          <div class="repos-company-label" ${labelStyle}>${escHtml(company)}</div>
    `;
    for (const r of group) {
      const isSelected = r.id === selectedRepoId;
      const isInactive = !r.active;
      const itemStyle = color && isSelected ? `style="border-left-color:${color.border};background:${color.bg}"` : '';
      html += `
        <div class="repos-item${isSelected ? ' selected' : ''}${isInactive ? ' inactive' : ''}"
             data-id="${r.id}" ${itemStyle}>
          <div class="repos-item-name">${escHtml(r.name)}</div>
          <div class="repos-item-meta">
            ${r.platform ? `<span class="repos-tag">${escHtml(r.platform)}</span>` : ''}
            ${r.branch ? `<span class="repos-tag repos-tag-branch">⎇ ${escHtml(r.branch)}</span>` : ''}
            ${isInactive ? '<span class="repos-tag dim">inactive</span>' : ''}
          </div>
        </div>
      `;
    }
    html += `</div></div>`;
  }
  list.innerHTML = html;

  list.querySelectorAll('.repos-item').forEach((el) => {
    el.addEventListener('click', () => {
      selectedRepoId = parseInt(el.dataset.id);
      list.querySelectorAll('.repos-item').forEach((e) => {
        e.classList.remove('selected');
        e.removeAttribute('style');
      });
      const repo = allRepos.find((r) => r.id === selectedRepoId);
      const color = companyColor(repo?.company);
      if (color) {
        el.style.borderLeftColor = color.border;
        el.style.background = color.bg;
      }
      el.classList.add('selected');
      loadRepoDetail(selectedRepoId);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Detail panel                                                         */
/* ------------------------------------------------------------------ */

async function loadRepoDetail(repoId, silent = false) {
  const detail = document.getElementById('repos-detail');
  if (!detail) return;
  if (!silent) detail.innerHTML = `<div class="repos-loading">Loading…</div>`;

  try {
    const data = await api(`/api/repos/${repoId}`);
    const { repo, phases, tasks, audit, current_branch } = data;
    const color = companyColor(repo.company);

    const activeTasks = tasks.filter((t) => t.state === 'active');
    const backlogTasks = tasks.filter((t) => t.state === 'backlog');
    const doneTasks = tasks.filter((t) => t.state === 'done');

    // Branch display: show configured branch (or actual current branch in parentheses)
    const branchDisplay = repo.branch
      ? `<span class="repo-branch-badge configured">⎇ ${escHtml(repo.branch)}</span>`
      : current_branch
        ? `<span class="repo-branch-badge current">⎇ ${escHtml(current_branch)}</span>`
        : '';

    const headerAccent = color ? `style="border-top: 3px solid ${color.border}"` : '';
    const companyBadgeStyle = color ? `style="background:${color.bg};color:${color.text};border-color:${color.border}"` : '';

    detail.innerHTML = `
      <div class="repo-detail-header" ${headerAccent}>

        <!-- Company badge + name row -->
        <div class="repo-header-top">
          ${repo.company ? `<span class="repo-company-badge" ${companyBadgeStyle}>${escHtml(repo.company)}</span>` : ''}
          ${branchDisplay}
          <div class="repo-header-actions-right">
            <button class="repo-btn repo-rename-btn" id="repo-rename-btn" title="Rename">✎</button>
            <button class="repo-btn repo-delete-btn" id="repo-delete-btn" title="Delete repo">🗑</button>
          </div>
        </div>

        <!-- Editable name -->
        <div class="repo-name-display" id="repo-name-display">
          <span class="repo-detail-title">${escHtml(repo.name)}</span>
        </div>
        <div class="repo-name-edit" id="repo-name-edit" style="display:none">
          <input class="repo-name-input" id="repo-name-input" type="text" value="${escHtml(repo.name)}">
          <button class="repo-btn primary" id="repo-name-save">Save</button>
          <button class="repo-btn" id="repo-name-cancel">Cancel</button>
        </div>

        <div class="repo-detail-path" title="${escHtml(repo.local_path)}">${escHtml(repo.local_path)}</div>
        ${repo.description ? `<div class="repo-detail-desc">${escHtml(repo.description)}</div>` : ''}

        <div class="repo-detail-toolbar">
          <button class="repo-btn" id="repo-refresh-btn">↻ Refresh</button>
          <button class="repo-btn${repo.active ? ' active' : ''}" id="repo-toggle-btn">
            ${repo.active ? '● Active' : '○ Inactive'}
          </button>
          <button class="repo-btn${repo.auto_pull ? ' active' : ''}" id="repo-autopull-btn"
                  title="Runs git pull before each extract. Requires SSH key access.">
            ${repo.auto_pull ? '⬇ Pull on' : '⬇ Pull off'}
          </button>
        </div>

        <div class="repo-branch-row">
          <span class="repo-branch-label">Monitor branch</span>
          <input class="repo-branch-input" id="repo-branch-input"
                 type="text" placeholder="current checkout"
                 value="${escHtml(repo.branch ?? '')}">
          <button class="repo-btn" id="repo-branch-save">Set</button>
          ${repo.branch ? `<button class="repo-btn" id="repo-branch-clear" title="Clear">✕</button>` : ''}
        </div>
      </div>

      <div class="repo-detail-body">
        <section class="repo-section">
          <div class="repo-section-title">Phases</div>
          <div class="repo-phases">
            ${phases.length ? phases.map(renderPhase).join('') : '<div class="repo-none">No phases</div>'}
          </div>
        </section>

        <section class="repo-section">
          <div class="repo-section-title">Active tasks <span class="repo-count">${activeTasks.length}</span></div>
          <div class="repo-tasks">
            ${activeTasks.length
              ? activeTasks.map((t) => renderTask(t)).join('')
              : '<div class="repo-none">No active tasks</div>'}
          </div>
        </section>

        <section class="repo-section">
          <div class="repo-section-title">
            Backlog <span class="repo-count">${backlogTasks.length}</span>
            <span class="repo-done-count">&nbsp;· ${doneTasks.length} done</span>
          </div>
          <div class="repo-tasks">
            ${backlogTasks.length
              ? backlogTasks.slice(0, 10).map((t) => renderTask(t)).join('')
                + (backlogTasks.length > 10 ? `<div class="repo-more">+${backlogTasks.length - 10} more</div>` : '')
              : '<div class="repo-none">Backlog is empty</div>'}
          </div>
        </section>

        <section class="repo-section">
          <div class="repo-section-title">Recent activity</div>
          <div class="repo-audit">
            ${audit.length ? audit.map(renderAuditEntry).join('') : '<div class="repo-none">No audit entries</div>'}
          </div>
        </section>
      </div>
    `;

    // --- Rename ---
    document.getElementById('repo-rename-btn').addEventListener('click', () => {
      document.getElementById('repo-name-display').style.display = 'none';
      document.getElementById('repo-name-edit').style.display = 'flex';
      document.getElementById('repo-name-input').focus();
      document.getElementById('repo-name-input').select();
    });
    document.getElementById('repo-name-cancel').addEventListener('click', () => {
      document.getElementById('repo-name-display').style.display = '';
      document.getElementById('repo-name-edit').style.display = 'none';
    });
    document.getElementById('repo-name-save').addEventListener('click', async () => {
      const name = document.getElementById('repo-name-input').value.trim();
      if (!name) return;
      try {
        await api(`/api/repos/${repoId}`, { method: 'PATCH', body: { name } });
        await loadRepos(true);
        await loadRepoDetail(repoId);
      } catch (err) { alert(`Failed: ${err.message}`); }
    });
    document.getElementById('repo-name-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('repo-name-save').click();
      if (e.key === 'Escape') document.getElementById('repo-name-cancel').click();
    });

    // --- Delete ---
    document.getElementById('repo-delete-btn').addEventListener('click', async () => {
      if (!confirm(`Delete "${repo.name}"?\n\nThis removes it from monitoring. The local files are not touched.`)) return;
      try {
        await api(`/api/repos/${repoId}`, { method: 'DELETE' });
        selectedRepoId = null;
        document.getElementById('repos-detail').innerHTML = `
          <div class="repos-empty-state">
            <div class="repos-empty-icon">🗂</div>
            <div class="repos-empty-text">Select a repo to see its status</div>
          </div>
        `;
        await loadRepos(true);
      } catch (err) { alert(`Failed: ${err.message}`); }
    });

    // --- Refresh ---
    document.getElementById('repo-refresh-btn').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = '↻ Refreshing…';
      try {
        await api(`/api/repos/${repoId}/refresh`, { method: 'POST' });
        await loadRepoDetail(repoId);
        await loadRepos(true);
      } catch (err) {
        btn.disabled = false; btn.textContent = '↻ Refresh';
        alert(`Refresh failed: ${err.message}`);
      }
    });

    // --- Active toggle ---
    document.getElementById('repo-toggle-btn').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        await api(`/api/repos/${repoId}`, { method: 'PATCH', body: { active: !repo.active } });
        await loadRepoDetail(repoId); await loadRepos(true);
      } catch (err) { e.currentTarget.disabled = false; alert(`Failed: ${err.message}`); }
    });

    // --- Auto-pull toggle ---
    document.getElementById('repo-autopull-btn').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        await api(`/api/repos/${repoId}`, { method: 'PATCH', body: { auto_pull: !repo.auto_pull } });
        await loadRepoDetail(repoId);
      } catch (err) { e.currentTarget.disabled = false; alert(`Failed: ${err.message}`); }
    });

    // --- Branch ---
    document.getElementById('repo-branch-save').addEventListener('click', async () => {
      const branch = document.getElementById('repo-branch-input').value.trim() || null;
      try {
        await api(`/api/repos/${repoId}`, { method: 'PATCH', body: { branch } });
        await loadRepoDetail(repoId);
      } catch (err) { alert(`Failed: ${err.message}`); }
    });
    document.getElementById('repo-branch-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('repo-branch-save').click();
    });
    document.getElementById('repo-branch-clear')?.addEventListener('click', async () => {
      try {
        await api(`/api/repos/${repoId}`, { method: 'PATCH', body: { branch: null } });
        await loadRepoDetail(repoId);
      } catch (err) { alert(`Failed: ${err.message}`); }
    });

  } catch (err) {
    detail.innerHTML = `<div class="repos-error">Failed to load repo: ${err.message}</div>`;
  }
}

/* ------------------------------------------------------------------ */
/* Row renderers                                                        */
/* ------------------------------------------------------------------ */

function renderPhase(p) {
  const statusEmoji = { queued: '📋', active: '🚧', shipped: '✅', unknown: '❓' }[p.status] ?? '❓';
  return `
    <div class="repo-phase repo-phase-${p.status}">
      <span class="repo-phase-emoji">${statusEmoji}</span>
      <span class="repo-phase-name">Phase ${p.phase_num} — ${escHtml(p.name)}</span>
      ${p.task_ids ? `<span class="repo-phase-tasks">${JSON.parse(p.task_ids).length} tasks</span>` : ''}
    </div>
  `;
}

function renderTask(t) {
  const days = t.mtime != null ? Math.floor((Date.now() - t.mtime) / 86400000) : null;
  const stale = days != null && days >= 10;
  return `
    <div class="repo-task${stale ? ' stale' : ''}">
      <span class="repo-task-id">${escHtml(t.task_id)}</span>
      <span class="repo-task-title">${escHtml(t.title ?? '(untitled)')}</span>
      ${t.is_stub ? '<span class="repo-stub">stub</span>' : ''}
      ${days != null ? `<span class="repo-task-age${stale ? ' stale' : ''}">${days}d</span>` : ''}
    </div>
  `;
}

function renderAuditEntry(e) {
  return `
    <div class="repo-audit-entry">
      <span class="repo-audit-date">${escHtml(e.entry_date)}</span>
      <span class="repo-audit-emoji">${escHtml(e.emoji)}</span>
      <span class="repo-audit-text">${escHtml(e.text)}</span>
    </div>
  `;
}

/* ------------------------------------------------------------------ */
/* Briefing                                                             */
/* ------------------------------------------------------------------ */

async function loadBriefing() {
  const detail = document.getElementById('repos-detail');
  if (!detail) return;
  detail.innerHTML = `<div class="repos-loading">Compiling briefing…</div>`;

  try {
    const b = await api('/api/repos/briefing');
    const genTime = new Date(b.generated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Group repos by company for company cards.
    const byCompany = {};
    for (const r of b.repos) {
      const co = r.repo.company || '—';
      if (!byCompany[co]) byCompany[co] = [];
      byCompany[co].push(r);
    }

    const phaseStatusEmoji = { queued: '📋', active: '🚧', shipped: '✅', unknown: '❓' };

    // Build company cards HTML.
    const companyCards = Object.entries(byCompany).map(([company, repoList]) => {
      const color = companyColor(company);
      const cardStyle = color
        ? `style="border-left: 3px solid ${color.border}; background: ${color.bg}"`
        : '';
      const coLabelStyle = color ? `style="color:${color.text}"` : '';

      const repoBlocks = repoList.map((r) => {
        const activePhases = r.phases.filter((p) => p.status === 'active');
        const shippedPhases = r.phases.filter((p) => p.status === 'shipped');
        const phasePills = r.phases.map((p) =>
          `<span class="brief-phase-pill brief-phase-${p.status}" title="Phase ${p.phase_num}: ${escHtml(p.name)}">${phaseStatusEmoji[p.status] ?? '❓'} ${escHtml(p.name)}</span>`
        ).join('');

        const taskRows = r.active_tasks.slice(0, 6).map((t) =>
          `<div class="brief-task${t.stale ? ' stale' : ''}">
            <span class="brief-task-id">${escHtml(t.task_id)}</span>
            <span class="brief-task-title">${escHtml(t.title ?? '')}</span>
            <span class="brief-task-age${t.stale ? ' stale' : ''}">${t.days != null ? t.days + 'd' : ''}</span>
          </div>`
        ).join('');

        const overflow = r.active_tasks.length > 6
          ? `<div class="brief-overflow">+${r.active_tasks.length - 6} more active</div>` : '';

        const recentAudit = r.audit.slice(0, 3).map((e) =>
          `<div class="brief-audit-row">
            <span class="brief-audit-emoji">${escHtml(e.emoji)}</span>
            <span class="brief-audit-date">${escHtml(e.date)}</span>
            <span class="brief-audit-text">${escHtml(e.text)}</span>
          </div>`
        ).join('');

        const branchBadge = r.repo.branch
          ? `<span class="brief-branch">⎇ ${escHtml(r.repo.branch)}</span>` : '';

        return `
          <div class="brief-repo-block">
            <div class="brief-repo-header">
              <span class="brief-repo-name">${escHtml(r.repo.name)}</span>
              ${branchBadge}
              <span class="brief-repo-stats">
                ${r.active_tasks.length} active · ${r.backlog_count} backlog · ${r.done_count} done
                ${r.stale_count > 0 ? `· <span class="brief-stale-count">⚠ ${r.stale_count} stale</span>` : ''}
              </span>
            </div>
            ${phasePills ? `<div class="brief-phases">${phasePills}</div>` : ''}
            ${r.active_tasks.length ? `<div class="brief-tasks">${taskRows}${overflow}</div>` : '<div class="brief-no-tasks">No active tasks</div>'}
            ${recentAudit ? `<div class="brief-audit">${recentAudit}</div>` : ''}
          </div>
        `;
      }).join('');

      const companyStale = repoList.reduce((s, r) => s + r.stale_count, 0);
      const companyActive = repoList.reduce((s, r) => s + r.active_tasks.length, 0);

      return `
        <div class="brief-company-card" ${cardStyle}>
          <div class="brief-company-header">
            <span class="brief-company-name" ${coLabelStyle}>${escHtml(company)}</span>
            <span class="brief-company-meta">${repoList.length} repo${repoList.length !== 1 ? 's' : ''} · ${companyActive} active tasks${companyStale > 0 ? ` · <span class="brief-stale-count">⚠ ${companyStale} stale</span>` : ''}</span>
          </div>
          ${repoBlocks}
        </div>
      `;
    }).join('');

    // Needs attention section (cross-repo stale tasks).
    const attentionSection = b.stale_tasks.length ? `
      <div class="brief-section">
        <div class="brief-section-title">⚠ Needs attention — stale active tasks</div>
        ${b.stale_tasks.map((t) => {
          const color = companyColor(t.company);
          const dotStyle = color ? `style="background:${color.border}"` : '';
          return `
            <div class="brief-stale-row">
              <span class="brief-stale-dot" ${dotStyle}></span>
              <span class="brief-task-id">${escHtml(t.task_id)}</span>
              <span class="brief-task-title">${escHtml(t.title ?? '')}</span>
              <span class="brief-stale-meta">${escHtml(t.repo_name)} · <strong>${t.days}d</strong></span>
            </div>
          `;
        }).join('')}
      </div>
    ` : '';

    // Recent activity feed (last 7 days across all repos).
    const activitySection = b.recent_audit.length ? `
      <div class="brief-section">
        <div class="brief-section-title">Recent activity — last 7 days</div>
        ${b.recent_audit.map((e) => {
          const color = companyColor(e.company);
          const dotStyle = color ? `style="background:${color.border}"` : '';
          return `
            <div class="brief-activity-row">
              <span class="brief-stale-dot" ${dotStyle}></span>
              <span class="brief-audit-emoji">${escHtml(e.emoji)}</span>
              <span class="brief-audit-date">${escHtml(e.date)}</span>
              <span class="brief-audit-text">${escHtml(e.text)}</span>
              <span class="brief-activity-repo">${escHtml(e.repo_name)}</span>
            </div>
          `;
        }).join('')}
      </div>
    ` : '';

    detail.innerHTML = `
      <div class="briefing-root">
        <div class="briefing-header">
          <div class="briefing-title">⚡ Briefing</div>
          <div class="briefing-meta">
            ${b.repo_count} repos · ${b.total_active} active tasks
            ${b.total_stale > 0 ? `· <span class="brief-stale-count">⚠ ${b.total_stale} stale</span>` : ''}
            <span class="briefing-time">as of ${genTime}</span>
          </div>
          <button class="repo-btn" id="briefing-refresh">↻ Refresh</button>
        </div>

        ${attentionSection}
        ${activitySection}

        <div class="brief-section">
          <div class="brief-section-title">All repos by company</div>
          ${companyCards}
        </div>
      </div>
    `;

    document.getElementById('briefing-refresh').addEventListener('click', loadBriefing);

  } catch (err) {
    detail.innerHTML = `<div class="repos-error">Briefing failed: ${err.message}</div>`;
  }
}

/* ------------------------------------------------------------------ */
/* Task search                                                          */
/* ------------------------------------------------------------------ */

async function runTaskSearch(q) {
  const list = document.getElementById('repos-list');
  try {
    const data = await api(`/api/repos/tasks/search?q=${encodeURIComponent(q)}`);
    const tasks = data.tasks ?? [];
    if (!tasks.length) {
      list.innerHTML = `<div class="repos-empty-list">No tasks match "${escHtml(q)}"</div>`;
      return;
    }
    const byRepo = {};
    for (const t of tasks) {
      const key = t.repo_name ?? 'Unknown';
      if (!byRepo[key]) byRepo[key] = [];
      byRepo[key].push(t);
    }
    let html = `<div class="repos-search-results-label">Results for "${escHtml(q)}"</div>`;
    for (const [repoName, group] of Object.entries(byRepo)) {
      html += `<div class="repos-company-label">${escHtml(repoName)}</div>`;
      for (const t of group) {
        const days = t.mtime != null ? Math.floor((Date.now() - t.mtime) / 86400000) : null;
        html += `
          <div class="repos-item repos-search-item">
            <div class="repos-item-name">${escHtml(t.task_id)} — ${escHtml(t.title ?? '')}</div>
            <div class="repos-item-meta">
              <span class="repos-tag repos-tag-state-${escHtml(t.state)}">${escHtml(t.state)}</span>
              ${days != null ? `<span class="repos-tag">${days}d</span>` : ''}
            </div>
          </div>
        `;
      }
    }
    list.innerHTML = html;
  } catch (err) {
    list.innerHTML = `<div class="repos-error">Search failed: ${err.message}</div>`;
  }
}

/* ------------------------------------------------------------------ */
/* Add repo modal                                                       */
/* ------------------------------------------------------------------ */

function showAddRepoModal() {
  const existing = document.getElementById('repos-add-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'repos-add-modal';
  modal.className = 'repos-modal-overlay';
  modal.innerHTML = `
    <div class="repos-modal">
      <div class="repos-modal-title">Register repo</div>
      <div class="repos-modal-field">
        <label>Path or GitHub URL</label>
        <input id="modal-path" type="text" placeholder="https://github.com/you/repo  or  ~/code/my-app" class="repos-modal-input">
      </div>
      <div class="repos-modal-field">
        <label>Company (optional)</label>
        <input id="modal-company" type="text" placeholder="Acme Corp" class="repos-modal-input">
      </div>
      <div class="repos-modal-error" id="modal-error" style="display:none"></div>
      <div class="repos-modal-actions">
        <button class="repo-btn" id="modal-cancel">Cancel</button>
        <button class="repo-btn primary" id="modal-submit">Register</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  document.getElementById('modal-path').focus();
  document.getElementById('modal-cancel').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  document.getElementById('modal-submit').addEventListener('click', async () => {
    const local_path = document.getElementById('modal-path').value.trim();
    const company = document.getElementById('modal-company').value.trim() || undefined;
    const errEl = document.getElementById('modal-error');
    const submitBtn = document.getElementById('modal-submit');
    if (!local_path) { errEl.style.display = ''; errEl.textContent = 'Path or URL is required'; return; }
    submitBtn.disabled = true; submitBtn.textContent = 'Registering…';
    errEl.style.display = 'none';
    try {
      await api('/api/repos', { method: 'POST', body: { local_path, company } });
      modal.remove();
      await loadRepos();
    } catch (err) {
      errEl.style.display = ''; errEl.textContent = err.message;
      submitBtn.disabled = false; submitBtn.textContent = 'Register';
    }
  });
}

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
