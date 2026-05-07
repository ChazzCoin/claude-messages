// Summon mode view — the page where you toggle Galt's summon-mode master
// switch, configure trigger/end phrases, persona, safety cap + idle timeout,
// and watch / dismiss active summon sessions.
//
// Summon mode is fundamentally different from away mode:
//   away  = Galt covers FOR you (talks AS you when you're gone)
//   summon = Galt joins WITH you (a third voice, "Galt: ..." prefix on each
//            reply) when you type the trigger phrase mid-conversation
//
// They share the send pipeline (echo guard, prefix, delay) but nothing else
// — separate sessions table, separate settings, separate prompt builder,
// and now a separate dashboard page.

import { api } from '../api.js';
import { setMainHeader } from '../shell.js';
import { escapeHtml } from '../utils.js';
import { settingsCache, settingsBounds, setSettingsCache } from '../state.js';
import { renderSessionCard } from '../components/session-card.js';

/* ---------- top status banner ---------- */

function renderStatusBanner(activeCount) {
  const enabled = !!settingsCache.summon_enabled;
  const trigger = settingsCache.summon_trigger_phrase || 'GALT!!';
  const endP = settingsCache.summon_end_phrase || 'go away galt';

  let statusLine;
  if (!enabled) {
    statusLine = '<span style="color:var(--text-faint);">○ disabled</span> · the trigger phrase does nothing while this is off';
  } else if (activeCount > 0) {
    statusLine = `<span class="ok">● ${activeCount} active</span> · Galt is in conversation`;
  } else {
    statusLine = `<span class="ok">● enabled</span> · type <code>${escapeHtml(trigger)}</code> in any chat to invoke Galt · <code>${escapeHtml(endP)}</code> to dismiss`;
  }

  return `
    <div class="away-status ${enabled ? 'on' : ''}">
      <div class="away-status-text">
        <div class="away-status-title">
          ${activeCount > 0
            ? '<span class="dot pulse"></span> Galt is summoned'
            : enabled
              ? '<span class="dot"></span> Summon mode is <strong>ready</strong>'
              : '<span class="dot"></span> Summon mode is <strong>off</strong>'}
        </div>
        <div class="away-status-sub">${statusLine}</div>
      </div>
      <div class="away-toggle-switch ${enabled ? 'on' : ''}" data-action="toggle-summon-mode" title="${enabled ? 'turn off' : 'turn on'}"></div>
    </div>
  `;
}

/* ---------- active sessions panel (only renders when any) ---------- */

function renderActiveSessionsPanel(active) {
  if (active.length === 0) return '';
  return `
    <section class="away-section">
      <h3>
        <span>Active sessions</span>
        <span class="count">${active.length}</span>
      </h3>
      <div class="away-active-list">
        ${active.map((s) => renderSessionCard(s, { kind: 'summon' })).join('')}
      </div>
    </section>
  `;
}

/* ---------- past sessions (collapsed) ---------- */

function renderPastSessionsPanel(past) {
  if (past.length === 0) return '';
  return `
    <section class="away-section">
      <details class="away-collapsible">
        <summary>
          <span>Past sessions</span>
          <span class="count">${past.length}</span>
        </summary>
        <div class="away-past-list">
          ${past.map((s) => renderSessionCard(s, { kind: 'summon', compact: true })).join('')}
        </div>
      </details>
    </section>
  `;
}

/* ---------- configuration form ---------- */

function renderConfigPanel() {
  const max = settingsBounds.summon_max_replies_per_session?.max || 200;
  const min = settingsBounds.summon_max_replies_per_session?.min || 1;
  const idleMax = settingsBounds.summon_idle_timeout_min?.max || 720;
  const idleMin = settingsBounds.summon_idle_timeout_min?.min || 1;

  return `
    <section class="away-section">
      <details class="away-collapsible" open>
        <summary>
          <span>Configuration</span>
          <span class="config-summary-meta">trigger · end phrase · persona · safety cap · idle timeout</span>
        </summary>

        <form class="away-config-form" data-form="summon-config">
          <div class="config-field">
            <label class="config-label">
              Trigger phrase
              <span class="desc">type this anywhere in a message to summon Galt into the chat. Strict, case-sensitive substring match. Default <code>GALT!!</code></span>
            </label>
            <input type="text" name="summon_trigger_phrase" value="${escapeHtml(settingsCache.summon_trigger_phrase || '')}" autocomplete="off" />
          </div>

          <div class="config-field">
            <label class="config-label">
              End phrase
              <span class="desc">type this to dismiss Galt. Case-insensitive substring. Default <code>go away galt</code></span>
            </label>
            <input type="text" name="summon_end_phrase" value="${escapeHtml(settingsCache.summon_end_phrase || '')}" autocomplete="off" />
          </div>

          <div class="config-field">
            <label class="config-label">
              Galt voice profile
              <span class="desc">Prose describing how Galt sounds when he's himself — voice, tone, register, length, quirks, what to avoid. Used here in summon mode (where Galt is a third voice). Distinct from your own voice profile (Settings → Voice profile), which Galt uses when impersonating you in away mode. User-written; no AI generation. Injected as the VOICE PROFILE in the AI's data-injection block.</span>
            </label>
            <textarea name="galt_voice_profile" rows="4" placeholder="e.g. 'direct, no hedging. keep it iMessage-short — usually one line. light dry humor when it fits the moment. don't be a help desk. push back if i'm being dumb.'">${escapeHtml(settingsCache.galt_voice_profile || '')}</textarea>
          </div>

          <div class="config-field">
            <label class="config-label">
              Custom prompt override <span class="desc" style="display:inline; font-weight:normal;">(advanced)</span>
              <span class="desc">When non-empty, REPLACES the entire built-in summon prompt. Write your own instructions for how Galt should behave. The conversation thread, voice profile, and contact context still flow through automatically — this just controls the per-turn behavior instructions. Placeholders <code>{userName}</code> and <code>{recipientName}</code> get substituted at send time. Leave empty to use the built-in.</span>
            </label>
            <textarea name="summon_system_prompt" rows="12" placeholder="(empty — using built-in prompt)" style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;">${escapeHtml(settingsCache.summon_system_prompt || '')}</textarea>
          </div>

          <div class="config-field">
            <label class="config-label">
              Safety cap
              <span class="desc">Galt auto-ends a session after this many replies in it</span>
            </label>
            <div class="config-inline">
              <input type="number" name="summon_max_replies_per_session" min="${min}" max="${max}" value="${settingsCache.summon_max_replies_per_session}" />
              <span class="desc">replies per session</span>
            </div>
          </div>

          <div class="config-field">
            <label class="config-label">
              Idle timeout
              <span class="desc">if no messages flow in the chat for this long, the session auto-ends</span>
            </label>
            <div class="config-inline">
              <input type="number" name="summon_idle_timeout_min" min="${idleMin}" max="${idleMax}" value="${settingsCache.summon_idle_timeout_min}" />
              <span class="desc">minutes</span>
            </div>
          </div>

          <div class="config-actions">
            <button type="submit" class="btn primary">Save changes</button>
            <span class="settings-status" data-error></span>
          </div>
        </form>
      </details>
    </section>
  `;
}

/* ---------- top-level view render ---------- */

export async function renderSummonView() {
  const enabled = !!settingsCache.summon_enabled;
  setMainHeader({
    title: 'Summon',
    subHTML: enabled
      ? `<span class="accent" style="color: var(--green);">● ready</span> · type <code>${escapeHtml(settingsCache.summon_trigger_phrase || 'GALT!!')}</code> to invoke Galt mid-conversation`
      : '<span class="accent">off</span> · master switch is disabled',
  });

  const list = document.getElementById('drafts-list');
  if (!list) return;

  let summonSessions = [];
  try {
    const ss = await api('/api/summon/sessions?limit=100');
    summonSessions = ss.sessions || [];
  } catch (err) {
    list.innerHTML = `<div class="empty"><div class="empty-title">Failed to load.</div><div class="empty-sub">${escapeHtml(err.message)}</div></div>`;
    return;
  }

  const active = summonSessions.filter((s) => s.status === 'active');
  const past = summonSessions.filter((s) => s.status === 'ended').slice(0, 30);

  list.innerHTML = `
    ${renderStatusBanner(active.length)}
    ${renderActiveSessionsPanel(active)}
    ${renderConfigPanel()}
    ${renderPastSessionsPanel(past)}
  `;
}

/* ---------- exposed for SSE re-render ---------- */
export { setSettingsCache };
