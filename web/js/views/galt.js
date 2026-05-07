// Galt — the master prompts page for the AI persona. Galt is the single
// voice that interacts across every mode (away, summon, future modes);
// this page is where you control HOW Galt is told to behave at every
// prompt slot the AI layer assembles.
//
// What's here: the registry of every user-editable prompt — away/summon
// per-mode prompts, the universal draft system prompt, and the data-
// injection wrappers. Each field shows a "Show built-in default" pane
// so the actual fallback text is visible; an empty textarea means the
// fallback runs.
//
// What's NOT here: OpenAI API key, model override, AI context window,
// the user's voice profile, system status. All of that is account- /
// system-level configuration and lives on #/settings.

import { escapeHtml } from '../utils.js';
import { setMainHeader } from '../shell.js';
import { settingsCache, promptDefaults } from '../state.js';
import { refreshSettings } from './settings.js';

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
          '"are you really an AI?". Distinct from voice profile (which captures HOW you write). ' +
          'Substituted into {persona} inside the away custom prompt, if the prompt references it.',
        rows: 5,
        placeholder:
          "e.g. 'be casual and a little snarky — lean into the AI thing if anyone asks. crack small jokes. ask follow-ups when curious.'",
      },
      {
        key: 'prompt_away_system',
        label: 'Custom prompt override',
        descHtml:
          'When non-empty, <strong>REPLACES</strong> the entire built-in away prompt (the per-turn ' +
          'behavior instruction). Placeholders <code>{recipientName}</code> and <code>{persona}</code> ' +
          'get substituted at send time. Leave empty to use the built-in default below.',
        rows: 14,
        placeholder: '(empty — using built-in away prompt)',
        mono: true,
        showsDefault: 'prompt_away_system',
      },
      {
        key: 'prompt_away_guardrail',
        label: 'Away-mode guardrail',
        descHtml:
          'Hard rule appended to the system prompt for every away-mode reply — forbids the AI from ' +
          'committing to plans, RSVPs, prices, etc. on your behalf. ' +
          '<strong>Only injected when away mode is on.</strong> Empty = built-in default below.',
        rows: 14,
        placeholder: '(empty — using built-in guardrail)',
        mono: true,
        showsDefault: 'prompt_away_guardrail',
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
        key: 'galt_voice_profile',
        label: 'Galt voice profile',
        desc:
          "Prose describing how Galt sounds when he's himself — voice, tone, register, length, " +
          'quirks, what to avoid. Used here in summon mode (where Galt is a third voice). ' +
          "Distinct from your own voice profile, which Galt uses when impersonating you in away " +
          "mode. User-written; no AI generation. Injected as the VOICE PROFILE in the AI's " +
          'data-injection block.',
        rows: 4,
        placeholder:
          "e.g. 'direct, no hedging. keep it iMessage-short — usually one line. light dry humor when it fits. don\\'t be a help desk. push back if i\\'m being dumb.'",
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
          'the built-in default below.',
        rows: 14,
        placeholder: '(empty — using built-in summon prompt)',
        mono: true,
        showsDefault: 'prompt_summon_system',
      },
    ],
  },
  universal: {
    title: 'Universal (applies everywhere)',
    blurbHtml:
      'These run on <strong>every</strong> AI reply (away, summon, manual draft) regardless of ' +
      'mode. Edit with care — they\'re foundational. Empty = built-in default below.',
    fields: [
      {
        key: 'prompt_draft_system',
        label: 'Base draft system prompt',
        descHtml:
          'The first block of the system message. Universal "writing AS the user, match voice, ' +
          'plain text, SKIP if uncertain" guidance. Applies on every AI reply across all modes. ' +
          'Note: still injected even when summon mode\'s custom-prompt override is set, since ' +
          'this lives in the data-injection block <em>after</em> the custom prompt — be aware of ' +
          'potential contradictions if your summon override redefines who Galt is.',
        rows: 14,
        mono: true,
        showsDefault: 'prompt_draft_system',
      },
    ],
  },
  wrappers: {
    title: 'Data-injection wrappers',
    blurbHtml:
      'Templates that wrap each piece of injected data (voice profile, contact info, calendar, ' +
      'etc.) before it goes into the system prompt. Each uses <code>{body}</code> for the actual ' +
      'data. Editable for fine-tuning how each block is framed for the model — but breaking these ' +
      'breaks the model\'s ability to use that data correctly.',
    fields: [
      {
        key: 'wrapper_voice_profile',
        label: 'Voice profile wrapper',
        descHtml: 'Wraps the user\'s voice profile. Substitution: <code>{body}</code>.',
        rows: 5,
        mono: true,
        showsDefault: 'wrapper_voice_profile',
      },
      {
        key: 'wrapper_contact_profile',
        label: 'Contact profile wrapper',
        descHtml: 'Wraps the per-contact profile prose. Substitution: <code>{body}</code>.',
        rows: 5,
        mono: true,
        showsDefault: 'wrapper_contact_profile',
      },
      {
        key: 'wrapper_address_book',
        label: 'Address book wrapper',
        descHtml: 'Wraps the macOS Contacts.app data block. Substitution: <code>{body}</code>.',
        rows: 5,
        mono: true,
        showsDefault: 'wrapper_address_book',
      },
      {
        key: 'wrapper_calendar',
        label: 'Calendar wrapper',
        descHtml: 'Wraps the macOS Calendar.app availability block. Substitution: <code>{body}</code>.',
        rows: 5,
        mono: true,
        showsDefault: 'wrapper_calendar',
      },
      {
        key: 'wrapper_contact_notes',
        label: 'Contact notes wrapper',
        descHtml: 'Wraps the per-contact short-note bullets. Substitution: <code>{body}</code>.',
        rows: 4,
        mono: true,
        showsDefault: 'wrapper_contact_notes',
      },
      {
        key: 'wrapper_temperament',
        label: 'Temperament wrapper',
        descHtml:
          'Wraps the temperament-override block (only injected when temperament ≠ normal). ' +
          'Substitutions: <code>{temperament}</code>, <code>{guidance}</code>.',
        rows: 4,
        mono: true,
        showsDefault: 'wrapper_temperament',
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

  // Optional "Built-in default" collapsible — rendered when the field's
  // registry entry sets showsDefault to a key that exists in promptDefaults.
  // The pane shows the actual default text the AI layer will use when this
  // field is empty, so the user can SEE what's running and copy/edit if they
  // want to override.
  let defaultPane = '';
  if (f.showsDefault && promptDefaults[f.showsDefault]) {
    const defaultText = promptDefaults[f.showsDefault];
    defaultPane = `
      <details style="margin-top: 6px;">
        <summary style="cursor: pointer; font-size: 11px; color: var(--text-faint); padding: 4px 0;">
          Show built-in default (${defaultText.length} chars) — read-only
        </summary>
        <pre style="background: var(--bg-faint); padding: 10px; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; white-space: pre-wrap; word-break: break-word; margin: 6px 0 0 0; max-height: 320px; overflow-y: auto;">${escapeHtml(defaultText)}</pre>
      </details>
    `;
  }

  return `
    <div class="config-field">
      <label class="config-label">
        ${escapeHtml(f.label)}
        <span class="desc">${desc}</span>
      </label>
      <textarea name="${escapeHtml(f.key)}" rows="${f.rows}"${placeholder}${monoStyle}>${escapeHtml(value)}</textarea>
      ${defaultPane}
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

/* ---------- placeholder reference panel ---------- */
//
// Single source of truth for what {placeholders} are available in every
// editable prompt template. Every entry below works in EVERY field —
// the AI layer applies one uniform substitution context to all templates.
// Adding a placeholder = appending an entry here AND a key in
// buildPlaceholderContext() in server/ai.ts.

const PLACEHOLDER_REFERENCE = [
  {
    key: 'messages',
    renders: 'The full thread (last N messages, oldest → newest, with "me:" / "them:" speakers).',
    notes:
      'When this placeholder appears anywhere in the system prompt, the thread is substituted there and is NOT also sent as a separate user message — you control where the conversation appears.',
  },
  {
    key: 'recipientName',
    renders: 'The contact\'s display name (or their handle if no name is on file).',
    notes: 'In the manual-draft endpoint, falls back to the chat handle if no name resolves.',
  },
  {
    key: 'userName',
    renders: 'Your display name. Currently always renders as <code>the user</code> — first-party self-name isn\'t tracked yet.',
    notes: '',
  },
  {
    key: 'persona',
    renders: 'The <code>away_persona</code> setting from this page.',
    notes: 'Empty string when no persona is set or when the call is in summon / manual-draft context.',
  },
  {
    key: 'voice_profile',
    renders: 'The voice profile being used for THIS call: <code>galt_voice_profile</code> in summon mode, your <code>voice_profile</code> in away / manual draft.',
    notes: 'Same content the wrapper_voice_profile would inject. If you reference this AND keep wrapper_voice_profile non-empty, the voice profile appears twice — your call.',
  },
  {
    key: 'contact_profile',
    renders: 'The per-contact prose profile.',
    notes: 'Empty when no profile has been written for this contact.',
  },
  {
    key: 'address_book',
    renders: 'macOS Contacts.app data for this contact (role, birthday, free-form notes).',
    notes: 'Empty when no AddressBook entry exists.',
  },
  {
    key: 'calendar',
    renders: 'Your availability for the period around now (events from macOS Calendar.app).',
    notes: 'Empty when no events are in the window.',
  },
  {
    key: 'contact_notes',
    renders: 'Per-contact short-note bullets (one per line, prefixed with "- ").',
    notes: 'Empty when no notes exist for this contact.',
  },
  {
    key: 'temperament',
    renders: 'Current temperament name: <code>normal</code>, <code>blunt</code>, <code>warm</code>, etc.',
    notes: '',
  },
  {
    key: 'guidance',
    renders: 'Style guidance text that maps to the current temperament.',
    notes: 'Empty when temperament is <code>normal</code>.',
  },
  {
    key: 'body',
    renders: 'The data being wrapped — voice profile text, calendar block, contact notes, etc.',
    notes:
      'ONLY meaningful inside data-injection wrapper templates. Empty everywhere else. (The wrapper\'s job is to frame this content for the model — that\'s why each wrapper has its own template.)',
  },
];

function renderPlaceholdersPanel() {
  const rows = PLACEHOLDER_REFERENCE.map((p) => `
    <tr>
      <td style="padding: 8px 14px 8px 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; vertical-align: top; white-space: nowrap;"><code>{${escapeHtml(p.key)}}</code></td>
      <td style="padding: 8px 14px 8px 0; font-size: 12px; vertical-align: top;">${p.renders}</td>
      <td style="padding: 8px 0; font-size: 11px; color: var(--text-faint); vertical-align: top;">${p.notes}</td>
    </tr>
  `).join('');
  return `
    <section class="away-section">
      <details class="away-collapsible" open>
        <summary>
          <span>Available placeholders</span>
          <span class="config-summary-meta">${PLACEHOLDER_REFERENCE.length} variables · usable in every prompt below</span>
        </summary>
        <div class="desc" style="margin: 0 0 14px 0; max-width: 720px;">
          Every <code>{placeholder}</code> below is substituted in <em>every</em> editable
          prompt field on this page, with the same data, applied uniformly. Use them
          freely — empty data renders as nothing, so referencing a placeholder that has
          no data this turn just collapses out.
        </div>
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="border-bottom: 1px solid var(--border);">
              <th style="text-align: left; padding: 6px 14px 6px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-faint);">Placeholder</th>
              <th style="text-align: left; padding: 6px 14px 6px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-faint);">Renders to</th>
              <th style="text-align: left; padding: 6px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-faint);">Notes</th>
            </tr>
          </thead>
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
    subHTML: '<span class="accent">prompts</span> · every user-editable prompt that the AI layer assembles · system / account config on <a href="#/settings">Settings</a>',
  });
  const list = document.getElementById('drafts-list');
  if (!list) return;

  // Pull fresh settings + prompt defaults so each field renders with its
  // current value AND the read-only built-in default below it.
  await refreshSettings();

  list.innerHTML = `
    <div class="desc" style="padding: 4px 0 18px 0; max-width: 720px;">
      Every prompt fragment the AI layer ships with is exposed below. An
      empty textarea means the built-in default (collapsible under each
      field) is what runs. Type anything and your text replaces the
      default — with <code>{placeholder}</code> substitution applied
      uniformly across every field (see the reference panel below).
      Mode-level settings (toggle, trigger phrase, contact whitelist, etc.)
      live on <a href="#/away">Away</a> and <a href="#/summon">Summon</a>.
      OpenAI key, model, AI context window, and your voice profile live
      on <a href="#/settings">Settings</a>.
    </div>

    ${renderPlaceholdersPanel()}

    ${renderPromptSection('away')}
    ${renderPromptSection('summon')}
    ${renderPromptSection('universal')}
    ${renderPromptSection('wrappers')}
  `;
}
