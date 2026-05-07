// Radar view — per-contact memory bank. List + detail. Detail page has a
// distilled profile (regenerable) plus all extracted signals, tabbed by category.

import { api } from '../api.js';
import { setMainHeader } from '../shell.js';
import { escapeHtml, initials, avatarClass, relTime } from '../utils.js';
import {
  radarSignalsTab, setRadarHandlesCache, setCurrentRadarHandle,
} from '../state.js';

export async function refreshRadarHandlesCache() {
  try {
    const r = await api('/api/radar/contacts');
    const set = new Set((r.contacts || []).filter((c) => c.enabled).map((c) => c.handle));
    setRadarHandlesCache(set);
    const el = document.getElementById('nav-radar-count');
    if (el) el.textContent = (r.contacts || []).length || '—';
    return r.contacts || [];
  } catch { return []; }
}

export function renderRadarCard(c) {
  const name = c.contact_name || c.label || c.handle;
  const seed = c.handle;
  const av = avatarClass(seed);
  const init = initials(c.contact_name, c.label, c.handle);
  const counts = Object.entries(c.signal_counts || {}).map(
    ([cat, n]) => `<span class="cat">${escapeHtml(cat)} ${n}</span>`,
  ).join('');
  const updated = c.profile_updated_at > 0
    ? `· profile updated ${escapeHtml(relTime(c.profile_updated_at))}`
    : '· no profile yet';
  return `
    <div class="radar-card ${c.enabled ? '' : 'disabled'}" data-action="open-radar" data-handle="${escapeHtml(c.handle)}">
      <div class="avatar ${av}">${escapeHtml(init)}</div>
      <div>
        <div class="radar-name">${escapeHtml(name)}</div>
        <div class="radar-handle">${escapeHtml(c.handle)} ${updated}</div>
        <div class="radar-counts">${counts || '<span class="cat">no signals yet</span>'}</div>
      </div>
      <div class="radar-actions">
        <button class="btn" data-action="toggle-radar-enabled" data-id="${c.id}" data-enabled="${c.enabled}">${c.enabled ? 'pause' : 'resume'}</button>
        <button class="btn ghost" data-action="remove-radar" data-id="${c.id}">remove</button>
      </div>
    </div>
  `;
}

export async function renderRadarView() {
  setMainHeader({
    title: 'Radar',
    subHTML: '<span class="accent" id="radar-count">— contacts</span> · live memory bank',
    showFilters: false,
  });
  const list = document.getElementById('drafts-list');
  if (!list) return;
  list.innerHTML = '<div class="empty"><div class="empty-title">loading…</div></div>';

  const contacts = await refreshRadarHandlesCache();
  const countEl = document.getElementById('radar-count');
  if (countEl) countEl.textContent = `${contacts.length} contacts`;

  if (contacts.length === 0) {
    list.innerHTML = `
      <div class="empty">
        <div class="empty-title">No one on radar yet.</div>
        <div class="empty-sub">Open any thread and click <strong>Add to Radar</strong> to start tracking.<br/>Once added, every incoming message from that contact gets analyzed into a memory bank — likes, wants, schedule, gift ideas, etc.</div>
      </div>
    `;
    return;
  }

  list.innerHTML = `<div class="radar-grid">${contacts.map(renderRadarCard).join('')}</div>`;
}

export async function renderRadarDetail(handle) {
  setCurrentRadarHandle(handle);
  setMainHeader({
    title: 'Radar',
    subHTML: `<a class="back-link" data-action="radar-back">← back to radar</a> · ${escapeHtml(handle)}`,
    showFilters: false,
  });
  const list = document.getElementById('drafts-list');
  if (!list) return;
  list.innerHTML = '<div class="empty"><div class="empty-title">loading…</div></div>';

  try {
    const r = await api(`/api/radar/contacts/by-handle/${encodeURIComponent(handle)}`);
    const c = r.contact;
    const name = c.contact_name || c.label || c.handle;
    const updated = c.profile_updated_at > 0 ? new Date(c.profile_updated_at).toLocaleString() : 'never';

    const cats = ['all', ...r.categories];
    const tabs = cats.map((cat) => {
      const count = cat === 'all'
        ? r.signals.length
        : (r.signal_counts?.[cat] ?? 0);
      const cls = (cat === radarSignalsTab) ? 'cat-tab active' : 'cat-tab';
      return `<span class="${cls}" data-action="radar-cat" data-cat="${escapeHtml(cat)}">${escapeHtml(cat)} ${count > 0 ? '· ' + count : ''}</span>`;
    }).join('');

    const filtered = radarSignalsTab === 'all'
      ? r.signals
      : r.signals.filter((s) => s.category === radarSignalsTab);

    const signalItems = filtered.length === 0
      ? '<div class="empty-row" style="padding:8px 0;">no signals in this category yet</div>'
      : filtered.map((s) => `
          <div class="signal-item" data-signal-id="${s.id}">
            <div class="signal-meta">
              <span class="badge">${escapeHtml(s.category)}</span>
              <span>${escapeHtml(relTime(s.extracted_at))}</span>
              ${typeof s.confidence === 'number' ? `<span>conf ${s.confidence.toFixed(2)}</span>` : ''}
            </div>
            <div>${escapeHtml(s.content)}</div>
            <span class="signal-remove" data-action="remove-radar-signal" data-id="${s.id}" title="remove">✕</span>
          </div>
        `).join('');

    list.innerHTML = `
      <div class="radar-detail">
        <form class="radar-profile-block" data-form="radar-profile" data-handle="${escapeHtml(handle)}">
          <h3>
            <span>${escapeHtml(name)} — profile</span>
            <span class="when">last updated ${escapeHtml(updated)}</span>
          </h3>
          <textarea name="profile" placeholder="No profile yet. Click 'Regenerate' to distill from extracted signals.">${escapeHtml(c.profile || '')}</textarea>
          <div class="radar-profile-actions">
            <button type="submit" class="btn primary">Save edits</button>
            <button type="button" class="btn" data-action="radar-regenerate" data-handle="${escapeHtml(handle)}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><polyline points="21 3 21 8 16 8"/></svg>
              Regenerate from signals
            </button>
            <span class="compose-status" data-error></span>
          </div>
        </form>
        <div class="radar-signals-block">
          <h3>extracted signals · ${r.signals.length} total</h3>
          <div class="radar-cat-tabs">${tabs}</div>
          <div class="signal-list">${signalItems}</div>
        </div>
      </div>
    `;
  } catch (err) {
    list.innerHTML = `<div class="empty"><div class="empty-title">Failed to load.</div><div class="empty-sub">${escapeHtml(err.message)}</div></div>`;
  }
}
