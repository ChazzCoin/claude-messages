// Galt — prompt injection pipeline. Visualizes the actual order data
// flows through on every AI reply. The order shown here matches the
// PIPELINE_STAGES export from server/ai.ts exactly:
//
//   [first contact only, AWAY] greeting (literal, pre-AI)
//                              ↓ subsequent replies →
//
//      [Universal] draft_system
//          ↓
//   ┌──────┴──────┐
//   ↓             ↓
//   AWAY:         SUMMON:
//   contextNote   contextNote
//   persona       galt_voice → (feeds shared voice wrapper below)
//   ↓             ↓
//   └──────┬──────┘
//          ↓
//   [Shared wrappers]: voice · contact · address · calendar · notes · temperament
//          ↓
//   [Guardrail] (away only — last so it's freshest in the model's reading)
//          ↓
//      OPENAI
//
// Each prompt is a node (a clickable <details>). Mode = lane color
// (Away red-coral, Summon amber, Universal neutral, Wrappers mute).
// Type = shape + icon. Override state = solid border + amber/red accent
// vs dashed border + dim. Click a node to expand the inline editor.

import { escapeHtml } from '../utils.js';
import { setMainHeader } from '../shell.js';
import { settingsCache, promptDefaults } from '../state.js';
import { refreshSettings } from './settings.js';

/* ---------- prompts registry ----------
   Each editable prompt fragment in the system. Field shape:
     key          — settings column name (matches server/db/app.ts)
     type         — shape/icon: greeting | persona | prompt | guardrail
                    | wrapper | voice | context
     mode         — lane color: pre | universal | away | summon | shared
     label        — short header
     desc         — one-sentence help (what this prompt does in the pipeline)
     rows         — textarea height
     placeholder  — placeholder text (optional)
     mono         — render textarea in monospace
     showsDefault — promptDefaults key whose text appears in "View default"
*/

const PRE_AI = {
  mode: 'pre',
  tag: 'Pre-AI',
  meta: 'first contact only — sent literally, never reaches the model',
  fields: [
    {
      key: 'away_message',
      type: 'greeting',
      label: 'Greeting',
      desc: 'First reply to an opted-in contact when away mode is on. Sent verbatim. Supports {recipientName} and {userName} substitution; otherwise plain text.',
      rows: 3,
    },
  ],
};

const STAGE_UNIVERSAL = {
  mode: 'universal',
  tag: 'Galt identity',
  meta: 'always runs · Galt is the system-wide AI voice (every AI message is prefixed "Galt:" on send)',
  fields: [
    {
      key: 'prompt_draft_system',
      type: 'prompt',
      label: 'Base system prompt',
      desc: 'Universal "you are Galt, an AI assistant for the user" guidance injected on every AI call.',
      rows: 12,
      mono: true,
      showsDefault: 'prompt_draft_system',
    },
    {
      key: 'galt_voice_profile',
      type: 'voice',
      label: "Galt's voice",
      desc: "Prose describing how Galt sounds — tone, register, quirks. THE voice used in every AI reply (away, summon, manual draft). Feeds the shared voice-profile wrapper below.",
      rows: 4,
      placeholder:
        "e.g. 'direct, no hedging. iMessage-short — usually one line. light dry humor when it fits.'",
    },
  ],
};

const LANE_AWAY = {
  mode: 'away',
  tag: 'Away mode',
  meta: "when you're gone — Galt covers as your AI assistant",
  fields: [
    {
      key: 'prompt_away_system',
      type: 'context',
      label: 'Away contextNote',
      desc: 'Per-turn instruction for Galt while covering. When non-empty, replaces the built-in default contextNote.',
      rows: 12,
      placeholder: '(empty — built-in is running)',
      mono: true,
      showsDefault: 'prompt_away_system',
    },
    {
      key: 'away_persona',
      type: 'persona',
      label: 'Cover-mode persona',
      desc: "How Galt should behave specifically while covering — banter level, deflection style, jokes, how to handle 'are you really the AI?'. Layered on top of Galt's voice. Wrapped by the persona-wrapper template (advanced) and injected as its own stage.",
      rows: 5,
      placeholder:
        "e.g. 'be casual and a little snarky — lean into the AI thing if anyone asks. crack small jokes.'",
    },
  ],
  // Advanced: the wrapper template that frames the persona body. Most
  // users won't touch this. Rendered in a collapsed "advanced" sub-block.
  advancedFields: [
    {
      key: 'wrapper_away_persona',
      type: 'wrapper',
      label: 'Persona wrapper template',
      desc: 'Wraps the persona body in a system-prompt section. {body} = the persona text.',
      rows: 4,
      mono: true,
      showsDefault: 'wrapper_away_persona',
    },
  ],
};

const LANE_SUMMON = {
  mode: 'summon',
  tag: 'Summon mode',
  meta: 'when called in mid-conversation — Galt joins as a third voice',
  fields: [
    {
      key: 'summon_system_prompt',
      type: 'context',
      label: 'Summon contextNote',
      desc: 'Per-turn instruction for Galt joining the conversation. When non-empty, replaces the built-in default.',
      rows: 12,
      placeholder: '(empty — built-in is running)',
      mono: true,
      showsDefault: 'prompt_summon_system',
    },
  ],
};

const STAGE_WRAPPERS = {
  mode: 'shared',
  tag: 'Shared wrappers',
  meta: 'data-injection templates that frame each placeholder · each fires only when its data is present',
  fields: [
    { key: 'wrapper_voice_profile',   type: 'wrapper', label: "Galt's voice",    desc: "Wraps Galt's voice profile. Fires on every AI call regardless of mode (away · summon · manual draft).",                  rows: 4, mono: true, showsDefault: 'wrapper_voice_profile' },
    { key: 'wrapper_contact_profile', type: 'wrapper', label: 'Contact profile', desc: 'Wraps the per-contact prose profile.',                                                                                rows: 4, mono: true, showsDefault: 'wrapper_contact_profile' },
    { key: 'wrapper_address_book',    type: 'wrapper', label: 'Address book',    desc: 'Wraps the macOS Contacts.app block.',                                                                                 rows: 4, mono: true, showsDefault: 'wrapper_address_book' },
    { key: 'wrapper_calendar',        type: 'wrapper', label: 'Calendar',        desc: 'Wraps macOS Calendar availability.',                                                                                  rows: 4, mono: true, showsDefault: 'wrapper_calendar' },
    { key: 'wrapper_contact_notes',   type: 'wrapper', label: 'Contact notes',   desc: 'Wraps per-contact note bullets.',                                                                                     rows: 4, mono: true, showsDefault: 'wrapper_contact_notes' },
    { key: 'wrapper_temperament',     type: 'wrapper', label: 'Temperament',     desc: 'Wraps temperament guidance. Only injects when temperament ≠ normal.',                                                 rows: 4, mono: true, showsDefault: 'wrapper_temperament' },
  ],
};

const STAGE_GUARDRAIL = {
  mode: 'away',
  tag: 'Guardrail',
  meta: 'away mode only · runs LAST so it\'s freshest in the model\'s reading',
  fields: [
    {
      key: 'prompt_away_guardrail',
      type: 'guardrail',
      label: 'Away guardrail',
      desc: 'Hard rule forbidding commitments on the user\'s behalf. Only injected when away mode is on.',
      rows: 12,
      placeholder: '(empty — built-in is running)',
      mono: true,
      showsDefault: 'prompt_away_guardrail',
    },
  ],
};

/* ---------- placeholder reference ---------- */

const PLACEHOLDER_REFERENCE = [
  { key: 'messages',        renders: 'The full thread (last N messages, oldest → newest, with "me:" / "them:" speakers).', notes: 'When used anywhere in the system prompt, the thread is substituted there and is NOT also sent as a separate user message — you control where it appears.' },
  { key: 'recipientName',   renders: "The contact's display name (or their handle if no name is on file).",                notes: 'Falls back to the chat handle in the manual-draft endpoint when no name resolves.' },
  { key: 'userName',        renders: 'Your display name. Currently always renders as <code>the user</code>.',              notes: 'First-party self-name isn\'t tracked yet.' },
  { key: 'persona',         renders: 'The <code>away_persona</code> value.',                                                notes: 'Empty in summon / manual-draft contexts. Old custom away-prompts that reference this still work — and the persona wrapper is skipped to avoid double-injection.' },
  { key: 'voice_profile',   renders: "Galt's voice (the galt_voice_profile setting). Same content the voice wrapper injects — referencing it without clearing the wrapper double-injects.", notes: 'Galt is the system-wide AI voice; the user\'s old voice_profile is no longer used.' },
  { key: 'contact_profile', renders: 'The per-contact prose profile.',                                                     notes: 'Empty when no profile exists for this contact.' },
  { key: 'address_book',    renders: 'macOS Contacts.app data for this contact (role, birthday, free-form notes).',       notes: 'Empty when no AddressBook entry exists.' },
  { key: 'calendar',        renders: 'Your availability for the period around now.',                                       notes: 'Empty when no events are in the window.' },
  { key: 'contact_notes',   renders: 'Per-contact short-note bullets ("- " prefixed).',                                    notes: 'Empty when no notes exist for this contact.' },
  { key: 'temperament',     renders: 'Current temperament name (<code>normal</code>, <code>blunt</code>, <code>warm</code>, etc.).', notes: '' },
  { key: 'guidance',        renders: 'Style guidance text mapped to the current temperament.',                             notes: 'Empty when temperament is <code>normal</code>.' },
  { key: 'body',            renders: 'The data being wrapped (voice profile text, calendar block, notes, etc.).',          notes: 'Only meaningful inside wrapper templates. Empty everywhere else.' },
];

/* ---------- helpers ---------- */

function hasOverride(key) {
  const v = settingsCache[key];
  return typeof v === 'string' && v.trim().length > 0;
}

function countOverrides() {
  const all = [
    ...PRE_AI.fields,
    ...STAGE_UNIVERSAL.fields,
    ...LANE_AWAY.fields,
    ...(LANE_AWAY.advancedFields || []),
    ...LANE_SUMMON.fields,
    ...STAGE_WRAPPERS.fields,
    ...STAGE_GUARDRAIL.fields,
  ];
  const total = all.length;
  const overridden = all.filter((f) => hasOverride(f.key)).length;
  return { total, overridden };
}

function stageOverrides(stage) {
  const all = [...stage.fields, ...(stage.advancedFields || [])];
  return all.filter((f) => hasOverride(f.key)).length;
}

/* ---------- icons ---------- */

const ICONS = {
  greeting: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z"/></svg>`,
  persona:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M5 21v-1a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v1"/></svg>`,
  prompt:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  context:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-6 0v4"/><rect x="2" y="9" width="20" height="13" rx="2"/></svg>`,
  guardrail:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>`,
  voice:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/></svg>`,
  wrapper:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 8 4 4 8 4"/><polyline points="20 8 20 4 16 4"/><polyline points="4 16 4 20 8 20"/><polyline points="20 16 20 20 16 20"/></svg>`,
};

const CHEVRON_SVG = `<svg class="galt-flow-card-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;

/* ---------- card ---------- */

function renderCard(f) {
  const value = settingsCache[f.key] ?? '';
  const overridden = hasOverride(f.key);
  const placeholder = f.placeholder ? ` placeholder="${escapeHtml(f.placeholder)}"` : '';
  const monoCls = f.mono ? ' mono' : '';

  let defaultPane = '';
  if (f.showsDefault && promptDefaults[f.showsDefault]) {
    const defaultText = promptDefaults[f.showsDefault];
    defaultPane = `
      <details class="galt-flow-default">
        <summary>view built-in default <span style="color:var(--text-mute);">· ${defaultText.length} chars</span></summary>
        <pre>${escapeHtml(defaultText)}</pre>
      </details>
    `;
  }

  const stateLabel = overridden ? 'override' : 'built-in';
  const resetBtn = overridden
    ? `<button type="button" class="v9-btn subtle" data-action="reset-prompt-card" data-key="${escapeHtml(f.key)}">Reset</button>`
    : '';
  const icon = ICONS[f.type] || ICONS.prompt;

  return `
    <details class="galt-flow-card" data-type="${escapeHtml(f.type)}" data-overridden="${overridden}">
      <summary>
        <span class="galt-flow-card-icon">${icon}</span>
        <span class="galt-flow-card-title">${escapeHtml(f.label)}</span>
        <span class="galt-flow-card-state">
          <span class="dot"></span>${stateLabel}
        </span>
        ${CHEVRON_SVG}
      </summary>
      <form class="galt-flow-card-body" data-form="prompt-card" data-key="${escapeHtml(f.key)}">
        <div class="galt-flow-card-desc">${escapeHtml(f.desc || '')}</div>
        <textarea class="${monoCls.trim()}" name="${escapeHtml(f.key)}" rows="${f.rows}"${placeholder}>${escapeHtml(value)}</textarea>
        <div class="galt-flow-card-foot">
          ${defaultPane || ''}
          <span class="grow"></span>
          <span class="settings-status" data-error></span>
          ${resetBtn}
          <button type="submit" class="v9-btn primary">Save</button>
        </div>
      </form>
    </details>
  `;
}

/* ---------- stages ---------- */

function renderStage(stage, opts = {}) {
  const overridden = stageOverrides(stage);
  const total = stage.fields.length + (stage.advancedFields?.length || 0);
  const countText = overridden > 0
    ? `<span class="num">${overridden}</span>/${total} customized`
    : `${total} ${total === 1 ? 'prompt' : 'prompts'} · all default`;
  const cards = opts.gridLayout
    ? `<div class="galt-flow-wrappers-grid">${stage.fields.map(renderCard).join('')}</div>`
    : stage.fields.map(renderCard).join('');
  return `
    <div class="galt-flow-stage" data-mode="${stage.mode}">
      <header class="galt-flow-stage-head">
        <span class="galt-flow-stage-tag">${escapeHtml(stage.tag)}</span>
        <span class="galt-flow-stage-meta">${escapeHtml(stage.meta)}</span>
        <span class="galt-flow-stage-count">${countText}</span>
      </header>
      ${cards}
    </div>
  `;
}

function renderLane(lane) {
  const overridden = stageOverrides(lane);
  const total = lane.fields.length + (lane.advancedFields?.length || 0);
  const countText = overridden > 0
    ? `<span class="num">${overridden}</span>/${total} customized`
    : `${total} · all default`;
  const advanced = (lane.advancedFields || []).length > 0
    ? `
      <details class="galt-flow-advanced">
        <summary>advanced — wrapper templates</summary>
        ${lane.advancedFields.map(renderCard).join('')}
      </details>
    `
    : '';
  return `
    <div class="galt-flow-lane" data-mode="${lane.mode}">
      <header class="galt-flow-lane-head">
        <span class="galt-flow-stage-tag">${escapeHtml(lane.tag)}</span>
        <span class="galt-flow-stage-meta">${escapeHtml(lane.meta)}</span>
        <span class="galt-flow-stage-count">${countText}</span>
      </header>
      ${lane.fields.map(renderCard).join('')}
      ${advanced}
    </div>
  `;
}

/* ---------- placeholder reference ---------- */

function renderPlaceholders() {
  const rows = PLACEHOLDER_REFERENCE.map((p) => `
    <tr>
      <td><code>{${escapeHtml(p.key)}}</code></td>
      <td>${p.renders}${p.notes ? ` <span style="color: var(--text-mute);">— ${p.notes}</span>` : ''}</td>
    </tr>
  `).join('');
  return `
    <details class="galt-placeholders">
      <summary>
        Placeholder reference
        <span class="meta">${PLACEHOLDER_REFERENCE.length} variables · usable in every prompt below</span>
      </summary>
      <table><tbody>${rows}</tbody></table>
    </details>
  `;
}

/* ---------- top-level render ---------- */

export async function renderGaltView() {
  setMainHeader({
    title: 'Galt',
    subHTML: '<span class="accent">prompts</span> · pipeline visualization · system / account on <a href="#/settings">Settings</a> · mode toggles on <a href="#/away">Away</a> + <a href="#/summon">Summon</a>',
  });
  const list = document.getElementById('drafts-list');
  if (!list) return;

  await refreshSettings();
  const counts = countOverrides();

  const statusLine = counts.overridden === 0
    ? `<span class="num">${counts.total}</span> prompts<span class="sep">·</span><span>all using built-in defaults</span>`
    : `<span class="num amber">${counts.overridden}</span> of <span class="num">${counts.total}</span> prompts overridden<span class="sep">·</span><span>${counts.total - counts.overridden} still default</span>`;

  list.innerHTML = `
    <div class="galt-flow">

      <div class="galt-flow-status">
        ${statusLine}
        <span class="sep">·</span>
        <span>empty textarea = built-in runs · non-empty = your text replaces it</span>
      </div>

      ${renderPlaceholders()}

      <div class="galt-flow-io">incoming message → mode dispatch</div>
      <div class="galt-flow-arrow"></div>

      ${renderStage(PRE_AI)}

      <div class="galt-flow-io" style="margin-top:8px;font-size:9.5px;letter-spacing:1.2px;">subsequent replies enter the AI pipeline</div>
      <div class="galt-flow-arrow"></div>

      ${renderStage(STAGE_UNIVERSAL)}

      <div class="galt-flow-split">
        <div class="galt-flow-split-leg-l"></div>
        <div class="galt-flow-split-leg-r"></div>
      </div>

      <div class="galt-flow-lanes">
        ${renderLane(LANE_AWAY)}
        ${renderLane(LANE_SUMMON)}
      </div>

      <div class="galt-flow-merge">
        <div class="merge-leg-l"></div>
        <div class="merge-leg-r"></div>
        <div class="merge-tip"></div>
      </div>

      ${renderStage(STAGE_WRAPPERS, { gridLayout: true })}

      <div class="galt-flow-arrow"></div>

      ${renderStage(STAGE_GUARDRAIL)}

      <div class="galt-flow-arrow"></div>
      <div class="galt-flow-io">openai call → draft reply</div>

    </div>
  `;
}
