// Away mode view — opt-in auto-responder. Includes the canned greeting,
// AI persona, safety cap, whitelisted-contacts list, sessions, and the
// "notes while you were out" follow-up queue.

import { api } from '../api.js';
import { setMainHeader } from '../shell.js';
import { escapeHtml, initials, avatarClass, relTime } from '../utils.js';
import {
  settingsCache, settingsBounds,
  awayUnreviewedNotes, setAwayUnreviewedNotes,
} from '../state.js';

function renderAwayContact(c) {
  const name = c.contact_name || c.label || c.handle;
  const av = avatarClass(c.handle);
  const init = initials(c.contact_name, c.label, c.handle);
  return `
    <div class="contact-row" data-away-id="${c.id}" title="${escapeHtml(c.handle)}">
      <div class="avatar ${av}">${escapeHtml(init)}</div>
      <div class="contact-name">${escapeHtml(name)}</div>
      <span style="font-family: var(--mono); font-size: 11px; color: ${c.enabled ? 'var(--green)' : 'var(--text-faint)'}; margin-left: auto; cursor: pointer;" data-action="toggle-away-contact" data-id="${c.id}" data-enabled="${c.enabled}" title="click to toggle">${c.enabled ? 'on' : 'off'}</span>
      <span class="row-remove" data-action="remove-away-contact" data-id="${c.id}" title="remove">✕</span>
    </div>
  `;
}

function renderAwaySession(s) {
  const name = s.contact_name || s.handle;
  const isActive = s.status !== 'ended';
  const status = s.status === 'greeting_sent' ? 'greeting sent' : s.status;
  return `
    <div class="away-session-item ${isActive ? '' : 'ended'}" data-session-id="${s.id}">
      <div class="session-head">
        <span class="session-name">${escapeHtml(name)}</span>
        <span class="session-meta">${escapeHtml(s.handle)} · started ${escapeHtml(relTime(s.started_at))}</span>
        ${isActive ? `<span class="session-end" data-action="end-away-session" data-id="${s.id}" title="end this session">end</span>` : ''}
      </div>
      <div class="session-stats">
        <span>${escapeHtml(status)}</span>
        <span>${s.ai_reply_count} AI ${s.ai_reply_count === 1 ? 'reply' : 'replies'}</span>
        ${s.last_ai_reply_at ? `<span>last reply ${escapeHtml(relTime(s.last_ai_reply_at))}</span>` : ''}
        ${s.ended_reason ? `<span>· ended: ${escapeHtml(s.ended_reason)}</span>` : ''}
      </div>
    </div>
  `;
}

function renderAwayNoteCard(n) {
  const sender = n.contact_name || n.handle;
  const reviewed = n.reviewed_at != null;
  const time = relTime(n.created_at);
  return `
    <div class="away-note-card ${reviewed ? 'reviewed' : ''}" data-note-id="${n.id}">
      <div class="note-cat ${escapeHtml(n.category)}">${escapeHtml(n.category)}</div>
      <div>
        <div class="note-body">${escapeHtml(n.summary)}</div>
        <div class="note-from">from <span class="name">${escapeHtml(sender)}</span></div>
        ${n.message_text ? `<div class="note-quote">"${escapeHtml(n.message_text)}"</div>` : ''}
        ${n.reasoning ? `<div class="note-reasoning">${escapeHtml(n.reasoning)}</div>` : ''}
      </div>
      <div class="note-meta">${escapeHtml(time)}</div>
      <div class="note-actions">
        ${!reviewed ? `<button class="btn" data-action="review-away-note" data-id="${n.id}">Mark reviewed</button>` : '<span style="font-family:var(--mono);font-size:10.5px;color:var(--text-faint);align-self:center;">reviewed</span>'}
        <button class="btn ghost" data-action="open-thread-by-handle" data-handle="${escapeHtml(n.handle)}">Open thread</button>
        <div class="spacer" style="flex:1;"></div>
        <button class="btn ghost" data-action="delete-away-note" data-id="${n.id}">Delete</button>
      </div>
    </div>
  `;
}

export async function renderAwayView() {
  const enabled = !!settingsCache.away_mode_enabled;
  setMainHeader({
    title: 'Away mode',
    subHTML: enabled
      ? '<span class="accent" style="color: var(--yellow);">● ACTIVE</span> · the AI is auto-responding for opted-in contacts'
      : '<span class="accent">off</span> · auto-responder is disabled',
    showFilters: false,
  });
  const list = document.getElementById('drafts-list');
  if (!list) return;

  let contacts = [];
  let sessions = [];
  let notesData = { notes: [], unreviewed: 0 };
  try {
    const [c, s, n] = await Promise.all([
      api('/api/away/contacts'),
      api('/api/away/sessions?limit=100'),
      api('/api/away/notes?limit=200'),
    ]);
    contacts = c.contacts || [];
    sessions = s.sessions || [];
    notesData = { notes: n.notes || [], unreviewed: n.unreviewed ?? 0 };
    setAwayUnreviewedNotes(notesData.unreviewed);
    updateAwayNavBadge();
  } catch (err) {
    list.innerHTML = `<div class="empty"><div class="empty-title">Failed to load.</div><div class="empty-sub">${escapeHtml(err.message)}</div></div>`;
    return;
  }

  const max = settingsBounds.away_max_replies_per_session?.max || 200;
  const min = settingsBounds.away_max_replies_per_session?.min || 1;

  const contactList = contacts.length === 0
    ? '<div class="empty-row">no contacts whitelisted yet — only opted-in contacts get auto-responded</div>'
    : contacts.map(renderAwayContact).join('');

  const activeSessions = sessions.filter((s) => s.status !== 'ended');
  const pastSessions = sessions.filter((s) => s.status === 'ended').slice(0, 30);
  const sessionList = sessions.length === 0
    ? '<div class="empty-row" style="padding:8px 0;">no sessions yet</div>'
    : [
        ...activeSessions.map(renderAwaySession),
        pastSessions.length > 0 ? `<div style="font-family:var(--mono);font-size:10.5px;color:var(--text-faint);text-transform:uppercase;letter-spacing:0.6px;margin:14px 0 8px;">past · ${pastSessions.length}</div>` : '',
        ...pastSessions.map(renderAwaySession),
      ].join('');

  list.innerHTML = `
    <div class="away-toggle-block ${enabled ? 'on' : ''}">
      <div>
        <div class="away-headline">${enabled ? 'Away mode is ON' : 'Away mode is off'}</div>
        <div class="away-sub ${enabled ? 'on' : ''}">${enabled
          ? 'Opted-in contacts will get auto-responded to — first by the canned greeting, then by AI in your voice. Toggling this off ends every active session.'
          : 'Toggle on to start auto-responding. Only contacts in the whitelist below will be handled.'}</div>
      </div>
      <div class="away-toggle-switch ${enabled ? 'on' : ''}" data-action="toggle-away-mode" title="${enabled ? 'turn off' : 'turn on'}"></div>
    </div>

    <div class="away-grid">
      <form class="away-config" data-form="away-config">
        <h3>Greeting, persona &amp; safety</h3>

        <div style="font-family:var(--mono);font-size:10.5px;color:var(--text-faint);margin-bottom:6px;">first canned reply when an opted-in contact messages</div>
        <textarea name="away_message">${escapeHtml(settingsCache.away_message || '')}</textarea>

        <div style="font-family:var(--mono);font-size:10.5px;color:var(--text-faint);margin: 10px 0 6px;">
          personality &mdash; how the AI should BEHAVE while covering for you (separate from voice profile, which captures HOW you write)
        </div>
        <textarea name="away_persona" placeholder="e.g. 'be casual and a little snarky — lean into the AI thing if anyone asks, never apologize for it. crack small jokes. ask follow-up questions when curious. avoid being polite or formal. don't deflect every time — only when you actually don't know something.'" style="min-height: 110px;">${escapeHtml(settingsCache.away_persona || '')}</textarea>

        <div class="num-row" style="margin-top: 10px;">
          <span>max AI replies per session</span>
          <input type="number" name="away_max_replies_per_session" min="${min}" max="${max}" value="${settingsCache.away_max_replies_per_session}" />
          <span style="color:var(--text-faint);">safety cap; sessions auto-end at this count</span>
        </div>
        <div class="form-row">
          <button type="submit" class="btn primary">Save</button>
          <span class="settings-status" data-error></span>
        </div>
      </form>

      <div>
        <div class="away-config" style="margin-bottom: 12px;">
          <h3>Whitelisted contacts</h3>
          <div id="away-contacts-list">${contactList}</div>
          <button class="add-btn" data-action="show-form" data-target="form-away-contact" style="width:auto;padding:6px 12px;margin-top:8px;">+ add contact</button>
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
    </div>

    <div class="away-sessions-block" style="margin-top:16px;">
      <h3>Sessions ${activeSessions.length > 0 ? `· ${activeSessions.length} active` : ''}</h3>
      ${sessionList}
    </div>

    <div class="away-notes-block">
      <h3>
        <span>Notes while you were out</span>
        ${notesData.unreviewed > 0 ? `<span class="count unreviewed">· ${notesData.unreviewed} unreviewed</span>` : `<span style="color:var(--text-faint);text-transform:none;letter-spacing:0;">· ${notesData.notes.length} total</span>`}
        ${notesData.unreviewed > 0 ? '<span class="review-all" data-action="review-all-away-notes">mark all reviewed</span>' : ''}
      </h3>
      ${notesData.notes.length === 0
        ? '<div class="empty-row" style="padding:8px 0;">no follow-up items yet — the AI logs anything substantive that comes in during away mode (meeting requests, things to discuss, time-sensitive stuff)</div>'
        : notesData.notes.map(renderAwayNoteCard).join('')}
    </div>
  `;
}

export function updateAwayPill() {
  const pill = document.getElementById('pill-away');
  const on = !!settingsCache.away_mode_enabled;
  if (pill) pill.style.display = on ? '' : 'none';
  // Nav badge is now driven by the unreviewed-notes count, not the on/off
  // state. updateAwayNavBadge handles it.
  updateAwayNavBadge();
}

export function updateAwayNavBadge() {
  const navBadge = document.getElementById('nav-away-badge');
  if (!navBadge) return;
  const on = !!settingsCache.away_mode_enabled;
  if (awayUnreviewedNotes > 0) {
    navBadge.style.display = '';
    navBadge.textContent = String(awayUnreviewedNotes);
    navBadge.style.background = 'var(--orange)';
    navBadge.style.color = '#0a0c10';
    navBadge.title = `${awayUnreviewedNotes} unreviewed away note(s)`;
  } else if (on) {
    navBadge.style.display = '';
    navBadge.textContent = 'on';
    navBadge.style.background = 'var(--yellow)';
    navBadge.style.color = '#0a0c10';
    navBadge.title = 'away mode is on';
  } else {
    navBadge.style.display = 'none';
  }
}

export async function refreshAwayNotesBadge() {
  try {
    const r = await api('/api/away/notes?reviewed=false&limit=1');
    setAwayUnreviewedNotes(r.unreviewed ?? 0);
  } catch { setAwayUnreviewedNotes(0); }
  updateAwayNavBadge();
}
