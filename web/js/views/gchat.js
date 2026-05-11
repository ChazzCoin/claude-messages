// Google Chat view — two-column layout.
// Left: space list with watch toggles + sync button.
// Right: message feed for the selected space + compose bar.
//
// Routes: #/gchat

import { api } from '../api.js';
import { setMainHeader } from '../shell.js';
import { escapeHtml, relTime } from '../utils.js';

let selectedSpaceName = null;
let pollTimer = null;

export async function renderGChatView() {
  setMainHeader('Google Chat');
  const main = document.querySelector('.main');
  main.innerHTML = `<div class="gchat-root loading">Loading…</div>`;

  // Load health + spaces in parallel.
  const [healthRes, spacesRes] = await Promise.all([
    api('/api/gchat/health').catch(() => null),
    api('/api/gchat/spaces').catch(() => ({ spaces: [] })),
  ]);

  const health = healthRes ?? { auth_ok: false, auth_error: 'unreachable', watcher_running: false };
  const spaces = spacesRes.spaces ?? [];

  main.innerHTML = renderRoot(health, spaces);
  bindEvents();

  // Auto-select first watched space.
  const firstWatched = spaces.find((s) => s.watched);
  if (firstWatched) selectSpace(firstWatched.name);
}

/* ------------------------------------------------------------------ */
/* render                                                               */
/* ------------------------------------------------------------------ */

function renderRoot(health, spaces) {
  return `
    <div class="gchat-root">
      ${renderHealthBanner(health)}
      <div class="gchat-layout">
        <div class="gchat-sidebar">
          <div class="gchat-sidebar-header">
            <span>Spaces</span>
            <button class="btn ghost small" data-action="sync-spaces">↻ Sync</button>
          </div>
          <div class="gchat-space-list" id="gchat-space-list">
            ${spaces.length === 0 ? renderEmptySpaces() : spaces.map(renderSpaceItem).join('')}
          </div>
        </div>
        <div class="gchat-feed" id="gchat-feed">
          <div class="gchat-feed-empty">
            ${spaces.length === 0
              ? '<p>No spaces found. Click <strong>↻ Sync</strong> to discover your spaces, then watch the ones you care about.</p>'
              : '<p>Select a space to view messages.</p>'
            }
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderHealthBanner(health) {
  if (health.auth_ok) {
    return health.watcher_running
      ? `<div class="gchat-health ok"><span class="dot pulse"></span> Connected · watcher active</div>`
      : `<div class="gchat-health warn"><span class="dot"></span> Connected · no spaces watched yet</div>`;
  }
  return `
    <div class="gchat-health error">
      ⚠ Google Chat auth failed — run
      <code>gcloud auth application-default login --scopes=…</code> with Chat scopes.
      ${health.auth_error ? `<span class="muted">(${escapeHtml(health.auth_error)})</span>` : ''}
    </div>
  `;
}

function renderEmptySpaces() {
  return `<div class="gchat-no-spaces muted">Click ↻ Sync to discover spaces</div>`;
}

function renderSpaceItem(space) {
  const watched = space.watched;
  const typeLabel = space.space_type === 'DIRECT_MESSAGE' ? 'DM' : space.space_type === 'GROUP_CHAT' ? 'Group' : '#';
  return `
    <div class="gchat-space-item ${watched ? 'watched' : ''} ${space.name === selectedSpaceName ? 'active' : ''}"
         data-space-name="${escapeHtml(space.name)}"
         data-action="select-space">
      <span class="gchat-space-type-tag">${typeLabel}</span>
      <span class="gchat-space-name">${escapeHtml(space.display_name || space.name)}</span>
      <button class="gchat-watch-toggle btn ghost small"
              data-action="toggle-watch"
              data-space-name="${escapeHtml(space.name)}"
              data-watched="${watched ? '1' : '0'}">
        ${watched ? '● watching' : '○ watch'}
      </button>
    </div>
  `;
}

function renderMessageFeed(space, messages) {
  return `
    <div class="gchat-feed-header">
      <div class="gchat-feed-title">
        <strong>${escapeHtml(space.display_name || space.name)}</strong>
        <span class="muted">${escapeHtml(space.space_type || '')}</span>
      </div>
      <div class="gchat-watch-status">
        ${space.watched
          ? '<span class="dot pulse"></span> watching'
          : '<span class="muted">not watching</span>'}
      </div>
    </div>
    <div class="gchat-messages" id="gchat-messages">
      ${messages.length === 0
        ? '<div class="gchat-no-messages muted">No messages yet. Watch this space to start capturing messages.</div>'
        : messages.map(renderMessageRow).join('')}
    </div>
    <div class="gchat-compose">
      <textarea class="gchat-compose-input" id="gchat-compose-input"
        placeholder="Send a message to ${escapeHtml(space.display_name || space.name)}…"
        rows="2"></textarea>
      <button class="btn primary" data-action="send-message">Send</button>
    </div>
  `;
}

function renderMessageRow(msg) {
  const time = msg.create_time ? relTime(new Date(msg.create_time).getTime()) : '';
  const isBot = msg.sender_type === 'BOT';
  return `
    <div class="gchat-message ${isBot ? 'bot' : ''}">
      <div class="gchat-message-meta">
        <span class="gchat-sender">${escapeHtml(msg.sender_name || 'Unknown')}</span>
        ${isBot ? '<span class="gchat-bot-tag">bot</span>' : ''}
        <span class="gchat-time muted">${escapeHtml(time)}</span>
      </div>
      <div class="gchat-message-text">${escapeHtml(msg.text || '')}</div>
    </div>
  `;
}

/* ------------------------------------------------------------------ */
/* interactions                                                         */
/* ------------------------------------------------------------------ */

function bindEvents() {
  const root = document.querySelector('.gchat-root');
  if (!root) return;

  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === 'sync-spaces') {
      btn.textContent = '↻ Syncing…';
      btn.disabled = true;
      try {
        const res = await api('/api/gchat/spaces/sync', { method: 'POST' });
        renderSpaceList(res.spaces ?? []);
      } catch (err) {
        alert('Sync failed: ' + err.message);
      } finally {
        btn.textContent = '↻ Sync';
        btn.disabled = false;
      }
    }

    if (action === 'select-space') {
      const name = btn.closest('[data-space-name]')?.dataset.spaceName;
      if (name) selectSpace(name);
    }

    if (action === 'toggle-watch') {
      const name = btn.dataset.spaceName;
      const watched = btn.dataset.watched !== '1';
      try {
        const res = await api(`/api/gchat/spaces/${name}/watch`, {
          method: 'POST',
          body: JSON.stringify({ watched }),
        });
        renderSpaceList(res.spaces ?? []);
        // If currently viewing this space, refresh the feed header.
        if (name === selectedSpaceName) selectSpace(name);
      } catch (err) {
        alert('Failed: ' + err.message);
      }
    }

    if (action === 'send-message') {
      await handleSend();
    }
  });

  // Ctrl+Enter to send.
  root.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      const input = document.getElementById('gchat-compose-input');
      if (input && document.activeElement === input) await handleSend();
    }
  });
}

async function handleSend() {
  if (!selectedSpaceName) return;
  const input = document.getElementById('gchat-compose-input');
  const text = input?.value?.trim();
  if (!text) return;

  const btn = document.querySelector('[data-action="send-message"]');
  if (btn) { btn.textContent = 'Sending…'; btn.disabled = true; }
  input.disabled = true;

  try {
    await api(`/api/gchat/spaces/${selectedSpaceName}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    input.value = '';
    // Reload messages.
    await loadMessages(selectedSpaceName);
  } catch (err) {
    alert('Send failed: ' + err.message);
  } finally {
    if (btn) { btn.textContent = 'Send'; btn.disabled = false; }
    input.disabled = false;
    input.focus();
  }
}

async function selectSpace(name) {
  selectedSpaceName = name;

  // Highlight active space in sidebar.
  document.querySelectorAll('.gchat-space-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.spaceName === name);
  });

  await loadMessages(name);

  // Poll for new messages while this space is open.
  clearInterval(pollTimer);
  pollTimer = setInterval(() => loadMessages(name), 15_000);
}

async function loadMessages(spaceName) {
  const feed = document.getElementById('gchat-feed');
  if (!feed) return;

  try {
    const [spaceRes, messagesRes] = await Promise.all([
      api('/api/gchat/spaces').then((r) => (r.spaces ?? []).find((s) => s.name === spaceName)),
      api(`/api/gchat/spaces/${spaceName}/messages?limit=100`).then((r) => r.messages ?? []),
    ]);

    if (!spaceRes) return;
    feed.innerHTML = renderMessageFeed(spaceRes, messagesRes);

    // Scroll to bottom.
    const msgs = document.getElementById('gchat-messages');
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
  } catch (err) {
    feed.innerHTML = `<div class="gchat-feed-error">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

function renderSpaceList(spaces) {
  const list = document.getElementById('gchat-space-list');
  if (!list) return;
  list.innerHTML = spaces.length === 0
    ? renderEmptySpaces()
    : spaces.map(renderSpaceItem).join('');
}

/** Called when navigating away — stop the poll. */
export function stopGChatPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
  selectedSpaceName = null;
}
