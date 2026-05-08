// Galt — every user-editable prompt fragment the AI layer assembles, in
// one place. Empty textarea = the built-in default runs (visible via
// "View default"); non-empty = your text replaces it.
//
// Account / system stuff (OpenAI key, AI context window, your voice
// profile, system status) lives on #/settings. Mode-level toggles
// (away activation + whitelist, summon trigger phrase) live on
// #/away and #/summon. This page is purely the prompt registry.

import { escapeHtml } from '../utils.js';
import { setMainHeader } from '../shell.js';
import { settingsCache, promptDefaults } from '../state.js';
import { refreshSettings } from './settings.js';

/* ---------- prompts registry ---------- */
//
// One section per form. Each form posts to `prompts-<sectionKey>`.
// Field shape:
//   key          — settings column name (must match server/db/app.ts AppSettings)
//   label        — short header
//   desc         — one-sentence help (kept tight; canonical placeholder
//                  reference is the panel above the sections)
//   rows         — textarea height
//   placeholder  — placeholder text (optional)
//   mono         — render in monospace (for prompt-text overrides)
//   showsDefault — promptDefaults key whose text appears under "View default"

const PROMPT_REGISTRY = {
  away: {
    title: 'Away mode',
    blurb: "Galt covers FOR you while you're gone — speaks AS you, in your voice.",
    fields: [
      {
        key: 'away_message',
        label: 'Greeting',
        desc: 'First canned reply when an opted-in contact pings you. Plain text, sent as-is.',
        rows: 3,
      },
      {
        key: 'away_persona',
        label: 'Persona',
        desc: 'Style hints for how the AI should cover for you — banter, deflection, jokes.',
        rows: 5,
        placeholder:
          "e.g. 'be casual and a little snarky — lean into the AI thing if anyone asks. crack small jokes.'",
      },
      {
        key: 'prompt_away_system',
        label: 'Custom prompt',
        desc: 'When non-empty, replaces the built-in away prompt entirely.',
        rows: 12,
        placeholder: '(empty — built-in is running)',
        mono: true,
        showsDefault: 'prompt_away_system',
      },
      {
        key: 'prompt_away_guardrail',
        label: 'Guardrail',
        desc: 'Hard rule forbidding commitments on your behalf. Only injected when away mode is on.',
        rows: 12,
        placeholder: '(empty — built-in is running)',
        mono: true,
        showsDefault: 'prompt_away_guardrail',
      },
    ],
  },
  summon: {
    title: 'Summon mode',
    blurb: 'Galt joins WITH you mid-conversation — a third voice, prefixed with "Galt:".',
    fields: [
      {
        key: 'galt_voice_profile',
        label: 'Galt voice profile',
        desc: "How Galt sounds when he's himself. User-written prose; no AI generation.",
        rows: 4,
        placeholder:
          "e.g. 'direct, no hedging. iMessage-short — usually one line. light dry humor when it fits.'",
      },
      {
        key: 'summon_system_prompt',
        label: 'Custom prompt',
        desc: 'When non-empty, replaces the built-in summon prompt entirely.',
        rows: 12,
        placeholder: '(empty — built-in is running)',
        mono: true,
        showsDefault: 'prompt_summon_system',
      },
    ],
  },
  universal: {
    title: 'Universal',
    blurb: 'Foundational base prompt — runs on every AI reply, regardless of mode.',
    fields: [
      {
        key: 'prompt_draft_system',
        label: 'Base draft system prompt',
        desc: 'Universal "writing AS the user" guidance injected into every AI call.',
        rows: 12,
        mono: true,
        showsDefault: 'prompt_draft_system',
      },
    ],
  },
  wrappers: {
    title: 'Data-injection wrappers',
    blurb: 'Templates that frame each piece of injected data before it reaches the model. Edit with care.',
    fields: [
      { key: 'wrapper_voice_profile',   label: 'Voice profile',   desc: 'Wraps the voice profile body.',                                              rows: 4, mono: true, showsDefault: 'wrapper_voice_profile' },
      { key: 'wrapper_contact_profile', label: 'Contact profile', desc: 'Wraps the per-contact prose profile.',                                       rows: 4, mono: true, showsDefault: 'wrapper_contact_profile' },
      { key: 'wrapper_address_book',    label: 'Address book',    desc: 'Wraps the macOS Contacts.app block.',                                        rows: 4, mono: true, showsDefault: 'wrapper_address_book' },
      { key: 'wrapper_calendar',        label: 'Calendar',        desc: 'Wraps the macOS Calendar.app availability block.',                           rows: 4, mono: true, showsDefault: 'wrapper_calendar' },
      { key: 'wrapper_contact_notes',   label: 'Contact notes',   desc: 'Wraps per-contact note bullets.',                                            rows: 4, mono: true, showsDefault: 'wrapper_contact_notes' },
      { key: 'wrapper_temperament',     label: 'Temperament',     desc: 'Wraps the temperament-override block. Only injected when temperament ≠ normal.', rows: 4, mono: true, showsDefault: 'wrapper_temperament' },
    ],
  },
};

/* ---------- placeholder reference ---------- */
//
// Single source of truth for what {placeholders} are available in every
// editable prompt template. Adding a placeholder here → also add a key
// in buildPlaceholderContext() in server/ai.ts.

const PLACEHOLDER_REFERENCE = [
  { key: 'messages',        renders: 'The full thread (last N messages, oldest → newest, with "me:" / "them:" speakers).', notes: 'When used anywhere in the system prompt, the thread is substituted there and is NOT also sent as a separate user message — you control where it appears.' },
  { key: 'recipientName',   renders: "The contact's display name (or their handle if no name is on file).",                notes: 'Falls back to the chat handle in the manual-draft endpoint when no name resolves.' },
  { key: 'userName',        renders: 'Your display name. Currently always renders as <code>the user</code>.',              notes: 'First-party self-name isn\'t tracked yet.' },
  { key: 'persona',         renders: 'The <code>away_persona</code> value above.',                                         notes: 'Empty in summon / manual-draft contexts.' },
  { key: 'voice_profile',   renders: 'The voice profile being used for this call (galt_voice_profile in summon, your voice_profile elsewhere).', notes: 'Same content the wrapper would inject — referencing it without clearing the wrapper double-injects.' },
  { key: 'contact_profile', renders: 'The per-contact prose profile.',                                                     notes: 'Empty when no profile exists for this contact.' },
  { key: 'address_book',    renders: 'macOS Contacts.app data for this contact (role, birthday, free-form notes).',       notes: 'Empty when no AddressBook entry exists.' },
  { key: 'calendar',        renders: 'Your availability for the period around now.',                                       notes: 'Empty when no events are in the window.' },
  { key: 'contact_notes',   renders: 'Per-contact short-note bullets ("- " prefixed).',                                    notes: 'Empty when no notes exist for this contact.' },
  { key: 'temperament',     renders: 'Current temperament name (<code>normal</code>, <code>blunt</code>, <code>warm</code>, etc.).', notes: '' },
  { key: 'guidance',        renders: 'Style guidance text mapped to the current temperament.',                             notes: 'Empty when temperament is <code>normal</code>.' },
  { key: 'body',            renders: 'The data being wrapped (voice profile text, calendar block, notes, etc.).',          notes: 'Only meaningful inside wrapper templates. Empty everywhere else.' },
];

/* ---------- shared helpers ---------- */

const OVERRIDE_DOT_FILLED = '<span title="overridden — your text is running" style="color: var(--green); font-size: 9px; line-height: 1;">●</span>';
const OVERRIDE_DOT_HOLLOW = '<span title="using built-in default" style="color: var(--text-faint); font-size: 9px; line-height: 1;">○</span>';

function hasOverride(key) {
  const v = settingsCache[key];
  return typeof v === 'string' && v.trim().length > 0;
}

function countOverridesBySection() {
  const out = {};
  let total = 0;
  let overridden = 0;
  for (const [k, s] of Object.entries(PROMPT_REGISTRY)) {
    let sec = 0;
    for (const f of s.fields) {
      total++;
      if (hasOverride(f.key)) { sec++; overridden++; }
    }
    out[k] = { overridden: sec, total: s.fields.length };
  }
  return { sections: out, total, overridden };
}

/* ---------- prompts render ---------- */

function renderPromptField(f) {
  const value = settingsCache[f.key] ?? '';
  const overridden = hasOverride(f.key);
  const dot = overridden ? OVERRIDE_DOT_FILLED : OVERRIDE_DOT_HOLLOW;
  const monoStyle = f.mono
    ? ' style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;"'
    : '';
  const placeholder = f.placeholder ? ` placeholder="${escapeHtml(f.placeholder)}"` : '';

  let defaultPane = '';
  if (f.showsDefault && promptDefaults[f.showsDefault]) {
    const defaultText = promptDefaults[f.showsDefault];
    defaultPane = `
      <details style="margin-top: 4px;">
        <summary style="cursor: pointer; font-size: 11px; color: var(--text-faint); padding: 2px 0;" title="${defaultText.length} characters">
          View default
        </summary>
        <pre style="background: var(--bg-faint); padding: 10px; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; white-space: pre-wrap; word-break: break-word; margin: 4px 0 0 0; max-height: 280px; overflow-y: auto;">${escapeHtml(defaultText)}</pre>
      </details>
    `;
  }

  return `
    <div class="config-field" style="margin-bottom: 14px;">
      <label class="config-label">
        <span style="display: inline-flex; align-items: center; gap: 8px;">
          ${dot}<span>${escapeHtml(f.label)}</span>
        </span>
        <span class="desc">${escapeHtml(f.desc || '')}</span>
      </label>
      <textarea name="${escapeHtml(f.key)}" rows="${f.rows}"${placeholder}${monoStyle}>${escapeHtml(value)}</textarea>
      ${defaultPane}
    </div>
  `;
}

function renderPromptSection(sectionKey, counts) {
  const s = PROMPT_REGISTRY[sectionKey];
  const c = counts.sections[sectionKey];
  const meta = c.overridden > 0
    ? `<span class="config-summary-meta"><span style="color: var(--green);">${c.overridden}</span> / ${c.total} overridden</span>`
    : `<span class="config-summary-meta">${c.total} field${c.total === 1 ? '' : 's'} · all built-in</span>`;
  return `
    <section class="away-section">
      <h3>
        <span>${escapeHtml(s.title)}</span>
        ${meta}
      </h3>
      <div class="desc" style="margin: -4px 0 14px 0; max-width: 720px;">${escapeHtml(s.blurb)}</div>
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

/* Same shape as renderPromptSection but wraps the section in a collapsible
 * <details> — used for advanced sections that most users won't touch. */
function renderCollapsedPromptSection(sectionKey, counts) {
  const s = PROMPT_REGISTRY[sectionKey];
  const c = counts.sections[sectionKey];
  const meta = c.overridden > 0
    ? `<span class="config-summary-meta"><span style="color: var(--green);">${c.overridden}</span> / ${c.total} overridden</span>`
    : `<span class="config-summary-meta">${c.total} field${c.total === 1 ? '' : 's'} · all built-in</span>`;
  return `
    <section class="away-section">
      <details class="away-collapsible">
        <summary>
          <span>${escapeHtml(s.title)}</span>
          ${meta}
        </summary>
        <div class="desc" style="margin: 8px 0 14px 0; max-width: 720px;">${escapeHtml(s.blurb)}</div>
        <form class="away-config-form" data-form="prompts-${escapeHtml(sectionKey)}">
          ${s.fields.map(renderPromptField).join('')}
          <div class="config-actions">
            <button type="submit" class="btn primary">Save changes</button>
            <span class="settings-status" data-error></span>
          </div>
        </form>
      </details>
    </section>
  `;
}

/* ---------- placeholder reference panel (collapsed by default) ---------- */

function renderPlaceholdersPanel() {
  const rows = PLACEHOLDER_REFERENCE.map((p) => `
    <tr>
      <td style="padding: 6px 14px 6px 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; vertical-align: top; white-space: nowrap;"><code>{${escapeHtml(p.key)}}</code></td>
      <td style="padding: 6px 0; font-size: 12px; vertical-align: top; line-height: 1.5;">
        ${p.renders}${p.notes ? ` <span style="color: var(--text-faint);">— ${p.notes}</span>` : ''}
      </td>
    </tr>
  `).join('');
  return `
    <section class="away-section">
      <details class="away-collapsible">
        <summary>
          <span>Placeholder reference</span>
          <span class="config-summary-meta">${PLACEHOLDER_REFERENCE.length} variables · usable in every prompt below</span>
        </summary>
        <table style="width: 100%; border-collapse: collapse; margin-top: 8px;">
          <tbody>${rows}</tbody>
        </table>
      </details>
    </section>
  `;
}

/* ---------- top-level render ---------- */

export async function renderGaltView() {
  setMainHeader({
    title: 'Galt',
    subHTML: '<span class="accent">prompts</span> · system / account config on <a href="#/settings">Settings</a> · mode toggles on <a href="#/away">Away</a> + <a href="#/summon">Summon</a>',
  });
  const list = document.getElementById('drafts-list');
  if (!list) return;

  await refreshSettings();
  const counts = countOverridesBySection();

  const statusLine = counts.overridden === 0
    ? `<span style="color: var(--text-faint);">All ${counts.total} prompts using built-in defaults.</span>`
    : `<span style="color: var(--green); font-weight: 600;">${counts.overridden}</span> <span style="color: var(--text-faint);">of ${counts.total} prompts overridden.</span>`;

  list.innerHTML = `
    <div style="display: flex; align-items: baseline; gap: 16px; padding: 4px 0 18px 0; max-width: 720px;">
      <div style="font-size: 13px;">${statusLine}</div>
      <div class="desc" style="font-size: 11px; color: var(--text-faint);">
        Empty textarea = built-in default runs. Non-empty = your text replaces it.
      </div>
    </div>

    ${renderPlaceholdersPanel()}

    ${renderPromptSection('away', counts)}
    ${renderPromptSection('summon', counts)}

    ${renderCollapsedPromptSection('universal', counts)}
    ${renderCollapsedPromptSection('wrappers', counts)}
  `;
}
