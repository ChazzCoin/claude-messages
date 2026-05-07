// Galt — the master config page for the AI persona itself. Galt is the
// single voice that interacts across every mode (away, summon, future
// modes); this page is where you configure who Galt is and how Galt
// behaves. Per-feature pages (Away, Summon, …) own activation + safety
// caps and link out here for any persona / prompt content edits.
//
// Sections:
//   1. OpenAI         — API key + model override (drives all of Galt's AI)
//   2. AI behavior    — context window (how much thread history Galt sees)
//   3. Voice profile  — distilled prose describing how YOU write; Galt uses
//                       it when impersonating you (away mode, drafts).
//   4. Prompts        — every user-editable prompt (away greeting/persona,
//                       summon persona, summon full-prompt override). The
//                       prompts section is registry-driven (PROMPT_REGISTRY) —
//                       adding a prompt = appending an entry, no other
//                       changes here or in actions.js.
//
// System status (chat.db / app.db / watcher / server / OpenAI reachability)
// stays on #/settings — that's about infrastructure, not about Galt.
//
// Out of scope (intentional): hard-coded built-in prompts in server/ai.ts
// (CLASSIFY_SYSTEM, DRAFT_SYSTEM, AUTO_NOTE_SYSTEM, …). Exposing those is a
// separate decision, not "consolidation" of what's already user-editable.

import { api, fetchSettings } from '../api.js';
import { setMainHeader } from '../shell.js';
import { escapeHtml } from '../utils.js';
import {
  settingsCache, settingsBounds,
  setSettingsCache, setSettingsBounds,
} from '../state.js';

/** Pull settings + bounds from the server, merge into state. Exported because
 *  main.js calls it at boot, and other views (Settings, Home) may want fresh
 *  values. Lives here because Galt is the primary surface that consumes them. */
export async function refreshSettings() {
  try {
    const r = await fetchSettings();
    if (r.settings) setSettingsCache(r.settings);
    if (r.bounds) setSettingsBounds(r.bounds);
  } catch { /* keep prior cache */ }
}

/* ---------- prompts registry ---------- */
//
// One entry per section. Each section has a form that submits to
// `prompts-<sectionKey>` and lists fields by settings-key.
//
// Field shape:
//   key          — settings column name (must match server/db/app.ts AppSettings)
//   label        — short header
//   desc         — plain-text help (escaped)        ── use ONE of desc/descHtml
//   descHtml     — pre-formatted HTML help (raw)    ── trusted-static only
//   rows         — textarea height
//   placeholder  — placeholder text (optional)
//   mono         — render in monospace (for prompt overrides) (optional)

const PROMPT_REGISTRY = {
  away: {
    title: 'Away mode',
    blurbHtml:
      'Galt covers <strong>FOR</strong> you while you\'re gone — speaks AS you, in your voice. ' +
      'Activation, whitelist, and safety caps live on the <a href="#/away">Away</a> page; ' +
      'prompt content lives here.',
    fields: [
      {
        key: 'away_message',
        label: 'Greeting',
        desc:
          'First canned reply sent when an opted-in contact messages you while away mode is on. ' +
          'Plain text — sent as-is, not run through the AI.',
        rows: 3,
      },
      {
        key: 'away_persona',
        label: 'Persona',
        desc:
          'How the AI should behave while covering — banter, deflection, jokes, how to handle ' +
          '"are you really an AI?". Distinct from voice profile (which captures HOW you write).',
        rows: 5,
        placeholder:
          "e.g. 'be casual and a little snarky — lean into the AI thing if anyone asks. crack small jokes. ask follow-ups when curious.'",
      },
    ],
  },
  summon: {
    title: 'Summon mode',
    blurbHtml:
      'Galt joins <strong>WITH</strong> you mid-conversation — a third voice you pulled in, ' +
      'replies prefixed with <code>Galt:</code>. Trigger phrase, end phrase, and safety caps ' +
      'live on the <a href="#/summon">Summon</a> page; prompt content lives here.',
    fields: [
      {
        key: 'summon_persona',
        label: 'Persona',
        desc:
          'How Galt should behave AS THEMSELVES while summoned. Distinct from away persona — ' +
          'here Galt is a third voice you pulled in, not pretending to be you. Appended to the ' +
          'built-in prompt; ignored when the custom prompt override below is set.',
        rows: 4,
        placeholder:
          "e.g. 'be helpful but not stiff. crack a joke when it fits. keep replies short — iMessage register, not essay-length. push back if i\\'m being dumb.'",
      },
      {
        key: 'summon_system_prompt',
        label: 'Custom prompt override',
        descHtml:
          'When non-empty, <strong>REPLACES</strong> the entire built-in summon prompt. Write ' +
          'your own instructions for how Galt should behave per-turn. The conversation thread, ' +
          'voice profile, and contact context still flow through automatically — this only ' +
          'controls the per-turn behavior instructions. Placeholders <code>{userName}</code> ' +
          'and <code>{recipientName}</code> get substituted at send time. Leave empty to use ' +
          'the built-in.',
        rows: 12,
        placeholder: '(empty — using built-in summon prompt)',
        mono: true,
      },
    ],
  },
};

/* ---------- prompts render ---------- */

function renderPromptField(f) {
  const value = settingsCache[f.key] ?? '';
  const desc = f.descHtml || escapeHtml(f.desc || '');
  const monoStyle = f.mono
    ? ' style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;"'
    : '';
  const placeholder = f.placeholder ? ` placeholder="${escapeHtml(f.placeholder)}"` : '';
  return `
    <div class="config-field">
      <label class="config-label">
        ${escapeHtml(f.label)}
        <span class="desc">${desc}</span>
      </label>
      <textarea name="${escapeHtml(f.key)}" rows="${f.rows}"${placeholder}${monoStyle}>${escapeHtml(value)}</textarea>
    </div>
  `;
}

function renderPromptSection(sectionKey) {
  const s = PROMPT_REGISTRY[sectionKey];
  return `
    <section class="away-section">
      <h3><span>${escapeHtml(s.title)}</span></h3>
      <div class="desc" style="margin: 0 0 14px 0; max-width: 720px;">${s.blurbHtml}</div>
      <form class="away-config-form" data-form="prompts-${escapeHtml(sectionKey)}">
        ${s.fields.map(renderPromptField).join('')}
        <div class="config-actions">
          <button type="submit" class="btn primary">Save changes</button>
          <span class="settings-status" data-error></span>
        </div>
      </form>
    </section>
  `;
}

/* ---------- top-level render ---------- */

const SECTION_HEADER_STYLE =
  'padding: 8px 0 14px 0; font-weight: 600; color: var(--text); ' +
  'letter-spacing: 0.06em; text-transform: uppercase; font-size: 11px;';

export async function renderGaltView() {
  setMainHeader({
    title: 'Galt',
    subHTML: '<span class="accent">the AI persona</span> · master config for who Galt is and how Galt behaves across every mode',
  });
  const list = document.getElementById('drafts-list');
  if (!list) return;

  // Load fresh settings + the effective model from /api/health (the model
  // shown in the "currently using" hint comes from the live server, not
  // the saved override). Both are best-effort.
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

  // ----- Voice profile section data -----
  const vpUpdated = settingsCache.voice_profile_updated_at;
  const vpUpdatedLabel = vpUpdated > 0
    ? new Date(vpUpdated).toLocaleString()
    : 'never';
  const vpSampleBounds = settingsBounds.voice_profile_sample_count || { min: 50, max: 2000 };

  list.innerHTML = `
    <div class="desc" style="padding: 4px 0 18px 0; max-width: 720px;">
      Galt is the AI persona that interacts across the system — covering for you in away mode,
      joining you in summon mode, and (over time) any other surface where the assistant talks.
      This page is Galt's home: API key, model, behavior, voice, and every user-editable prompt.
      System status (chat.db, app.db, watcher) lives on
      <a href="#/settings">Settings</a>.
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

    <div style="${SECTION_HEADER_STYLE}">Voice</div>
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

    <div style="${SECTION_HEADER_STYLE}">Prompts</div>
    ${renderPromptSection('away')}
    ${renderPromptSection('summon')}
  `;
}
