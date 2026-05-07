// Auto Notes — first-class 24/7 inbound-message triage queue.
//
// Runs continuously on every inbound iMessage (mode-agnostic — independent
// of away mode and summon mode). The AI extractor flags substantive items
// the user should personally follow up on (meet requests, decisions to make,
// time-sensitive coordination, important news) and persists them here for
// review.
//
// Page layout: status banner (with master switch) → unreviewed queue →
// reviewed (collapsed) → settings (collapsed). Mirrors the rhythm of the
// away view so users moving between them get a consistent shape.

import { api } from '../api.js';
import { setMainHeader } from '../shell.js';
import { escapeHtml, relTime } from '../utils.js';
import {
  settingsCache,
  autoUnreviewedNotes, setAutoUnreviewedNotes,
} from '../state.js';

/* ---------- one note row in the queue ---------- */
function renderAutoNoteCard(n) {
  const sender = n.contact_name || n.handle;
  const reviewed = n.reviewed_at != null;
  const time = relTime(n.created_at);
  return `
    <div class="auto-note-card ${reviewed ? 'reviewed' : ''}" data-note-id="${n.id}">
      <div class="note-cat ${escapeHtml(n.category)}">${escapeHtml(n.category)}</div>
      <div>
        <div class="note-body">${escapeHtml(n.summary)}</div>
        <div class="note-from">from <span class="name">${escapeHtml(sender)}</span></div>
        ${n.message_text ? `<div class="note-quote">"${escapeHtml(n.message_text)}"</div>` : ''}
        ${n.reasoning ? `<div class="note-reasoning">${escapeHtml(n.reasoning)}</div>` : ''}
      </div>
      <div class="note-meta">${escapeHtml(time)}</div>
      <div class="note-actions">
        ${!reviewed ? `<button class="btn" data-action="review-auto-note" data-id="${n.id}">Mark reviewed</button>` : '<span class="reviewed-tag">reviewed</span>'}
        <button class="btn ghost" data-action="open-thread-by-handle" data-handle="${escapeHtml(n.handle)}">Open thread</button>
        <div class="spacer" style="flex:1;"></div>
        <button class="btn ghost" data-action="delete-auto-note" data-id="${n.id}">Delete</button>
      </div>
    </div>
  `;
}

/* ---------- top-of-page status banner with master switch ---------- */
function renderStatusBanner(enabled, unreviewedCount) {
  const stat = unreviewedCount > 0
    ? `<span class="stat-unreviewed">${unreviewedCount} unreviewed note${unreviewedCount === 1 ? '' : 's'}</span>`
    : '<span class="status-stats muted">all caught up</span>';

  return `
    <div class="away-status ${enabled ? 'on' : 'off'}">
      <div class="away-status-text">
        <div class="away-status-title">
          ${enabled
            ? '<span class="dot pulse"></span> Auto Notes is <strong>ON</strong>'
            : '<span class="dot"></span> Auto Notes is <strong>off</strong>'}
        </div>
        <div class="away-status-sub">
          ${enabled
            ? '24/7 inbound triage — flagging substantive items for follow-up'
            : 'Toggle on to start extracting follow-up items from incoming messages'}
          · ${stat}
        </div>
      </div>
      <div class="away-toggle-switch ${enabled ? 'on' : ''}" data-action="toggle-auto-notes" title="${enabled ? 'turn off' : 'turn on'}"></div>
    </div>
  `;
}

/* ---------- queue panel (the main content) ---------- */
function renderQueuePanel(notes, unreviewedCount) {
  if (notes.length === 0) {
    return `
      <section class="away-section">
        <h3>Follow-up queue</h3>
        <div class="empty-row" style="padding:12px 0;">
          The AI runs on every inbound message and flags anything substantive —
          meeting requests, things to discuss, time-sensitive items, decisions
          only you can make. When notes show up, they'll appear here as your
          follow-up queue.
        </div>
      </section>
    `;
  }

  const unreviewed = notes.filter((n) => n.reviewed_at == null);
  const reviewed = notes.filter((n) => n.reviewed_at != null);

  const headerRight = unreviewedCount > 0
    ? `<button class="btn ghost small review-all-btn" data-action="review-all-auto-notes">Mark all reviewed</button>`
    : '';

  const reviewedSection = reviewed.length > 0
    ? `
      <details class="away-collapsible">
        <summary><span>Reviewed</span><span class="count">${reviewed.length}</span></summary>
        <div class="away-reviewed-list">${reviewed.map(renderAutoNoteCard).join('')}</div>
      </details>
    `
    : '';

  return `
    <section class="away-section">
      <h3>
        <span>Follow-up queue</span>
        ${unreviewedCount > 0 ? `<span class="count unreviewed">${unreviewedCount} unreviewed</span>` : `<span class="count muted">all caught up</span>`}
        ${headerRight}
      </h3>
      ${unreviewed.length > 0
        ? `<div class="away-unreviewed-list">${unreviewed.map(renderAutoNoteCard).join('')}</div>`
        : '<div class="empty-row" style="padding:8px 0;">no unreviewed notes — all caught up</div>'}
      ${reviewedSection}
    </section>
  `;
}

/* ---------- settings panel (collapsed by default) ---------- */
function renderSettingsPanel() {
  const enabled = !!settingsCache.auto_notes_enabled;
  const minConf = settingsCache.auto_notes_min_confidence ?? 0;
  let excluded = [];
  try {
    const parsed = JSON.parse(settingsCache.auto_notes_excluded_handles || '[]');
    if (Array.isArray(parsed)) excluded = parsed;
  } catch { /* keep empty */ }

  return `
    <section class="away-section">
      <details class="away-collapsible">
        <summary>
          <span>Auto Notes configuration</span>
          <span class="config-summary-meta">${enabled ? 'on' : 'off'} · ${excluded.length} excluded contact${excluded.length === 1 ? '' : 's'}</span>
        </summary>

        <div class="away-config-grid">
          <form class="away-config-form" data-form="auto-notes-config">
            <div class="config-field">
              <label class="config-label">
                Master switch
                <span class="desc">when off, no AI runs on inbound messages — away and summon modes keep working independently</span>
              </label>
              <label class="config-inline" style="cursor:pointer;">
                <input type="checkbox" name="auto_notes_enabled" ${enabled ? 'checked' : ''} />
                <span class="desc">on (recommended)</span>
              </label>
            </div>

            <div class="config-field">
              <label class="config-label">
                Minimum confidence
                <span class="desc">reserved — the extractor doesn't return a confidence score yet, so this currently has no effect. Wired up so the setting and UI are in place when the extractor is updated.</span>
              </label>
              <div class="config-inline">
                <input type="number" name="auto_notes_min_confidence" min="0" max="100" value="${minConf}" />
                <span class="desc">% (0 = no filter)</span>
              </div>
            </div>

            <div class="config-field">
              <label class="config-label">
                Excluded contacts
                <span class="desc">handles to skip during note extraction (one per line — phone number or email exactly as it appears in iMessage). Use this to opt specific contacts out without disabling the whole feature.</span>
              </label>
              <textarea name="auto_notes_excluded_handles" rows="4" placeholder="+15551234567&#10;someone@example.com">${escapeHtml(excluded.join('\n'))}</textarea>
            </div>

            <div class="config-actions">
              <button type="submit" class="btn primary">Save changes</button>
              <span class="settings-status" data-error></span>
            </div>
          </form>
        </div>
      </details>
    </section>
  `;
}

export async function renderAutoNotesView() {
  const enabled = !!settingsCache.auto_notes_enabled;
  setMainHeader({
    title: 'Auto Notes',
    subHTML: enabled
      ? '<span class="accent" style="color: var(--green);">● ON</span> · 24/7 inbound triage'
      : '<span class="accent">off</span> · auto-extraction is disabled',
  });
  const list = document.getElementById('drafts-list');
  if (!list) return;

  let notesData = { notes: [], unreviewed: 0 };
  try {
    const n = await api('/api/auto-notes?limit=200');
    notesData = { notes: n.notes || [], unreviewed: n.unreviewed ?? 0 };
    setAutoUnreviewedNotes(notesData.unreviewed);
    updateAutoNotesNavBadge();
  } catch (err) {
    list.innerHTML = `<div class="empty"><div class="empty-title">Failed to load.</div><div class="empty-sub">${escapeHtml(err.message)}</div></div>`;
    return;
  }

  list.innerHTML = `
    ${renderStatusBanner(enabled, notesData.unreviewed)}
    ${renderQueuePanel(notesData.notes, notesData.unreviewed)}
    ${renderSettingsPanel()}
  `;
}

/** Update the sidebar nav badge with the current unreviewed count. */
export function updateAutoNotesNavBadge() {
  const navBadge = document.getElementById('nav-auto-notes-badge');
  if (!navBadge) return;
  if (autoUnreviewedNotes > 0) {
    navBadge.style.display = '';
    navBadge.textContent = String(autoUnreviewedNotes);
    navBadge.style.background = 'var(--orange)';
    navBadge.style.color = '#0a0c10';
    navBadge.title = `${autoUnreviewedNotes} unreviewed auto note(s)`;
  } else {
    navBadge.style.display = 'none';
  }
}

/** Re-fetch the unreviewed count from the server and refresh the nav badge.
 *  Called after a note is created (via SSE) or reviewed/deleted (via action). */
export async function refreshAutoNotesBadge() {
  try {
    const r = await api('/api/auto-notes?reviewed=false&limit=1');
    setAutoUnreviewedNotes(r.unreviewed ?? 0);
  } catch { setAutoUnreviewedNotes(0); }
  updateAutoNotesNavBadge();
}
