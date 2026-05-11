// Settings — system + account configuration. Holds OpenAI API key/model,
// AI behavior knobs (context window), and the user's voice profile (used
// when Galt impersonates the user in away mode / manual draft). Also
// renders read-only system status (chat.db, app.db, watcher).
//
// Galt-specific stuff (every editable PROMPT — away/summon/universal/
// wrappers) lives on #/galt. This split: this page is about YOU and the
// system; #/galt is about the AI persona and how it talks.

import { api, fetchSettings } from '../api.js';
import { setMainHeader } from '../shell.js';
import { escapeHtml } from '../utils.js';
import {
  settingsCache, settingsBounds,
  setSettingsCache, setSettingsBounds, setPromptDefaults, setPipelineStages,
} from '../state.js';

/** Pull settings + bounds + prompt defaults from the server, merge into state.
 *  Called at boot from main.js and after settings-mutating actions. Lives
 *  here because Settings is the primary surface for the user/account
 *  fields; Galt re-imports it for the prompts page. */
export async function refreshSettings() {
  try {
    const r = await fetchSettings();
    if (r.settings) setSettingsCache(r.settings);
    if (r.bounds) setSettingsBounds(r.bounds);
    if (r.prompt_defaults) setPromptDefaults(r.prompt_defaults);
    if (r.pipeline_stages) setPipelineStages(r.pipeline_stages);
  } catch { /* keep prior cache */ }
}

const SECTION_HEADER_STYLE =
  'padding: 8px 0 14px 0; font-weight: 600; color: var(--text); ' +
  'letter-spacing: 0.06em; text-transform: uppercase; font-size: 11px;';

export async function renderSettingsView() {
  setMainHeader({
    title: 'Settings',
    subHTML: '<span class="accent">system &amp; account</span> · OpenAI · AI behavior · system status · Galt\'s voice + prompts on <a href="#/galt">Galt</a>',
  });
  const list = document.getElementById('drafts-list');
  if (!list) return;

  // Pull fresh settings (for the API-key + voice-profile sections) and
  // current health (for the model-effective hint and the system-status block).
  const [, health] = await Promise.all([
    refreshSettings(),
    api('/api/health').catch(() => null),
  ]);

  // ----- AI section data -----
  const cc = settingsCache.ai_context_count;
  const ccBounds = settingsBounds.ai_context_count || { min: 1, max: 100 };

  // ----- OpenAI section data (key is masked, never sent down) -----
  const oaSet = !!settingsCache.openai_api_key_set;
  const oaLast4 = settingsCache.openai_api_key_last4 || '';
  const oaSource = settingsCache.openai_api_key_source || 'none';
  const oaModel = settingsCache.openai_model || '';
  const oaModelEffective = (health && health.openai_model) || 'gpt-4o-mini';

  // The user's voice_profile concept was retired when Galt became the
  // system-wide AI voice — see CLAUDE.md and server/db/app.ts. No UI
  // section in Settings for it anymore. Galt's voice is edited on the
  // Galt page (#/galt).

  // ----- System status data -----
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
        <label class="field-label">Watcher<span class="desc">fs.watch on chat.db-wal</span></label>
        <div class="field-readonly">${health.watcher_running ? '<span class="ok">✓ running</span>' : '<span class="warn">⚠ not running</span>'}</div>
      </div>
      <div class="settings-row">
        <label class="field-label">Server<span class="desc">version + uptime</span></label>
        <div class="field-readonly">${escapeHtml(health.server || 'galt')} v${escapeHtml(health.version || '?')}</div>
      </div>
    `;

  list.innerHTML = `
    <div class="desc" style="padding: 4px 0 18px 0; max-width: 720px;">
      System and account settings. Galt's per-mode prompts and persona
      content live on <a href="#/galt">Galt</a>.
    </div>

    <div style="${SECTION_HEADER_STYLE}">OpenAI</div>
    <form class="settings-section" data-form="openai">
      <h3>API key &amp; model</h3>
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

    <div style="${SECTION_HEADER_STYLE}">AI behavior</div>
    <form class="settings-section" data-form="settings">
      <h3>Context window</h3>
      <div class="settings-row">
        <label class="field-label" for="set-ctx">
          Recent messages
          <span class="desc">How many recent messages get attached to the AI prompt as context. Used by the row sparkle button and "Draft with context". Per-thread overrides still work via the slider in the thread toolbar.</span>
        </label>
        <div class="field-input">
          <input id="set-ctx" type="number" name="ai_context_count" min="${ccBounds.min}" max="${ccBounds.max}" value="${cc}" required />
          <span class="unit">messages · range ${ccBounds.min}–${ccBounds.max}</span>
        </div>
      </div>
      <div class="settings-actions">
        <button type="submit" class="btn primary">Save</button>
        <button type="button" class="btn ghost" data-action="reset-settings">Reset to defaults</button>
        <span class="settings-status" data-error></span>
      </div>
    </form>

    <div style="${SECTION_HEADER_STYLE}">Notifications</div>
    <div class="settings-section">
      <h3>Push to companion devices</h3>
      <div class="settings-row">
        <label class="field-label">
          Test push
          <span class="desc">Fires a push notification at every device that has the companion PWA registered (Settings → Notifications → Enable, on the device). Use this to confirm the pipeline before wiring push into auto-notes / replies / flags.</span>
        </label>
        <div class="settings-actions" style="margin-top: 0;">
          <button type="button" class="btn primary" data-action="push-test-web">Send test push</button>
          <span class="settings-status" data-id="push-test-status"></span>
        </div>
      </div>
    </div>

    <div style="${SECTION_HEADER_STYLE}">System</div>
    <div class="settings-section">
      <h3>Status</h3>
      ${sysRows}
    </div>
  `;
}
