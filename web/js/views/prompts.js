// Prompts — centralized settings page for every user-editable prompt in the
// system. Single source of truth: every prompt textarea Galt uses lives here.
// Per-feature pages (Away, Summon, …) link out to this page for prompt edits.
//
// Architecture: a registry (PROMPT_REGISTRY) describes the page. Adding a new
// prompt means adding an entry — no other changes to this file or actions.js
// (the form handler passes everything through to PUT /api/settings, which
// already silently ignores unknown keys via updateSettings's per-key gates).
//
// Out of scope (intentional): the hard-coded built-in prompts in server/ai.ts
// (CLASSIFY_SYSTEM, DRAFT_SYSTEM, AUTO_NOTE_SYSTEM, etc.). Exposing those is a
// separate decision, not "consolidation" of what's already user-editable.

import { setMainHeader } from '../shell.js';
import { escapeHtml } from '../utils.js';
import { settingsCache } from '../state.js';

/* ---------- registry ---------- */
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

/* ---------- render ---------- */

function renderField(f) {
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

function renderSection(sectionKey) {
  const s = PROMPT_REGISTRY[sectionKey];
  return `
    <section class="away-section">
      <h3><span>${escapeHtml(s.title)}</span></h3>
      <div class="desc" style="margin: 0 0 14px 0; max-width: 720px;">${s.blurbHtml}</div>
      <form class="away-config-form" data-form="prompts-${escapeHtml(sectionKey)}">
        ${s.fields.map(renderField).join('')}
        <div class="config-actions">
          <button type="submit" class="btn primary">Save changes</button>
          <span class="settings-status" data-error></span>
        </div>
      </form>
    </section>
  `;
}

export async function renderPromptsView() {
  setMainHeader({
    title: 'Prompts',
    subHTML: '<span class="accent">centralized prompt config</span> · all custom prompting across the system',
  });
  const list = document.getElementById('drafts-list');
  if (!list) return;

  list.innerHTML = `
    <div class="desc" style="padding: 4px 0 18px 0; max-width: 720px;">
      One place for every user-editable prompt Galt uses. Built-in prompts (classifier, drafting,
      voice-profile generation, auto-note extraction) are still hard-coded in
      <code>server/ai.ts</code> — exposing those here is a separate decision.
    </div>
    ${renderSection('away')}
    ${renderSection('summon')}
  `;
}
