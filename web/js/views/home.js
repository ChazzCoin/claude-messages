// Home — operational dashboard. Layout and visual language ported from
// the V9 mockup: warm-dark palette, amber accent, uppercase + tracked
// labels, monospace tag pills, urgency stripes on flag rows.
//
// Panels (top → bottom):
//   - Greeting block (eyebrow + day headline)
//   - Stat strip      (· N unreviewed · M flags · K pending events)
//   - Switches        (Notes + Summon toggles)
//   - Away            (toggle + away message editor in one card)
//   - Summon sessions (active sessions or trigger-phrase reminder)
//   - Notes / Search  (side-by-side: triage queue + chat.db search)
//   - Upcoming events (5 most recent pending calendar proposals)
//   - Flags           (top unreviewed monitor-rule matches)
//   - Recent threads  (top 6 chats)
//   - Scheduled sends (queued outbound)
//
// Data is pulled in parallel; the page paints once when all promises
// resolve. Most actions on this page reuse existing data-action handlers.

import { api } from '../api.js';
import { setMainHeader } from '../shell.js';
import { escapeHtml, initials, avatarClass, relTime } from '../utils.js';
import { settingsCache, setChatsCache } from '../state.js';

// ----- helpers -------------------------------------------------------

function timeOfDayGreeting(d) {
  const h = d.getHours();
  if (h < 5)  return 'Up late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function dayHeadline(d) {
  const day  = d.toLocaleDateString(undefined, { weekday: 'long' });
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return { day, date };
}

function fmtSchedTime(ms) {
  const dt = ms - Date.now();
  const abs = Math.abs(dt);
  const mins = Math.round(abs / 60000);
  if (mins < 60)  return (dt < 0 ? 'overdue ' : 'in ') + mins + 'm';
  const hrs = Math.round(mins / 60);
  if (hrs < 24)   return (dt < 0 ? 'overdue ' : 'in ') + hrs + 'h';
  const days = Math.round(hrs / 24);
  return (dt < 0 ? 'overdue ' : 'in ') + days + 'd';
}

function flagSeverity(conf) {
  if (typeof conf !== 'number') return 'high';
  if (conf >= 0.85) return 'urgent';
  if (conf >= 0.6)  return 'high';
  return 'medium';
}

// Categorize an auto-note for tag styling. Best-effort — falls back
// gracefully when the category string is unfamiliar.
function tagClass(category) {
  if (!category) return '';
  const c = category.toLowerCase();
  if (c.includes('urgent'))     return 'urgent';
  if (c.includes('request'))    return 'request';
  if (c.includes('commit'))     return 'commitment';
  if (c.includes('plan'))       return 'plan';
  if (c.includes('question'))   return 'question';
  return '';
}

// ----- rows ---------------------------------------------------------

function autoNoteRow(n) {
  const sender = n.contact_name || n.handle;
  const time = relTime(n.created_at);
  const tcls = tagClass(n.category);
  return `
    <div class="v9-row" data-note-id="${n.id}">
      <div class="v9-row-body">
        <span class="v9-tag ${tcls}">${escapeHtml(n.category || 'note')}</span>
        <div class="v9-row-text">${escapeHtml(n.summary || '')}</div>
        <div class="v9-row-from">from <span class="name">${escapeHtml(sender || '(unknown)')}</span></div>
      </div>
      <div class="v9-row-meta">
        <span class="v9-row-time">${escapeHtml(time)}</span>
        <div class="v9-actions">
          <button class="v9-btn subtle" data-action="review-auto-note" data-id="${n.id}">Reviewed</button>
          <button class="v9-btn" data-action="open-thread-by-handle" data-handle="${escapeHtml(n.handle || '')}">Open</button>
        </div>
      </div>
    </div>
  `;
}

function calEventRow(p) {
  const sender = p.contact_name || p.handle;
  // Format the date into stacked "day name + month/day" + time
  const start = new Date(p.start_ms || Date.now());
  const dayLine = start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const timeLine = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(' ', '');
  return `
    <div class="v9-cal-row" data-cal-id="${p.id}">
      <div class="v9-cal-when">
        ${escapeHtml(dayLine)}
        <span class="time">${escapeHtml(timeLine)}</span>
      </div>
      <div class="v9-cal-text">
        <div class="v9-cal-title">${escapeHtml(p.title || 'Event')}</div>
        <div class="v9-cal-meta">
          ${escapeHtml(sender || '')}${p.location ? ' · ' + escapeHtml(p.location) : ''}
        </div>
      </div>
      <div class="v9-actions">
        <button class="v9-btn primary" data-action="cal-export" data-id="${p.id}">Add</button>
        <button class="v9-btn" data-action="cal-dismiss" data-id="${p.id}">Skip</button>
      </div>
    </div>
  `;
}

function flagRow(f) {
  const sev = flagSeverity(f.confidence);
  const sender = f.contact_name || f.handle || '(unknown)';
  const time = relTime(f.flagged_at);
  const conf = typeof f.confidence === 'number' ? f.confidence.toFixed(2) : '';
  const ruleLabel = (f.rule_name || 'flag').toLowerCase().replace(/\s+/g, '_');
  return `
    <div class="v9-flag-row ${sev}" data-flag-id="${f.id}">
      <div class="v9-row-body">
        <div class="v9-flag-head">
          <span class="v9-tag urgent">${escapeHtml(ruleLabel)}</span>
          ${conf ? `<span class="v9-tag score">${escapeHtml(conf)}</span>` : ''}
          <span class="v9-row-time">${escapeHtml(time)}</span>
        </div>
        <div class="v9-row-from">from <span class="name">${escapeHtml(sender)}</span></div>
        <div class="v9-row-quote">${escapeHtml(f.text || '')}</div>
      </div>
      <div class="v9-row-meta">
        <div class="v9-actions">
          <button class="v9-btn primary" data-action="open-thread" data-chat-id="${f.chat_id}">Open thread</button>
          <button class="v9-btn subtle" data-action="review-flag" data-id="${f.id}">Reviewed</button>
        </div>
      </div>
    </div>
  `;
}

function threadRow(c) {
  const name = c.contact_name || c.display_name || c.identifier || '(unknown)';
  const seed = c.identifier || c.guid || String(c.id);
  const av = avatarClass(seed);
  const init = initials(c.contact_name, c.display_name, c.identifier);
  const time = relTime(c.last_date_ms);
  const previewText = c.last_text
    ? (c.last_is_from_me ? 'You: ' : '') + c.last_text
    : '';
  const unread = !c.last_is_from_me && c.unread_count > 0;
  return `
    <div class="v9-thread-row" data-action="open-thread" data-chat-id="${c.id}">
      <div class="avatar ${av}">${escapeHtml(init)}</div>
      <div class="v9-thread-text">
        <div class="v9-thread-head">
          <span class="v9-thread-name">${escapeHtml(name)}</span>
          <span class="v9-thread-time">${escapeHtml(time)}</span>
        </div>
        ${previewText ? `<div class="v9-thread-preview">${escapeHtml(previewText)}</div>` : ''}
      </div>
      ${unread ? '<span class="v9-thread-unread-dot"></span>' : '<span></span>'}
    </div>
  `;
}

function schedRow(s) {
  const due = s.status === 'pending' && s.send_at <= Date.now() + 60_000;
  const recipient = s.contact_name || s.handle || '(unknown)';
  const when = fmtSchedTime(s.send_at);
  return `
    <div class="v9-sched-row" data-sched-id="${s.id}">
      <div>
        <div class="v9-sched-head">
          <span class="v9-sched-when ${due ? 'due' : ''}">${escapeHtml(when)}${due ? ' · due' : ''}</span>
          <span class="v9-sched-status">${escapeHtml(s.status)}</span>
        </div>
        <div class="v9-row-from">to <span class="name">${escapeHtml(recipient)}</span></div>
        <div class="v9-sched-body">${escapeHtml(s.body || '')}</div>
      </div>
      <div class="v9-row-meta">
        <div class="v9-actions">
          <button class="v9-btn" data-action="open-scheduled">Edit</button>
          <button class="v9-btn subtle" data-action="cancel-sched" data-id="${s.id}">Cancel</button>
        </div>
      </div>
    </div>
  `;
}

// ----- switches panel (Notes / Summon / Away / future) ---------------
// Single source of truth for the global mode toggles. Pattern is borrowed
// from frontend/galt-messages — each switch is an icon-card with an
// ON/OFF badge and amber-tinted active state. Adding a new switch is
// just a new entry in the SWITCHES array; the layout grid auto-fills.

// Away has its own composite panel (toggle + message editor). It used
// to live here as the third entry; now `awayPanel()` owns it so the
// "what does Galt say when I'm away?" answer is one card away from the
// toggle that triggers it.
const SWITCHES = [
  {
    key: 'auto_notes_enabled',
    label: 'Notes',
    sub: '24/7 inbound triage',
    action: 'toggle-auto-notes',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>`,
  },
  {
    key: 'summon_enabled',
    label: 'Summon',
    sub: 'trigger phrase to invoke',
    action: 'toggle-summon-mode',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M2 12a10 10 0 0 1 20 0"/><path d="M5 12a7 7 0 0 1 14 0"/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>`,
  },
  // Add new switches here. Each entry needs a settingsCache key,
  // a data-action handler in actions.js, and an inline-SVG icon.
];

function switchCard({ key, label, sub, action, icon }) {
  const on = !!settingsCache[key];
  return `
    <button class="v9-toggle" data-on="${on}" data-action="${action}" type="button" aria-pressed="${on}">
      <div class="v9-toggle-top">
        <div class="v9-toggle-icon">${icon}</div>
        <div class="v9-toggle-badge">${on ? 'ON' : 'OFF'}</div>
      </div>
      <div class="v9-toggle-label">${escapeHtml(label)}</div>
      <div class="v9-toggle-sub">${escapeHtml(sub)}</div>
    </button>
  `;
}

function switchesPanel() {
  const onCount = SWITCHES.filter((s) => settingsCache[s.key]).length;
  return `
    <div class="v9-panel">
      <div class="v9-panel-head">
        <div class="v9-panel-title">
          Switches
          <span class="v9-panel-count">${onCount} of ${SWITCHES.length} on</span>
        </div>
        <a class="v9-panel-link" data-action="open-settings">all settings →</a>
      </div>
      <div class="v9-toggle-grid">
        ${SWITCHES.map(switchCard).join('')}
      </div>
    </div>
  `;
}

// Composite Away panel — toggle + message editor in one card. Toggle is
// the inline iOS-style switch so the action is unambiguous (clicking the
// header toggles; the textarea stays a separate editable surface). When
// off the textarea is still editable so the user can prep the message
// before flipping on.
function awayPanel() {
  const on = !!settingsCache.away_mode_enabled;
  const greeting = settingsCache.away_message || '';
  const awayIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
  return `
    <div class="v9-panel v9-away-panel" data-on="${on}">
      <div class="v9-away-head">
        <div class="v9-away-head-text">
          <div class="v9-away-head-icon">${awayIcon}</div>
          <div>
            <div class="v9-panel-title">
              Away
              <span class="v9-panel-count ${on ? '' : 'muted'}">${on ? 'ON' : 'OFF'}</span>
            </div>
            <div class="v9-away-sub">auto-respond for opted-in contacts</div>
          </div>
        </div>
        <button type="button"
                class="v9-switch ${on ? 'on' : ''}"
                data-action="toggle-away-mode"
                aria-pressed="${on}"
                title="${on ? 'turn off' : 'turn on'}">
          <span class="v9-switch-thumb"></span>
        </button>
      </div>
      <form class="v9-away-edit" data-form="away-greeting">
        <textarea name="away_message" rows="3" placeholder="Heads down today — I'll catch up tonight.">${escapeHtml(greeting)}</textarea>
        <div class="v9-away-foot">
          <button type="submit" class="v9-btn primary">Save message</button>
          <a class="v9-panel-link" data-action="open-away">configure →</a>
          <span class="settings-status" data-error></span>
        </div>
      </form>
    </div>
  `;
}

// Active summon sessions — only visible when Galt is in conversation.
// When idle, surface the trigger phrases so the user remembers them.
function summonSessionsPanel(activeSessions) {
  const trigger = settingsCache.summon_trigger_phrase || 'GALT!!';
  const endP    = settingsCache.summon_end_phrase    || 'go away galt';
  if (activeSessions.length === 0) {
    return `
      <div class="v9-panel">
        <div class="v9-panel-head">
          <div class="v9-panel-title">
            Summon sessions
            <span class="v9-panel-count muted">idle</span>
          </div>
          <a class="v9-panel-link" data-action="open-summon">configure →</a>
        </div>
        <div class="v9-empty">
          <code>${escapeHtml(trigger)}</code> to invoke ·
          <code>${escapeHtml(endP)}</code> to dismiss
        </div>
      </div>
    `;
  }
  return `
    <div class="v9-panel">
      <div class="v9-panel-head">
        <div class="v9-panel-title">
          Summon sessions
          <span class="v9-panel-count">${activeSessions.length} active</span>
        </div>
        <a class="v9-panel-link" data-action="open-summon">configure →</a>
      </div>
      ${activeSessions.map((s) => `
        <div class="v9-session-row">
          <span class="session-pulse"></span>
          <div>
            <div class="v9-session-name">${escapeHtml(s.contact_name || s.handle)}</div>
            <div class="v9-session-meta">${s.ai_reply_count} ${s.ai_reply_count === 1 ? 'reply' : 'replies'} · ${((Date.now() - s.started_at) / 60000).toFixed(0)}m ago</div>
          </div>
          <button class="v9-btn" data-action="end-summon-session" data-id="${s.id}">End</button>
        </div>
      `).join('')}
    </div>
  `;
}

// ----- main render ---------------------------------------------------

export async function renderHomeView() {
  // Hide the legacy main-header — V9 home owns the top of the page.
  setMainHeader({ title: '', subHTML: '' });
  document.querySelector('.main')?.classList.add('home-v9-active');

  const list = document.getElementById('drafts-list');
  if (!list) return;
  list.innerHTML = '<div class="empty"><div class="empty-title">loading…</div></div>';

  // Pull everything in parallel — page paints once when all resolve.
  // Some endpoints may not exist on older builds; tolerate failures.
  let chats = [], notes = [], proposals = [], activeSummon = [];
  let flags = [], scheduled = [];
  try {
    const results = await Promise.allSettled([
      api('/api/chats?limit=6'),
      api('/api/auto-notes?reviewed=false&limit=5'),
      api('/api/calendar/proposals?status=pending&limit=5'),
      api('/api/summon/sessions?active=true&limit=20'),
      api('/api/monitor/flags?reviewed=false&limit=4'),
      api('/api/scheduled?status=pending'),
    ]);
    const [c, n, cal, summ, fl, sc] = results;
    if (c.status === 'fulfilled')    chats        = c.value.chats || [];
    if (n.status === 'fulfilled')    notes        = n.value.notes || [];
    if (cal.status === 'fulfilled')  proposals    = cal.value.proposals || [];
    if (summ.status === 'fulfilled') activeSummon = summ.value.sessions || [];
    if (fl.status === 'fulfilled')   flags        = fl.value.flags || [];
    if (sc.status === 'fulfilled')   scheduled    = sc.value.scheduled || [];
    if (chats.length) setChatsCache(chats);
  } catch (err) {
    list.innerHTML = `<div class="empty"><div class="empty-title">Failed to load.</div><div class="empty-sub">${escapeHtml(err.message)}</div></div>`;
    return;
  }

  // ---- greeting ----
  const now = new Date();
  const eyebrow = `${timeOfDayGreeting(now)}, Chazz`;
  const { day, date } = dayHeadline(now);

  // ---- stat strip ----
  const unreviewedNotes = notes.length;
  const flagCount       = flags.length;
  const eventCount      = proposals.length;
  const schedCount      = scheduled.length;
  const stats = [
    `<span class="stat-name">Galt / Home</span>`,
    `<span class="stat-sep">·</span>`,
    `<span><span class="stat-num amber">${unreviewedNotes}</span> unreviewed</span>`,
    `<span class="stat-sep">·</span>`,
    `<span><span class="stat-num red">${flagCount}</span> flags</span>`,
    `<span class="stat-sep">·</span>`,
    `<span><span class="stat-num">${eventCount}</span> pending events</span>`,
  ].join('');

  // ---- panel bodies ----
  const notesBlock = notes.length === 0
    ? '<div class="v9-empty">no unreviewed notes — all caught up</div>'
    : notes.map(autoNoteRow).join('');
  const calBlock = proposals.length === 0
    ? '<div class="v9-empty">no upcoming events</div>'
    : proposals.map(calEventRow).join('');
  const flagBlock = flags.length === 0
    ? '<div class="v9-empty">no unreviewed flags</div>'
    : flags.map(flagRow).join('');
  const threadsBlock = chats.length === 0
    ? '<div class="v9-empty">no chats found — chat.db may not be readable yet</div>'
    : chats.map(threadRow).join('');
  const schedBlock = scheduled.length === 0
    ? '<div class="v9-empty">no scheduled messages — outbound queue is empty</div>'
    : scheduled.slice(0, 4).map(schedRow).join('');

  // ---- assemble page ----
  list.innerHTML = `
    <div class="home-v9">

      <div class="home-v9-top">
        <div class="home-v9-greet">
          <div class="home-v9-eyebrow">${escapeHtml(eyebrow)}</div>
          <div class="home-v9-day">${escapeHtml(day)} <span class="accent">· ${escapeHtml(date)}</span></div>
        </div>
      </div>

      <div class="home-v9-stats">${stats}</div>

      <div class="home-v9-grid">

        ${switchesPanel()}

        ${awayPanel()}

        <div class="v9-panel">
          <div class="v9-panel-head">
            <div class="v9-panel-title">Search chat.db</div>
            <span class="v9-panel-link">2+ chars · LIKE search</span>
          </div>
          <div class="search-view">
            <input type="search" class="search-input" id="search-input" placeholder="Search all messages…" autocomplete="off" />
            <div class="search-status" id="search-status"></div>
            <div class="search-results" id="search-results"></div>
          </div>
        </div>

        <div class="v9-panel">
          <div class="v9-panel-head">
            <div class="v9-panel-title">
              Notes
              <span class="v9-panel-count">${unreviewedNotes} unreviewed</span>
            </div>
            <a class="v9-panel-link" data-action="open-auto-notes">all notes →</a>
          </div>
          ${notesBlock}
        </div>

        ${summonSessionsPanel(activeSummon)}

        <div class="v9-panel">
          <div class="v9-panel-head">
            <div class="v9-panel-title">
              Upcoming events
              <span class="v9-panel-count">${eventCount} pending</span>
            </div>
            <a class="v9-panel-link" data-action="open-calendar">calendar →</a>
          </div>
          ${calBlock}
        </div>

        <div class="v9-panel">
          <div class="v9-panel-head">
            <div class="v9-panel-title">
              Flags
              <span class="v9-panel-count">${flagCount} unreviewed</span>
            </div>
            <a class="v9-panel-link" data-action="open-flags">all flags →</a>
          </div>
          ${flagBlock}
        </div>

        <div class="v9-panel">
          <div class="v9-panel-head">
            <div class="v9-panel-title">
              Recent threads
              <span class="v9-panel-count muted">${chats.length} shown</span>
            </div>
            <a class="v9-panel-link" data-action="open-inbox">inbox →</a>
          </div>
          ${threadsBlock}
        </div>

        <div class="v9-panel">
          <div class="v9-panel-head">
            <div class="v9-panel-title">
              Scheduled sends
              <span class="v9-panel-count">${schedCount} pending</span>
            </div>
            <a class="v9-panel-link" data-action="open-scheduled">scheduled →</a>
          </div>
          ${schedBlock}
        </div>

      </div>
    </div>
  `;
}

// Cleanup hook — called from the router when leaving home, so other views
// don't inherit the home-only `.home-v9-active` class.
export function teardownHomeView() {
  document.querySelector('.main')?.classList.remove('home-v9-active');
}
