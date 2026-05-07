// Away mode view — opt-in auto-responder.
//
// Layout philosophy: this page is read way more often than it's edited. The
// daily flow is "is anything happening with the auto-responder?" — so active
// sessions live at the top. Configuration (greeting / persona / safety cap /
// contacts) lives in a collapsed <details> at the bottom. The follow-up
// notes queue used to live here too, but graduated to its own first-class
// page (see views/auto-notes.js); auto-note extraction runs 24/7 now,
// independent of away mode.

import { api } from '../api.js';
import { setMainHeader } from '../shell.js';
import { escapeHtml, initials, avatarClass } from '../utils.js';
import {
  settingsCache, settingsBounds,
} from '../state.js';
import { renderSessionCard } from '../components/session-card.js';

/* renderSessionRow lives in components/session-card.js — pass kind: 'away'. */

/* ---------- contact row in the configuration whitelist ---------- */
function renderAwayContact(c) {
  const name = c.contact_name || c.label || c.handle;
  const av = avatarClass(c.handle);
  const init = initials(c.contact_name, c.label, c.handle);
  return `
    <div class="contact-row" data-away-id="${c.id}" title="${escapeHtml(c.handle)}">
      <div class="avatar ${av}">${escapeHtml(init)}</div>
      <div class="contact-name">${escapeHtml(name)}</div>
      <span class="contact-toggle ${c.enabled ? 'on' : 'off'}" data-action="toggle-away-contact" data-id="${c.id}" data-enabled="${c.enabled}" title="click to toggle">${c.enabled ? 'on' : 'off'}</span>
      <span class="row-remove" data-action="remove-away-contact" data-id="${c.id}" title="remove">✕</span>
    </div>
  `;
}

/* ---------- top-of-page status banner ---------- */
function renderStatusBanner(enabled, activeCount) {
  const statsLine = activeCount > 0
    ? `<span class="status-stats"><span class="stat-active">${activeCount} active session${activeCount === 1 ? '' : 's'}</span></span>`
    : '<span class="status-stats muted">nothing happening right now</span>';

  return `
    <div class="away-status ${enabled ? 'on' : 'off'}">
      <div class="away-status-text">
        <div class="away-status-title">
          ${enabled
            ? '<span class="dot pulse"></span> Away mode is <strong>ON</strong>'
            : '<span class="dot"></span> Away mode is <strong>off</strong>'}
        </div>
        <div class="away-status-sub">
          ${enabled
            ? 'Auto-responding for opted-in contacts'
            : 'Toggle on when you want the AI to cover for you'}
          · ${statsLine}
        </div>
      </div>
      <div class="away-toggle-switch ${enabled ? 'on' : ''}" data-action="toggle-away-mode" title="${enabled ? 'turn off' : 'turn on'}"></div>
    </div>
  `;
}

/* ---------- active sessions panel (only renders when any are active) ---------- */
function renderActiveSessionsPanel(active) {
  if (active.length === 0) return '';
  return `
    <section class="away-section away-active-sessions">
      <h3>
        <span>Active sessions</span>
        <span class="count">${active.length}</span>
      </h3>
      <div class="away-active-list">
        ${active.map((s) => renderSessionCard(s, { kind: 'away' })).join('')}
      </div>
    </section>
  `;
}

/* ---------- past sessions (collapsed by default) ---------- */
function renderPastSessionsPanel(past) {
  if (past.length === 0) return '';
  return `
    <section class="away-section away-past-sessions">
      <details class="away-collapsible">
        <summary>
          <span>Past sessions</span>
          <span class="count">${past.length}</span>
        </summary>
        <div class="away-past-list">
          ${past.map((s) => renderSessionCard(s, { kind: 'away', compact: true })).join('')}
        </div>
      </details>
    </section>
  `;
}

/* ---------- configuration (collapsed by default) ---------- */
function renderConfigPanel(contacts) {
  const max = settingsBounds.away_max_replies_per_session?.max || 200;
  const min = settingsBounds.away_max_replies_per_session?.min || 1;

  const contactList = contacts.length === 0
    ? '<div class="empty-row">no contacts opted in yet — only listed contacts get auto-responded</div>'
    : contacts.map(renderAwayContact).join('');

  return `
    <section class="away-section">
      <details class="away-collapsible">
        <summary>
          <span>Away mode configuration</span>
          <span class="config-summary-meta">greeting · persona · safety cap · ${contacts.length} contact${contacts.length === 1 ? '' : 's'}</span>
        </summary>

        <div class="away-config-grid">
          <form class="away-config-form" data-form="away-config">
            <div class="config-field">
              <label class="config-label">
                Greeting
                <span class="desc">first canned reply when an opted-in contact messages</span>
              </label>
              <textarea name="away_message" rows="3">${escapeHtml(settingsCache.away_message || '')}</textarea>
            </div>

            <div class="config-field">
              <label class="config-label">
                Persona
                <span class="desc">how the AI should behave while covering — banter, deflection, jokes (separate from voice profile, which captures HOW you write)</span>
              </label>
              <textarea name="away_persona" rows="5" placeholder="e.g. 'be casual and a little snarky — lean into the AI thing if anyone asks. crack small jokes. ask follow-ups when curious.'">${escapeHtml(settingsCache.away_persona || '')}</textarea>
            </div>

            <div class="config-field">
              <label class="config-label">
                Safety cap
                <span class="desc">max AI replies per session before it auto-ends</span>
              </label>
              <div class="config-inline">
                <input type="number" name="away_max_replies_per_session" min="${min}" max="${max}" value="${settingsCache.away_max_replies_per_session}" />
                <span class="desc">replies per session</span>
              </div>
            </div>

            <div class="config-field">
              <label class="config-label">
                Realistic send delay
                <span class="desc">insert a humanizing pause (a few seconds, scaled by reply length) before each auto-send so it doesn't feel robotically instant. Aborts if you reply yourself during the delay.</span>
              </label>
              <label class="config-inline" style="cursor:pointer;">
                <input type="checkbox" name="away_send_delay_enabled" ${settingsCache.away_send_delay_enabled ? 'checked' : ''} />
                <span class="desc">on (recommended)</span>
              </label>
            </div>

            <div class="config-actions">
              <button type="submit" class="btn primary">Save changes</button>
              <span class="settings-status" data-error></span>
            </div>
          </form>

          <div class="away-contacts-block">
            <div class="config-label">
              Whitelisted contacts
              <span class="desc">only these get auto-responded</span>
            </div>
            <div id="away-contacts-list" class="away-contacts-list">${contactList}</div>
            <button class="add-btn" data-action="show-form" data-target="form-away-contact">+ add contact</button>
            <form class="form" id="form-away-contact" data-form="away-contact">
              <input type="text" name="handle" data-contact-autocomplete placeholder="search by name or paste handle" required autocomplete="off" />
              <input type="text" name="label" placeholder="label (optional)" autocomplete="off" />
              <div class="form-row">
                <button type="submit" class="btn primary">Add</button>
                <button type="button" class="btn ghost" data-action="hide-form" data-target="form-away-contact">Cancel</button>
              </div>
              <div class="form-error" data-error></div>
            </form>
          </div>
        </div>
      </details>
    </section>
  `;
}

export async function renderAwayView() {
  const enabled = !!settingsCache.away_mode_enabled;
  setMainHeader({
    title: 'Away mode',
    subHTML: enabled
      ? '<span class="accent" style="color: var(--yellow);">● ACTIVE</span> · the AI is auto-responding for opted-in contacts'
      : '<span class="accent">off</span> · auto-responder is disabled',
  });
  const list = document.getElementById('drafts-list');
  if (!list) return;

  let contacts = [];
  let sessions = [];
  try {
    const [c, s] = await Promise.all([
      api('/api/away/contacts'),
      api('/api/away/sessions?limit=100'),
    ]);
    contacts = c.contacts || [];
    sessions = s.sessions || [];
  } catch (err) {
    list.innerHTML = `<div class="empty"><div class="empty-title">Failed to load.</div><div class="empty-sub">${escapeHtml(err.message)}</div></div>`;
    return;
  }

  const activeSessions = sessions.filter((s) => s.status !== 'ended');
  const pastSessions = sessions.filter((s) => s.status === 'ended').slice(0, 30);

  list.innerHTML = `
    ${renderStatusBanner(enabled, activeSessions.length)}
    ${renderActiveSessionsPanel(activeSessions)}
    ${renderPastSessionsPanel(pastSessions)}
    ${renderConfigPanel(contacts)}
  `;
}

export function updateAwayPill() {
  const pill = document.getElementById('pill-away');
  const on = !!settingsCache.away_mode_enabled;
  if (pill) pill.style.display = on ? '' : 'none';
  updateAwayNavBadge();
}

/** Sidebar nav badge shows 'on' when away mode is active, hidden otherwise.
 *  Auto-note count badging moved to its own nav item — see auto-notes.js. */
export function updateAwayNavBadge() {
  const navBadge = document.getElementById('nav-away-badge');
  if (!navBadge) return;
  const on = !!settingsCache.away_mode_enabled;
  if (on) {
    navBadge.style.display = '';
    navBadge.textContent = 'on';
    navBadge.style.background = 'var(--yellow)';
    navBadge.style.color = '#0a0c10';
    navBadge.title = 'away mode is on';
  } else {
    navBadge.style.display = 'none';
  }
}
