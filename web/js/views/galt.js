// Galt — prompt injection pipeline visualization. Rendered ENTIRELY from
// PIPELINE_STAGES exposed by /api/settings (the same constant the server's
// buildSystemPrompt loops over at runtime). Single source of truth: what
// you see here IS what runs at AI-call time.
//
// Layout:
//   [first reply, AWAY] greeting (literal, pre-AI · still in subsequent thread context)
//                              ↓
//      [Galt identity] base system prompt + Galt's voice
//          ↓
//   ┌──────┴──────┐
//   ↓             ↓
//   AWAY:         SUMMON:
//   contextNote   contextNote
//   persona
//   ↓             ↓
//   └──────┬──────┘
//          ↓
//   [Shared wrappers]: voice · contact · address · calendar · notes · temperament
//          ↓
//   [Guardrail] (away only — last so it's freshest in the model's reading)
//          ↓
//      OPENAI
//
// Each prompt is a node (a clickable <details>). Mode = lane color (Away
// red-coral, Summon amber, Universal neutral, Wrappers mute, Guardrail red).
// Type = shape + icon (driven by stage.type from the server). Override
// state = solid border + amber/red accent vs dashed border + dim. Click
// a node to expand the inline editor.
//
// To change what's in the visualization: edit PIPELINE_STAGES in
// server/ai.ts. The frontend rebuilds from the server's shape on every
// page render (after a refreshSettings() call at the top of renderGaltView).

import { api } from '../api.js';
import { escapeHtml } from '../utils.js';
import { setMainHeader } from '../shell.js';
import { settingsCache, settingsBounds, promptDefaults, pipelineStages } from '../state.js';
import { refreshSettings } from './settings.js';
import { renderSessionCard } from '../components/session-card.js';

/* ---------- lane metadata ----------
   Lanes themselves are declared per-stage on the server (stage.lane). This
   table provides the human-readable header text for each lane section.
   Add a new lane = add a new entry here AND a new lane value on the server. */

const LANE_META = {
  pre: {
    tag: 'Pre-AI',
    meta: "first reply only · sent verbatim (not AI-generated) · still part of the thread the AI reads on every subsequent reply",
  },
  universal: {
    tag: 'Galt identity',
    meta: 'always runs · Galt is the system-wide AI voice (every AI message is prefixed "Galt:" on send)',
  },
  away: {
    tag: 'Away mode',
    meta: "when you're gone — Galt covers as your AI assistant",
  },
  summon: {
    tag: 'Summon mode',
    meta: 'when called in mid-conversation — Galt joins as a third voice',
  },
  shared: {
    tag: 'Shared wrappers',
    meta: 'data-injection templates that frame each placeholder · each fires only when its data is present',
  },
  guardrail: {
    tag: 'Guardrail',
    meta: "away mode only · runs LAST so it's freshest in the model's reading",
  },
};

/* ---------- placeholder reference ---------- */

const PLACEHOLDER_REFERENCE = [
  { key: 'messages',        renders: 'The full thread (last N messages, oldest → newest, with "me:" / "them:" speakers).', notes: 'When used anywhere in the system prompt, the thread is substituted there and is NOT also sent as a separate user message — you control where it appears.' },
  { key: 'recipientName',   renders: "The contact's display name (or their handle if no name is on file).",                notes: 'Falls back to the chat handle in the manual-draft endpoint when no name resolves.' },
  { key: 'userName',        renders: 'Your display name. Currently always renders as <code>the user</code>.',              notes: 'First-party self-name isn\'t tracked yet.' },
  { key: 'persona',         renders: 'The <code>away_persona</code> value.',                                                notes: 'Empty in summon contexts. Old custom away-prompts that reference this still work — the persona wrapper is skipped to avoid double-injection.' },
  { key: 'voice_profile',   renders: "Galt's voice (the galt_voice_profile setting). Same content the voice wrapper injects — referencing it without clearing the wrapper double-injects.", notes: 'Galt is the system-wide AI voice; the user\'s old voice_profile is no longer used.' },
  { key: 'contact_profile', renders: 'The per-contact prose profile.',                                                     notes: 'Empty when no profile exists for this contact.' },
  { key: 'address_book',    renders: 'macOS Contacts.app data for this contact (role, birthday, free-form notes).',       notes: 'Empty when no AddressBook entry exists.' },
  { key: 'calendar',        renders: 'Your availability for the period around now.',                                       notes: 'Empty when no events are in the window.' },
  { key: 'contact_notes',   renders: 'Per-contact short-note bullets ("- " prefixed).',                                    notes: 'Empty when no notes exist for this contact.' },
  { key: 'temperament',     renders: 'Current temperament name (<code>normal</code>, <code>blunt</code>, <code>warm</code>, etc.).', notes: '' },
  { key: 'guidance',        renders: 'Style guidance text mapped to the current temperament.',                             notes: 'Empty when temperament is <code>normal</code>.' },
  { key: 'body',            renders: 'The data being wrapped (voice profile text, calendar block, notes, etc.).',          notes: 'Only meaningful inside wrapper templates. Empty everywhere else.' },
];

/* ---------- icons ---------- */
// Tiny inline SVGs, one per node-type. Uses currentColor so CSS controls fill.

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

/* ---------- helpers ---------- */

function hasOverride(key) {
  if (!key) return false;
  const v = settingsCache[key];
  return typeof v === 'string' && v.trim().length > 0;
}

/** Bucket an array of stages by their `lane` field. Returns a map
 *  { lane: stage[] } preserving array order within each lane. */
function groupByLane(stages) {
  const groups = {};
  for (const s of stages) {
    if (!s.settingsKey) continue; // skip viz-only stages without an editable surface
    if (!groups[s.lane]) groups[s.lane] = [];
    groups[s.lane].push(s);
  }
  return groups;
}

/** Compute customized-vs-total counts across a list of stages. */
function laneCount(stages) {
  let total = 0;
  let overridden = 0;
  for (const s of stages) {
    if (!s.settingsKey) continue;
    total++;
    if (hasOverride(s.settingsKey)) overridden++;
  }
  return { total, overridden };
}

/* ---------- card render ----------
   Renders a single editable stage as a clickable <details> with an
   inline form. settingsKey, rows, mono, placeholder, showsDefault all
   come from the stage object exactly as the server defines them. */

function renderCard(stage) {
  const key = stage.settingsKey;
  const value = settingsCache[key] ?? '';
  const overridden = hasOverride(key);
  const placeholder = stage.placeholder ? ` placeholder="${escapeHtml(stage.placeholder)}"` : '';
  const monoCls = stage.mono ? ' mono' : '';
  const rows = stage.rows || 4;

  let defaultPane = '';
  if (stage.showsDefault && promptDefaults[stage.showsDefault]) {
    const defaultText = promptDefaults[stage.showsDefault];
    defaultPane = `
      <details class="galt-flow-default">
        <summary>view built-in default <span style="color:var(--text-mute);">· ${defaultText.length} chars</span></summary>
        <pre>${escapeHtml(defaultText)}</pre>
      </details>
    `;
  }

  const stateLabel = overridden ? 'override' : 'built-in';
  const resetBtn = overridden
    ? `<button type="button" class="v9-btn subtle" data-action="reset-prompt-card" data-key="${escapeHtml(key)}">Reset</button>`
    : '';
  const icon = ICONS[stage.type] || ICONS.prompt;

  return `
    <details class="galt-flow-card" data-type="${escapeHtml(stage.type)}" data-overridden="${overridden}">
      <summary>
        <span class="galt-flow-card-icon">${icon}</span>
        <span class="galt-flow-card-title">${escapeHtml(stage.label)}</span>
        <span class="galt-flow-card-state">
          <span class="dot"></span>${stateLabel}
        </span>
        ${CHEVRON_SVG}
      </summary>
      <form class="galt-flow-card-body" data-form="prompt-card" data-key="${escapeHtml(key)}">
        <div class="galt-flow-card-desc">${escapeHtml(stage.desc || '')}</div>
        <textarea class="${monoCls.trim()}" name="${escapeHtml(key)}" rows="${rows}"${placeholder}>${escapeHtml(value)}</textarea>
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

/* ---------- lane renderers ----------
   Two shapes:
     - "stage" (full-width section, e.g. universal/shared/pre/guardrail)
     - "lane" (column inside a 2-up split, e.g. away/summon)
   Both group their stages by `isAdvanced` — advanced stages collapse
   into a sub-expand inside the section. */

function renderStageSection(laneKey, stages, opts = {}) {
  if (!stages || stages.length === 0) return '';
  const meta = LANE_META[laneKey] || { tag: laneKey, meta: '' };
  const counts = laneCount(stages);
  const countText = counts.overridden > 0
    ? `<span class="num">${counts.overridden}</span>/${counts.total} customized`
    : `${counts.total} ${counts.total === 1 ? 'prompt' : 'prompts'} · all default`;
  const main = stages.filter((s) => !s.isAdvanced);
  const advanced = stages.filter((s) => s.isAdvanced);
  const cards = opts.gridLayout
    ? `<div class="galt-flow-wrappers-grid">${main.map(renderCard).join('')}</div>`
    : main.map(renderCard).join('');
  const advancedBlock = advanced.length > 0
    ? `<details class="galt-flow-advanced"><summary>advanced — wrapper templates</summary>${advanced.map(renderCard).join('')}</details>`
    : '';
  return `
    <div class="galt-flow-stage" data-mode="${escapeHtml(laneKey)}">
      <header class="galt-flow-stage-head">
        <span class="galt-flow-stage-tag">${escapeHtml(meta.tag)}</span>
        <span class="galt-flow-stage-meta">${escapeHtml(meta.meta)}</span>
        <span class="galt-flow-stage-count">${countText}</span>
      </header>
      ${cards}
      ${advancedBlock}
    </div>
  `;
}

function renderLaneColumn(laneKey, stages) {
  if (!stages || stages.length === 0) {
    // Render an empty placeholder lane so the split visual still balances.
    const meta = LANE_META[laneKey] || { tag: laneKey, meta: '' };
    return `
      <div class="galt-flow-lane" data-mode="${escapeHtml(laneKey)}">
        <header class="galt-flow-lane-head">
          <span class="galt-flow-stage-tag">${escapeHtml(meta.tag)}</span>
          <span class="galt-flow-stage-meta">${escapeHtml(meta.meta)}</span>
          <span class="galt-flow-stage-count">0 · all default</span>
        </header>
        <div class="v9-empty">no stages in this lane</div>
      </div>
    `;
  }
  const meta = LANE_META[laneKey] || { tag: laneKey, meta: '' };
  const counts = laneCount(stages);
  const countText = counts.overridden > 0
    ? `<span class="num">${counts.overridden}</span>/${counts.total} customized`
    : `${counts.total} · all default`;
  const main = stages.filter((s) => !s.isAdvanced);
  const advanced = stages.filter((s) => s.isAdvanced);
  const advancedBlock = advanced.length > 0
    ? `<details class="galt-flow-advanced"><summary>advanced — wrapper templates</summary>${advanced.map(renderCard).join('')}</details>`
    : '';
  return `
    <div class="galt-flow-lane" data-mode="${escapeHtml(laneKey)}">
      <header class="galt-flow-lane-head">
        <span class="galt-flow-stage-tag">${escapeHtml(meta.tag)}</span>
        <span class="galt-flow-stage-meta">${escapeHtml(meta.meta)}</span>
        <span class="galt-flow-stage-count">${countText}</span>
      </header>
      ${main.map(renderCard).join('')}
      ${advancedBlock}
    </div>
  `;
}

/* ---------- Summon mode operations ----------
   Summon was folded into Galt. Above the pipeline visualization we may
   show an "active sessions" banner (when Galt is currently in
   conversation). Below the pipeline we render a Summon mode operations
   panel: configuration form (trigger, end phrase, safety cap, idle
   timeout) + past sessions list (collapsed). The on/off master toggle
   stays on the Home Switches grid; this page surfaces operations and
   session telemetry. */

function renderSummonActiveBanner(activeSessions) {
  if (!activeSessions || activeSessions.length === 0) return '';
  return `
    <div class="galt-summon-banner">
      <div class="galt-summon-banner-head">
        <span class="dot pulse"></span>
        <span class="galt-summon-banner-title">Galt is summoned</span>
        <span class="galt-summon-banner-count">${activeSessions.length} active</span>
      </div>
      <div class="galt-summon-banner-list">
        ${activeSessions.map((s) => renderSessionCard(s, { kind: 'summon' })).join('')}
      </div>
    </div>
  `;
}

function renderSummonOpsPanel(activeSessions, pastSessions) {
  const enabled = !!settingsCache.summon_enabled;
  const trigger = settingsCache.summon_trigger_phrase || 'GALT!!';
  const endP = settingsCache.summon_end_phrase || 'go away galt';
  const max = settingsBounds.summon_max_replies_per_session?.max || 200;
  const min = settingsBounds.summon_max_replies_per_session?.min || 1;
  const idleMax = settingsBounds.summon_idle_timeout_min?.max || 720;
  const idleMin = settingsBounds.summon_idle_timeout_min?.min || 1;

  const status = !enabled
    ? '<span class="galt-summon-status off">○ disabled</span> · the trigger phrase does nothing'
    : activeSessions.length > 0
      ? `<span class="galt-summon-status active">● ${activeSessions.length} active</span> · Galt is in conversation`
      : `<span class="galt-summon-status ready">● ready</span> · type <code>${escapeHtml(trigger)}</code> in any chat to invoke`;

  const pastBlock = pastSessions.length > 0
    ? `
      <details class="galt-summon-past">
        <summary>past sessions <span class="meta">${pastSessions.length}</span></summary>
        <div class="galt-summon-past-list">
          ${pastSessions.map((s) => renderSessionCard(s, { kind: 'summon', compact: true })).join('')}
        </div>
      </details>
    `
    : '';

  return `
    <section class="galt-summon-ops" data-mode="summon">
      <header class="galt-summon-ops-head">
        <span class="galt-flow-stage-tag">Summon mode operations</span>
        <span class="galt-flow-stage-meta">configure how Galt is invoked + watch active sessions</span>
        <span class="galt-summon-ops-status">${status}</span>
      </header>

      <form class="galt-summon-form" data-form="summon-config">
        <div class="galt-summon-grid">
          <div class="galt-summon-field">
            <label>
              Trigger phrase
              <span class="hint">type this anywhere in a message to invoke Galt · case-sensitive substring · default <code>GALT!!</code></span>
            </label>
            <input type="text" name="summon_trigger_phrase" value="${escapeHtml(trigger)}" autocomplete="off" />
          </div>
          <div class="galt-summon-field">
            <label>
              End phrase
              <span class="hint">type this to dismiss Galt · case-insensitive substring · default <code>go away galt</code></span>
            </label>
            <input type="text" name="summon_end_phrase" value="${escapeHtml(endP)}" autocomplete="off" />
          </div>
          <div class="galt-summon-field">
            <label>
              Safety cap
              <span class="hint">Galt auto-ends a session after this many replies</span>
            </label>
            <div class="galt-summon-inline">
              <input type="number" name="summon_max_replies_per_session" min="${min}" max="${max}" value="${settingsCache.summon_max_replies_per_session ?? 30}" />
              <span class="hint">replies/session</span>
            </div>
          </div>
          <div class="galt-summon-field">
            <label>
              Idle timeout
              <span class="hint">no chat activity for this long ends the session</span>
            </label>
            <div class="galt-summon-inline">
              <input type="number" name="summon_idle_timeout_min" min="${idleMin}" max="${idleMax}" value="${settingsCache.summon_idle_timeout_min ?? 30}" />
              <span class="hint">minutes</span>
            </div>
          </div>
        </div>
        <div class="galt-summon-actions">
          <button type="submit" class="v9-btn primary">Save changes</button>
          <span class="settings-status" data-error></span>
        </div>
      </form>

      ${pastBlock}
    </section>
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
    subHTML: '<span class="accent">prompts pipeline + summon mode operations</span> · system / account on <a href="#/settings">Settings</a> · away mode on <a href="#/away">Away</a>',
  });
  const list = document.getElementById('drafts-list');
  if (!list) return;

  // Pull settings + summon sessions in parallel. settingsCache populates
  // pipelineStages + the summon config knobs; sessions feed the active
  // banner above the pipeline + the past-sessions expand below.
  let summonSessions = [];
  try {
    const [, ss] = await Promise.all([
      refreshSettings(),
      api('/api/summon/sessions?limit=100').catch(() => ({ sessions: [] })),
    ]);
    summonSessions = ss?.sessions || [];
  } catch {
    // settingsCache keeps prior; sessions just stay empty.
  }
  const activeSummon = summonSessions.filter((s) => s.status === 'active');
  const pastSummon = summonSessions.filter((s) => s.status === 'ended').slice(0, 30);

  // pipelineStages came in via /api/settings — bucket by lane.
  const groups = groupByLane(pipelineStages);

  // Total customized count across ALL editable stages.
  const allEditable = pipelineStages.filter((s) => s.settingsKey);
  const totalCount = allEditable.length;
  const overriddenCount = allEditable.filter((s) => hasOverride(s.settingsKey)).length;

  const statusLine = overriddenCount === 0
    ? `<span class="num">${totalCount}</span> prompts<span class="sep">·</span><span>all using built-in defaults</span>`
    : `<span class="num amber">${overriddenCount}</span> of <span class="num">${totalCount}</span> prompts overridden<span class="sep">·</span><span>${totalCount - overriddenCount} still default</span>`;

  // Render each lane section. Order is fixed for the visualization (pre →
  // universal → split(away|summon) → shared → guardrail), even though the
  // server's PIPELINE_STAGES array could in theory be reordered. The viz
  // structure (single column, then split, then merge) is a fixed shape
  // — but which STAGES populate each lane comes from the server.
  list.innerHTML = `
    <div class="galt-flow">

      <div class="galt-flow-status">
        ${statusLine}
        <span class="sep">·</span>
        <span>empty textarea = built-in runs · non-empty = your text replaces it</span>
      </div>

      ${renderSummonActiveBanner(activeSummon)}

      ${renderPlaceholders()}

      <div class="galt-flow-io">incoming message → mode dispatch</div>
      <div class="galt-flow-arrow"></div>

      ${renderStageSection('pre', groups.pre)}

      <div class="galt-flow-io" style="margin-top:8px;font-size:9.5px;letter-spacing:1.2px;">subsequent replies enter the AI pipeline · greeting + full thread feed in as context</div>
      <div class="galt-flow-arrow"></div>

      ${renderStageSection('universal', groups.universal)}

      <div class="galt-flow-split">
        <div class="galt-flow-split-leg-l"></div>
        <div class="galt-flow-split-leg-r"></div>
      </div>

      <div class="galt-flow-lanes">
        ${renderLaneColumn('away', groups.away)}
        ${renderLaneColumn('summon', groups.summon)}
      </div>

      <div class="galt-flow-merge">
        <div class="merge-leg-l"></div>
        <div class="merge-leg-r"></div>
        <div class="merge-tip"></div>
      </div>

      ${renderStageSection('shared', groups.shared, { gridLayout: true })}

      <div class="galt-flow-arrow"></div>

      ${renderStageSection('guardrail', groups.guardrail)}

      <div class="galt-flow-arrow"></div>
      <div class="galt-flow-io">openai call → draft reply</div>

      ${renderSummonOpsPanel(activeSummon, pastSummon)}

    </div>
  `;
}
