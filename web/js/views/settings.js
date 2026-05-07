// Settings view — global config (AI context window, voice profile) and a
// read-only system status block (chat.db, app.db, OpenAI, watcher, server).

import { api, fetchSettings } from '../api.js';
import { setMainHeader } from '../shell.js';
import { escapeHtml } from '../utils.js';
import {
  settingsCache, settingsBounds,
  setSettingsCache, setSettingsBounds,
} from '../state.js';

/** Pull settings + bounds from the server, merge into state. */
export async function refreshSettings() {
  try {
    const r = await fetchSettings();
    if (r.settings) setSettingsCache(r.settings);
    if (r.bounds) setSettingsBounds(r.bounds);
  } catch { /* keep prior cache */ }
}

export async function renderSettingsView() {
  setMainHeader({
    title: 'Settings',
    subHTML: '<span class="accent">global config</span> · stored in app.db',
  });
  const list = document.getElementById('drafts-list');
  if (!list) return;

  // Load fresh values + system status before rendering.
  const [, health] = await Promise.all([
    refreshSettings(),
    api('/api/health').catch(() => null),
  ]);

  const cc = settingsCache.ai_context_count;
  const bounds = settingsBounds.ai_context_count || { min: 1, max: 100 };

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
        <label class="field-label">OpenAI<span class="desc">required for /api/ai/* endpoints</span></label>
        <div class="field-readonly">model: ${escapeHtml(health.openai_model || '?')} · ${fmtBool(health.openai_configured, 'key configured', 'OPENAI_API_KEY not set in .env')}</div>
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

  const vpUpdated = settingsCache.voice_profile_updated_at;
  const vpUpdatedLabel = vpUpdated > 0
    ? new Date(vpUpdated).toLocaleString()
    : 'never';
  const vpSampleBounds = settingsBounds.voice_profile_sample_count || { min: 50, max: 2000 };

  // OpenAI section state — masked, never the raw key.
  const oaSet = !!settingsCache.openai_api_key_set;
  const oaLast4 = settingsCache.openai_api_key_last4 || '';
  const oaSource = settingsCache.openai_api_key_source || 'none';
  const oaModel = settingsCache.openai_model || '';
  const oaModelEffective = (health && health.openai_model) || 'gpt-4o-mini';

  list.innerHTML = `
    <form class="settings-section" data-form="openai">
      <h3>OpenAI</h3>
      <div class="settings-row">
        <label class="field-label">
          Status
          <span class="desc">Where the active API key is coming from. A key set here (in app.db) overrides whatever's in .env.</span>
        </label>
        <div class="field-readonly">
          ${oaSet
            ? `<span class="ok">✓ key configured</span> · last 4: <code>${escapeHtml(oaLast4)}</code> · source: <code>${escapeHtml(oaSource)}</code>`
            : '<span class="warn">✗ no key configured</span> · AI features will return 503 until you add one'}
        </div>
      </div>
      <div class="settings-row">
        <label class="field-label" for="oa-key">
          API key
          <span class="desc">Paste your OpenAI API key. Stored in app.db, never sent anywhere except api.openai.com. Get one at platform.openai.com/api-keys.</span>
        </label>
        <div class="field-input">
          <input id="oa-key" type="password" name="openai_api_key" placeholder="${oaSet ? '•••• ' + escapeHtml(oaLast4) + ' (paste a new key to replace)' : 'sk-...'}" autocomplete="off" />
        </div>
      </div>
      <div class="settings-row">
        <label class="field-label" for="oa-model">
          Model override
          <span class="desc">Optional. Leave blank to use the .env value (currently: <code>${escapeHtml(oaModelEffective)}</code>). Common values: <code>gpt-4o-mini</code>, <code>gpt-4o</code>.</span>
        </label>
        <div class="field-input">
          <input id="oa-model" type="text" name="openai_model" placeholder="(use .env default)" value="${escapeHtml(oaModel)}" />
        </div>
      </div>
      <div class="settings-actions">
        <button type="submit" class="btn primary">Save</button>
        ${oaSet && oaSource === 'settings'
          ? '<button type="button" class="btn ghost" data-action="oa-clear-key">Clear key</button>'
          : ''}
        <span class="settings-status" data-error></span>
      </div>
    </form>

    <form class="settings-section" data-form="settings">
      <h3>AI</h3>
      <div class="settings-row">
        <label class="field-label" for="set-ctx">
          Context window
          <span class="desc">How many recent messages get attached to the AI prompt as context. Used by the row sparkle button and "Draft with context". Per-thread overrides still work via the slider in the thread toolbar.</span>
        </label>
        <div class="field-input">
          <input id="set-ctx" type="number" name="ai_context_count" min="${bounds.min}" max="${bounds.max}" value="${cc}" required />
          <span class="unit">messages · range ${bounds.min}–${bounds.max}</span>
        </div>
      </div>
      <div class="settings-actions">
        <button type="submit" class="btn primary">Save</button>
        <button type="button" class="btn ghost" data-action="reset-settings">Reset to defaults</button>
        <span class="settings-status" data-error></span>
      </div>
    </form>

    <form class="settings-section" data-form="voice-profile">
      <h3>Voice profile</h3>

      <div class="settings-row">
        <label class="field-label" for="vp-sample">
          Sample size
          <span class="desc">How many of your most recent sent messages to read when (re)generating. Larger = more evidence, more tokens. Range ${vpSampleBounds.min}–${vpSampleBounds.max}.</span>
        </label>
        <div class="field-input">
          <input id="vp-sample" type="number" name="voice_profile_sample_count" min="${vpSampleBounds.min}" max="${vpSampleBounds.max}" value="${settingsCache.voice_profile_sample_count}" />
          <span class="unit">messages</span>
        </div>
      </div>

      <div class="settings-row">
        <label class="field-label" for="vp-context">
          Your context
          <span class="desc">Optional guidance the model should know when profiling you (e.g. "I'm 30, work in tech, southern, casual"). Persists across regenerations. Leave blank to skip.</span>
        </label>
        <textarea id="vp-context" name="voice_profile_user_context" rows="3" placeholder="Optional…">${escapeHtml(settingsCache.voice_profile_user_context || '')}</textarea>
      </div>

      <div class="settings-row" style="grid-template-columns: 1fr;">
        <div>
          <div class="voice-meta">Voice profile <span class="accent">// fed into every AI draft prompt</span> · last updated: ${escapeHtml(vpUpdatedLabel)}</div>
          <textarea name="voice_profile" class="mono" rows="14" placeholder="Empty. Click 'Regenerate from chat.db' to produce one, or paste/edit your own.">${escapeHtml(settingsCache.voice_profile || '')}</textarea>
        </div>
      </div>

      <div class="settings-actions">
        <button type="submit" class="btn primary">Save edits</button>
        <button type="button" class="btn" data-action="vp-regenerate">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><polyline points="21 3 21 8 16 8"/></svg>
          Regenerate from chat.db
        </button>
        <span class="settings-status" data-error></span>
      </div>
    </form>

    <div class="settings-section">
      <h3>System</h3>
      ${sysRows}
    </div>
  `;
}
