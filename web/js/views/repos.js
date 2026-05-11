// Repos view — browse all registered claude-kit repos.
// Two-column layout: repo list (left) + detail panel (right).
//
// Features:
//   - Register a new repo by local path
//   - Toggle active/inactive
//   - Force refresh (re-extract)
//   - Browse phases, active tasks, recent audit entries per repo
//   - Search tasks across all repos

import { api } from '../api.js';

let selectedRepoId = null;
let allRepos = [];
let refreshTimer = null;

export function stopReposPolling() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

export async function renderReposView() {
  const main = document.querySelector('.main');
  main.innerHTML = `
    <div class="repos-layout">
      <div class="repos-sidebar" id="repos-sidebar">
        <div class="repos-sidebar-header">
          <div class="repos-title">Repos</div>
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

  let searchTimeout = null;
  document.getElementById('repos-search').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const q = e.target.value.trim();
    if (q.length < 2) {
      renderSidebar(allRepos);
      return;
    }
    searchTimeout = setTimeout(() => runTaskSearch(q), 300);
  });

  await loadRepos();

  // Auto-refresh every 5 min (repos poll every 5 min server-side)
  stopReposPolling();
  refreshTimer = setInterval(async () => {
    await loadRepos(true);
  }, 5 * 60_000);
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
      document.getElementById('repos-list').innerHTML =
        `<div class="repos-error">Failed to load repos: ${err.message}</div>`;
    }
  }
}

function renderSidebar(repos) {
  const list = document.getElementById('repos-list');
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
    html += `<div class="repos-company-label">${escHtml(company)}</div>`;
    for (const r of group) {
      const isSelected = r.id === selectedRepoId;
      const isInactive = !r.active;
      const activeTasks = 0; // filled in detail
      html += `
        <div class="repos-item${isSelected ? ' selected' : ''}${isInactive ? ' inactive' : ''}"
             data-id="${r.id}">
          <div class="repos-item-name">${escHtml(r.name)}</div>
          <div class="repos-item-meta">
            ${r.platform ? `<span class="repos-tag">${escHtml(r.platform)}</span>` : ''}
            ${isInactive ? '<span class="repos-tag dim">inactive</span>' : ''}
          </div>
        </div>
      `;
    }
  }
  list.innerHTML = html;

  list.querySelectorAll('.repos-item').forEach((el) => {
    el.addEventListener('click', () => {
      selectedRepoId = parseInt(el.dataset.id);
      list.querySelectorAll('.repos-item').forEach((e) => e.classList.remove('selected'));
      el.classList.add('selected');
      loadRepoDetail(selectedRepoId);
    });
  });
}

async function loadRepoDetail(repoId, silent = false) {
  const detail = document.getElementById('repos-detail');
  if (!detail) return;
  if (!silent) {
    detail.innerHTML = `<div class="repos-loading">Loading…</div>`;
  }

  try {
    const data = await api(`/api/repos/${repoId}`);
    const { repo, phases, tasks, audit } = data;

    const activeTasks = tasks.filter((t) => t.state === 'active');
    const backlogTasks = tasks.filter((t) => t.state === 'backlog');
    const doneTasks = tasks.filter((t) => t.state === 'done');

    detail.innerHTML = `
      <div class="repo-detail-header">
        <div class="repo-detail-title">${escHtml(repo.name)}</div>
        <div class="repo-detail-path" title="${escHtml(repo.local_path)}">${escHtml(repo.local_path)}</div>
        ${repo.description ? `<div class="repo-detail-desc">${escHtml(repo.description)}</div>` : ''}
        <div class="repo-detail-toolbar">
          <button class="repo-btn" id="repo-refresh-btn">↻ Refresh</button>
          <button class="repo-btn${repo.active ? ' active' : ''}" id="repo-toggle-btn">
            ${repo.active ? '● Active' : '○ Inactive'}
          </button>
          <button class="repo-btn${repo.auto_pull ? ' active' : ''}" id="repo-autopull-btn"
                  title="When on, the watcher runs git pull before each extract so snapshots track remote HEAD (requires SSH key access)">
            ${repo.auto_pull ? '⬇ Auto-pull on' : '⬇ Auto-pull off'}
          </button>
        </div>
      </div>

      <div class="repo-detail-body">
        <!-- Phases -->
        <section class="repo-section">
          <div class="repo-section-title">Phases</div>
          <div class="repo-phases">
            ${phases.length ? phases.map(renderPhase).join('') : '<div class="repo-none">No phases</div>'}
          </div>
        </section>

        <!-- Active tasks -->
        <section class="repo-section">
          <div class="repo-section-title">Active tasks <span class="repo-count">${activeTasks.length}</span></div>
          <div class="repo-tasks">
            ${activeTasks.length
              ? activeTasks.map((t) => renderTask(t)).join('')
              : '<div class="repo-none">No active tasks</div>'}
          </div>
        </section>

        <!-- Backlog summary -->
        <section class="repo-section">
          <div class="repo-section-title">Backlog <span class="repo-count">${backlogTasks.length}</span>
            <span class="repo-done-count">&nbsp;· ${doneTasks.length} done</span>
          </div>
          <div class="repo-tasks">
            ${backlogTasks.length
              ? backlogTasks.slice(0, 10).map((t) => renderTask(t)).join('')
                + (backlogTasks.length > 10 ? `<div class="repo-more">+${backlogTasks.length - 10} more in backlog</div>` : '')
              : '<div class="repo-none">Backlog is empty</div>'}
          </div>
        </section>

        <!-- Audit log -->
        <section class="repo-section">
          <div class="repo-section-title">Recent activity</div>
          <div class="repo-audit">
            ${audit.length ? audit.map(renderAuditEntry).join('') : '<div class="repo-none">No audit entries</div>'}
          </div>
        </section>
      </div>
    `;

    document.getElementById('repo-refresh-btn').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = '↻ Refreshing…';
      try {
        await api(`/api/repos/${repoId}/refresh`, { method: 'POST' });
        await loadRepoDetail(repoId);
        await loadRepos(true);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = '↻ Refresh';
        alert(`Refresh failed: ${err.message}`);
      }
    });

    document.getElementById('repo-toggle-btn').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await api(`/api/repos/${repoId}`, {
          method: 'PATCH',
          body: { active: !repo.active },
        });
        await loadRepoDetail(repoId);
        await loadRepos(true);
      } catch (err) {
        btn.disabled = false;
        alert(`Failed: ${err.message}`);
      }
    });

    document.getElementById('repo-autopull-btn').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await api(`/api/repos/${repoId}`, {
          method: 'PATCH',
          body: { auto_pull: !repo.auto_pull },
        });
        await loadRepoDetail(repoId);
      } catch (err) {
        btn.disabled = false;
        alert(`Failed: ${err.message}`);
      }
    });

  } catch (err) {
    detail.innerHTML = `<div class="repos-error">Failed to load repo: ${err.message}</div>`;
  }
}

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
          <div class="repos-item repos-search-item" data-state="${escHtml(t.state)}">
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
        <label>Local path</label>
        <input id="modal-path" type="text" placeholder="/Users/you/code/my-app" class="repos-modal-input">
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

    if (!local_path) { errEl.style.display = ''; errEl.textContent = 'Path is required'; return; }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Registering…';
    errEl.style.display = 'none';

    try {
      await api('/repos', {
        method: 'POST',
        body: { local_path, company },
      });
      modal.remove();
      await loadRepos();
    } catch (err) {
      errEl.style.display = '';
      errEl.textContent = err.message;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Register';
    }
  });
}

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
