// Galt — per-mode prompt pipeline view.
//
// Each tab is one mode (Away / Summon). Inside a tab is the mode's
// actual prompt assembly order — editable cards for user-customizable
// pieces, read-only cards for guardrails and per-contact data sections.
// "Preview prompt" at the bottom calls the mode's preview() through
// /api/modes/:name/preview and shows what would actually be sent to
// OpenAI for a synthetic context (or a real chat if you pass chat_id).
//
// Single source of truth: each mode's stages() method on the server
// (server/ai/modes/*). Adding a stage = add a return entry to
// stages() + push it in buildSystemPrompt; the UI auto-renders.
//
// The per-card form pattern is shared with the legacy galt page —
// data-form="prompt-card" + a single textarea whose `name` is the
// settings key. The form handler in actions.js does the rest.

import { api } from '../api.js';
import { escapeHtml } from '../utils.js';
import { setMainHeader } from '../shell.js';
import { settingsCache } from '../state.js';
import { refreshSettings } from './settings.js';
import { renderSessionCard } from '../components/session-card.js';

/* ---------- mode metadata ----------
   Surface info per mode so the tab strip + intro can be authored in
   one spot. Add a new mode = add an entry here AND register it on the
   server side (server/ai/modes/* + MODES_BY_NAME in index.ts). */

const MODE_META = {
  away: {
    label: 'Away',
    tagline: "Galt covers when you're out",
    blurb:
      "When you're away, Galt auto-replies to opted-in contacts and groups on your behalf. Replies go out without your review — every guardrail here is load-bearing. The greeting fires once per away period; subsequent turns go through the AI assembly below.",
    accent: 'red',  // CSS hook
  },
  summon: {
    label: 'Summon',
    tagline: 'Galt joins as a third voice',
    blurb:
      'When you type the trigger phrase mid-conversation, Galt opens a session and joins as a third voice — you stay in the chat. Bare summons (trigger alone) get the literal acknowledgment; ask-summons skip it and answer directly. The user can dismiss with the end phrase.',
    accent: 'amber',
  },
};

/* ---------- view-local state ---------- */
let currentMode = 'away';
let modesData = null;          // { modes: [{ name, stages }] }
let previewState = null;       // { mode, systemPrompt, userContent, greeting } when shown

/* ---------- icons ---------- */

const ICONS = {
  greeting:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z"/></svg>`,
  identity:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M5 21v-1a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v1"/></svg>`,
  voice:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/></svg>`,
  data:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>`,
  context:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-6 0v4"/><rect x="2" y="9" width="20" height="13" rx="2"/></svg>`,
  guardrail: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  format:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="18" x2="18" y2="18"/></svg>`,
};
const CHEV = `<svg class="galt-flow-card-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;

/** Pick an icon based on a stage id heuristic. */
function iconForStage(stage) {
  const id = stage.id;
  if (id === 'greeting')             return ICONS.greeting;
  if (id === 'identity')             return ICONS.identity;
  if (id === 'voice')                return ICONS.voice;
  if (id === 'context_note')         return ICONS.context;
  if (id.startsWith('contact_'))     return ICONS.data;
  if (id === 'address_book' ||
      id === 'calendar')             return ICONS.data;
  if (id === 'persona')              return ICONS.context;
  if (id === 'output_format')        return ICONS.format;
  if (id === 'group_framing' ||
      id === 'no_commit_guardrail' ||
      id === 'never_ask_help_desk' ||
      id === 'keep_it_short' ||
      id === 'skip_opt_out' ||
      id === 'skip_policy' ||
      id === 'vary_phrasing')        return ICONS.guardrail;
  return ICONS.guardrail;
}

/* ---------- card renderers ---------- */

/** Editable stage — settings-backed textarea. The form pattern is
 *  shared with the legacy page; kind="prompt-card" in actions.js
 *  PUTs the named field to /api/settings and re-renders. */
function renderEditableCard(stage) {
  const key = stage.settingsKey;
  const value = settingsCache[key] ?? '';
  const overridden = value && String(value).trim() !== '' && stage.defaultText !== value;
  const rows = stage.rows || 4;
  const stateLabel = overridden ? 'override' : (value ? 'set' : 'default');
  const resetBtn = overridden
    ? `<button type="button" class="v9-btn subtle" data-action="reset-prompt-card" data-key="${escapeHtml(key)}">Reset to default</button>`
    : '';
  const defaultPane = stage.defaultText
    ? `<details class="galt-flow-default">
         <summary>built-in default <span style="color:var(--text-mute);">· ${stage.defaultText.length} chars</span></summary>
         <pre>${escapeHtml(stage.defaultText)}</pre>
       </details>`
    : '';
  return `
    <details class="galt-flow-card editable" data-stage-id="${escapeHtml(stage.id)}" data-overridden="${overridden}">
      <summary>
        <span class="galt-flow-card-icon">${iconForStage(stage)}</span>
        <span class="galt-flow-card-title">${escapeHtml(stage.label)}</span>
        <span class="galt-flow-card-fires">${escapeHtml(stage.fires)}</span>
        <span class="galt-flow-card-state"><span class="dot"></span>${stateLabel}</span>
        ${CHEV}
      </summary>
      <form class="galt-flow-card-body" data-form="prompt-card" data-key="${escapeHtml(key)}">
        ${stage.description ? `<div class="galt-flow-card-desc">${escapeHtml(stage.description)}</div>` : ''}
        <textarea class="mono" name="${escapeHtml(key)}" rows="${rows}" placeholder="(empty — built-in default runs)">${escapeHtml(value)}</textarea>
        <div class="galt-flow-card-foot">
          ${defaultPane}
          <span class="grow"></span>
          <span class="settings-status" data-error></span>
          ${resetBtn}
          <button type="submit" class="v9-btn primary">Save</button>
        </div>
      </form>
    </details>
  `;
}

/** Read-only stage — guardrail constants and per-contact data sections.
 *  Click to expand and see the literal text. */
function renderReadOnlyCard(stage) {
  const text = stage.text || '';
  return `
    <details class="galt-flow-card readonly" data-stage-id="${escapeHtml(stage.id)}">
      <summary>
        <span class="galt-flow-card-icon">${iconForStage(stage)}</span>
        <span class="galt-flow-card-title">${escapeHtml(stage.label)}</span>
        <span class="galt-flow-card-fires">${escapeHtml(stage.fires)}</span>
        <span class="galt-flow-card-state readonly"><span class="dot"></span>read-only</span>
        ${CHEV}
      </summary>
      <div class="galt-flow-card-body">
        ${stage.description ? `<div class="galt-flow-card-desc">${escapeHtml(stage.description)}</div>` : ''}
        <pre class="galt-flow-readonly-text">${escapeHtml(text)}</pre>
      </div>
    </details>
  `;
}

function renderStage(stage) {
  return stage.settingsKey ? renderEditableCard(stage) : renderReadOnlyCard(stage);
}

/* ---------- mode tab content ---------- */

function renderModeContent(modeEntry) {
  const meta = MODE_META[modeEntry.name] || { label: modeEntry.name, tagline: '', blurb: '', accent: 'amber' };
  const allEditable = [
    ...(modeEntry.greeting ? [modeEntry.greeting] : []),
    ...modeEntry.stages.filter((s) => s.settingsKey),
  ].filter((s) => s.settingsKey);
  const overridden = allEditable.filter((s) => {
    const v = settingsCache[s.settingsKey] ?? '';
    return v && String(v).trim() !== '' && s.defaultText !== v;
  });

  // Numbered, sequential stages — each is one step in the system-prompt
  // assembly. Arrows between them make the order obvious.
  const numberedStages = modeEntry.stages.map((stage, i) => `
    <div class="galt-flow-step">
      <div class="galt-flow-step-num">${i + 1}</div>
      <div class="galt-flow-step-card">${renderStage(stage)}</div>
    </div>
  `).join('<div class="galt-flow-arrow"></div>');

  // Pre-AI greeting (separate from the pipeline because it's literal,
  // not injected). Renders as one card above the pipeline.
  const greetingBlock = modeEntry.greeting ? `
    <div class="galt-flow-section">
      <div class="galt-flow-section-tag">PRE-AI · LITERAL SEND</div>
      <div class="galt-flow-step">
        <div class="galt-flow-step-num greeting">★</div>
        <div class="galt-flow-step-card">${renderStage(modeEntry.greeting)}</div>
      </div>
    </div>
    <div class="galt-flow-divider">
      <span class="galt-flow-divider-label">subsequent turns enter the AI pipeline · greeting appears in thread context naturally</span>
    </div>
  ` : '';

  const previewBlock = previewState && previewState.mode === modeEntry.name
    ? renderPreview(previewState)
    : '';

  return `
    <div class="galt-mode-pane" data-mode="${escapeHtml(modeEntry.name)}" data-accent="${escapeHtml(meta.accent)}">
      <div class="galt-mode-intro">
        <div class="galt-mode-tagline">${escapeHtml(meta.tagline)}</div>
        <div class="galt-mode-blurb">${escapeHtml(meta.blurb)}</div>
        <div class="galt-mode-stats">
          <span><span class="num amber">${overridden.length}</span> of ${allEditable.length} customizable sections overridden</span>
          <span class="sep">·</span>
          <span>${modeEntry.stages.length} system-prompt stages${modeEntry.greeting ? ' + 1 pre-AI greeting' : ''}</span>
        </div>
      </div>

      ${greetingBlock}

      <div class="galt-flow-section">
        <div class="galt-flow-section-tag">AI PIPELINE · SYSTEM ROLE</div>
        <div class="galt-flow-stages">${numberedStages}</div>
      </div>

      <div class="galt-flow-arrow"></div>

      <div class="galt-flow-section">
        <div class="galt-flow-section-tag user-role">AI PIPELINE · USER ROLE</div>
        <div class="galt-flow-userrole">
          <div class="galt-flow-userrole-title">Formatted thread</div>
          <div class="galt-flow-userrole-desc">
            Recent messages, oldest → newest. Framework-enforced: the most recent message is ALWAYS the last line of the user role, so the model's recency-bias attention focuses on what was just said. Modes cannot override this.
          </div>
        </div>
      </div>

      <div class="galt-flow-arrow"></div>

      <div class="galt-flow-terminal">→ OpenAI · ${escapeHtml(modeEntry.name)}</div>

      <div class="galt-preview-bar">
        <button type="button" class="v9-btn primary" data-action="galt-preview" data-mode="${escapeHtml(modeEntry.name)}">
          Preview assembled prompt
        </button>
        <span class="galt-preview-hint">render the actual SYSTEM + USER payload for this mode</span>
      </div>

      ${previewBlock}
    </div>
  `;
}

function renderPreview(p) {
  const sysLen = (p.systemPrompt || '').length;
  const userLen = (p.userContent || '').length;
  const greetingBlock = p.greeting
    ? `<div class="galt-preview-section">
         <div class="galt-preview-label">Greeting (pre-AI literal send)</div>
         <pre class="galt-preview-text">${escapeHtml(p.greeting)}</pre>
       </div>`
    : '';
  return `
    <div class="galt-preview" data-mode="${escapeHtml(p.mode)}">
      <div class="galt-preview-head">
        <span class="galt-preview-title">Preview · ${escapeHtml(p.mode)}</span>
        <span class="galt-preview-stats">${sysLen} chars system · ${userLen} chars user</span>
        <button type="button" class="v9-btn subtle" data-action="galt-preview-close">Close</button>
      </div>
      ${greetingBlock}
      <div class="galt-preview-section">
        <div class="galt-preview-label">SYSTEM role</div>
        <pre class="galt-preview-text">${escapeHtml(p.systemPrompt || '')}</pre>
      </div>
      <div class="galt-preview-section">
        <div class="galt-preview-label">USER role <span class="galt-preview-note">(latest message always last — recency-bias)</span></div>
        <pre class="galt-preview-text">${escapeHtml(p.userContent || '')}</pre>
      </div>
    </div>
  `;
}

/* ---------- top-level render ---------- */

export async function renderGaltView() {
  setMainHeader({
    title: 'Galt',
    subHTML: '<span class="accent">prompt pipeline · per mode</span> · system / account on <a href="#/settings">Settings</a> · away mode on <a href="#/away">Away</a>',
  });
  const list = document.getElementById('drafts-list');
  if (!list) return;

  // Pull settings (for current overrides) + modes (for stages) in parallel.
  let summonSessions = [];
  try {
    const [, modesResp, ssResp] = await Promise.all([
      refreshSettings(),
      api('/api/modes'),
      api('/api/summon/sessions?limit=100').catch(() => ({ sessions: [] })),
    ]);
    modesData = modesResp;
    summonSessions = ssResp?.sessions || [];
  } catch (err) {
    list.innerHTML = `<div class="empty"><div class="empty-title">Failed to load modes.</div><div class="empty-sub">${escapeHtml(err.message)}</div></div>`;
    return;
  }

  const modes = (modesData?.modes || []);
  if (modes.length === 0) {
    list.innerHTML = '<div class="empty"><div class="empty-title">No modes registered.</div></div>';
    return;
  }
  if (!modes.some((m) => m.name === currentMode)) {
    currentMode = modes[0].name;
  }
  const active = modes.find((m) => m.name === currentMode);

  const tabStrip = modes.map((m) => {
    const meta = MODE_META[m.name] || { label: m.name, accent: 'amber' };
    const isActive = m.name === currentMode;
    return `
      <button type="button"
              class="galt-mode-tab ${isActive ? 'active' : ''}"
              data-action="galt-switch-mode"
              data-mode="${escapeHtml(m.name)}"
              data-accent="${escapeHtml(meta.accent)}">
        ${escapeHtml(meta.label)}
      </button>
    `;
  }).join('');

  const activeSummon = summonSessions.filter((s) => s.status === 'active');
  const summonOpsBlock = currentMode === 'summon'
    ? renderSummonOps(activeSummon, summonSessions.filter((s) => s.status === 'ended').slice(0, 30))
    : '';

  list.innerHTML = `
    <div class="galt-page">
      <div class="galt-mode-tabs">${tabStrip}</div>
      ${renderModeContent(active)}
      ${summonOpsBlock}
    </div>
  `;
}

/* ---------- summon ops (sessions) — only on summon tab ---------- */

function renderSummonOps(activeSessions, pastSessions) {
  if (activeSessions.length === 0 && pastSessions.length === 0) return '';
  const activeBlock = activeSessions.length > 0
    ? `<section class="galt-summon-section">
         <h3>Active sessions <span class="count">${activeSessions.length}</span></h3>
         <div class="galt-summon-active-list">
           ${activeSessions.map((s) => renderSessionCard(s, { kind: 'summon' })).join('')}
         </div>
       </section>`
    : '';
  const pastBlock = pastSessions.length > 0
    ? `<section class="galt-summon-section">
         <details class="away-collapsible">
           <summary>Past sessions <span class="count">${pastSessions.length}</span></summary>
           <div class="galt-summon-past-list">
             ${pastSessions.map((s) => renderSessionCard(s, { kind: 'summon', compact: true })).join('')}
           </div>
         </details>
       </section>`
    : '';
  return `<div class="galt-summon-ops">${activeBlock}${pastBlock}</div>`;
}

/* ---------- public actions used by actions.js ---------- */

/** Switch which mode tab is active. Re-renders. */
export function setGaltMode(name) {
  if (!modesData?.modes?.some((m) => m.name === name)) return;
  currentMode = name;
  previewState = null;  // close any open preview when switching tabs
  renderGaltView();
}

/** Fetch and show the assembled prompt for a given mode. */
export async function showGaltPreview(name) {
  try {
    const r = await api(`/api/modes/${encodeURIComponent(name)}/preview`);
    previewState = {
      mode: r.mode,
      systemPrompt: r.systemPrompt,
      userContent: r.userContent,
      greeting: r.greeting,
    };
    renderGaltView();
    // Scroll the preview into view so it's obvious where it landed.
    requestAnimationFrame(() => {
      document.querySelector('.galt-preview')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  } catch (err) {
    alert(`Preview failed: ${err.message}`);
  }
}

export function closeGaltPreview() {
  previewState = null;
  renderGaltView();
}
