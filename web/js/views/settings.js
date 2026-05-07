// Settings — read-only system status: chat.db, app.db, OpenAI reachability,
// watcher, server. Everything Galt-specific (API key, model, AI context,
// voice profile, prompts) moved to #/galt — that's about the AI persona,
// this page is about infrastructure.
//
// `refreshSettings` (the helper that pulls /api/settings into state cache)
// now lives in views/galt.js since Galt is the primary consumer; main.js
// imports it from there.

import { api } from '../api.js';
import { setMainHeader } from '../shell.js';
import { escapeHtml } from '../utils.js';

export async function renderSettingsView() {
  setMainHeader({
    title: 'Settings',
    subHTML: '<span class="accent">system status</span> · chat.db, app.db, OpenAI, watcher, server · Galt config lives on <a href="#/galt">#/galt</a>',
  });
  const list = document.getElementById('drafts-list');
  if (!list) return;

  const health = await api('/api/health').catch(() => null);

  const fmtBool = (b, okLabel, warnLabel) =>
    b
      ? `<span class="ok">✓ ${escapeHtml(okLabel)}</span>`
      : `<span class="warn">✗ ${escapeHtml(warnLabel)}</span>`;

  const sysRows = !health
    ? '<div class="empty-row">/api/health unreachable</div>'
    : `
      <div class="settings-row">
        <label class="field-label">chat.db<span class="desc">read-only access to Apple's Messages database</span></label>
        <div class="field-readonly">${escapeHtml(health.chat_db?.path || '')} · ${fmtBool(health.chat_db?.ok, 'readable', health.chat_db?.error || 'not readable')}</div>
      </div>
      <div class="settings-row">
        <label class="field-label">app.db<span class="desc">project-owned SQLite for drafts, watched, rules, settings</span></label>
        <div class="field-readonly">${escapeHtml(health.app_db?.path || '')}</div>
      </div>
      <div class="settings-row">
        <label class="field-label">OpenAI<span class="desc">required for /api/ai/* endpoints · key + model managed on <a href="#/galt">#/galt</a></span></label>
        <div class="field-readonly">model: ${escapeHtml(health.openai_model || '?')} · ${fmtBool(health.openai_configured, 'key configured', 'OPENAI_API_KEY not set')}</div>
      </div>
      <div class="settings-row">
        <label class="field-label">Watcher<span class="desc">fs.watch on chat.db-wal, idle until Phase 2</span></label>
        <div class="field-readonly">${health.watcher_running ? '<span class="ok">✓ running</span>' : '<span class="warn">⚠ not running</span>'}</div>
      </div>
      <div class="settings-row">
        <label class="field-label">Server<span class="desc">version + uptime</span></label>
        <div class="field-readonly">${escapeHtml(health.server || 'galt')} v${escapeHtml(health.version || '?')}</div>
      </div>
    `;

  list.innerHTML = `
    <div class="settings-section">
      <h3>System</h3>
      ${sysRows}
    </div>
  `;
}
