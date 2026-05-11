// User-action handlers — click/tap a button, push a command to RTDB,
// surface success/failure as a toast.
//
// Most handlers are short:
//   1. Read whatever input the user touched.
//   2. await sendCommand(type, payload).
//   3. Toast.
//
// We don't optimistically mutate the local store — the backend writes
// /state on every applied command, and that re-render happens within
// ~50ms. For toggle UI we add a brief "pending" state on the button so
// the user sees the click registered.

import { sendCommand, getStore } from './state.js';
import { showToast, openSheet, closeSheet, closeAllSheets, renderSourceSheet, renderPushPanel } from './render.js';
import { enablePush, disablePush, sendTestPush, isPushEnabled } from './push.js';
import { sendChatTurn, sendChatText, clearChat } from './galt-chat.js';

/* ---------- the registry ---------- */

const HANDLERS = {
  /* sheet open/close */
  'open-settings': () => openSheet('settings'),
  'open-status':   () => openSheet('status'),
  'edit-away':     () => openSheet('away'),

  /* navigation — hash-routed SPA. main.js applyRoute() reacts to
     hashchange and starts the chat subscription / focuses input. */
  'open-chat':     () => { location.hash = '#/chat'; },
  'nav-home':      () => { location.hash = '#/'; },

  'chat-send':     () => { void sendChatTurn(); },
  'chat-clear':    () => { void clearChat(); },

  /* calendar proposal approve / dismiss — sent via the /commands bus
     (export_calendar_proposal / dismiss_calendar_proposal). Backend
     marks the row exported (writes .ics + opens Calendar.app's
     importer) or dismissed. We surface the result inline on the
     card by flipping its data-status. */
  'proposal-approve': async (target) => {
    const id = parseInt(target.dataset.proposalId, 10);
    if (!Number.isFinite(id)) return;
    markProposalStatus(target, 'sending');
    try {
      await sendCommand('export_calendar_proposal', { id });
      markProposalStatus(target, 'approved');
      showToast('opened in Calendar.app — click Add', 'ok');
    } catch (err) {
      markProposalStatus(target, 'pending');
      showToast(err.message, 'error');
    }
  },
  'proposal-dismiss': async (target) => {
    const id = parseInt(target.dataset.proposalId, 10);
    if (!Number.isFinite(id)) return;
    markProposalStatus(target, 'sending');
    try {
      await sendCommand('dismiss_calendar_proposal', { id });
      markProposalStatus(target, 'dismissed');
    } catch (err) {
      markProposalStatus(target, 'pending');
      showToast(err.message, 'error');
    }
  },

  /* request_user_approval — generic Approve/Deny inline prompt.
     Click sends the chosen label as a new chat turn so Galt sees
     the decision on the next round. No backend command needed —
     the user's response goes through the regular chat flow. */
  'approval-approve': async (target) => {
    const label = target.dataset.label || 'Approve';
    markApprovalStatus(target, 'approved');
    await sendChatText(label);
  },
  'approval-deny': async (target) => {
    const label = target.dataset.label || 'Deny';
    markApprovalStatus(target, 'denied');
    await sendChatText(label);
  },
  'refresh':       async () => {
    try {
      await sendCommand('refresh_state');
      showToast('refreshed', 'ok');
    } catch (err) {
      showToast(err.message, 'error');
    }
  },

  /* away message editor */
  'save-away': async () => {
    const input = document.querySelector('[data-id="away-input"]');
    if (!input) return;
    try {
      await sendCommand('set_away_message', { text: input.value });
      closeSheet('away');
      showToast('away message saved', 'ok');
    } catch (err) {
      showToast(err.message, 'error');
    }
  },

  /* watched contacts */
  'add-contact': async () => {
    const input = document.querySelector('[data-id="new-contact-name"]');
    if (!input) return;
    const handle = input.value.trim();
    if (!handle) return;
    try {
      await sendCommand('add_watched_contact', { handle });
      input.value = '';
      showToast('contact added', 'ok');
    } catch (err) {
      showToast(err.message, 'error');
    }
  },

  'remove-contact': async (target) => {
    const id = parseInt(target.dataset.contactId, 10);
    if (!Number.isFinite(id)) return;
    try {
      await sendCommand('remove_watched_contact', { id });
      showToast('contact removed', 'ok');
    } catch (err) {
      showToast(err.message, 'error');
    }
  },

  'toggle-contact': async (target) => {
    const id = parseInt(target.dataset.contactId, 10);
    if (!Number.isFinite(id)) return;
    const currentlyOn = target.dataset.on === 'true';
    try {
      await sendCommand('set_watched_contact_enabled', { id, enabled: !currentlyOn });
    } catch (err) {
      showToast(err.message, 'error');
    }
  },

  /* notes */
  'view-source': async (target) => {
    const id = parseInt(target.dataset.noteId, 10);
    if (!Number.isFinite(id)) return;
    // Open the sheet immediately with a loading state — the user gets
    // a feedback frame even if the round-trip takes a beat.
    renderSourceSheet(null);
    openSheet('source');
    try {
      const data = await sendCommand('get_note_source', { id });
      renderSourceSheet(data);
    } catch (err) {
      const body = document.querySelector('[data-id="source-body"]');
      if (body) body.innerHTML = `<div class="field-help" data-tone="bad">${err.message}</div>`;
    }
  },

  'review-note': async (target) => {
    const id = parseInt(target.dataset.noteId, 10);
    if (!Number.isFinite(id)) return;
    try {
      await sendCommand('mark_note_reviewed', { id });
    } catch (err) {
      showToast(err.message, 'error');
    }
  },

  // Unreview by deleting the reviewed_at — we don't have an explicit
  // backend command for it, so this is a TODO. For now, "unreview"
  // is a no-op alias of review and just toggles the local view; users
  // who really need this can run a SQL update.
  'unreview-note': async () => {
    showToast('unreview not implemented yet — review state is one-way');
  },

  'delete-note': async (target) => {
    const id = parseInt(target.dataset.noteId, 10);
    if (!Number.isFinite(id)) return;
    try {
      await sendCommand('delete_note', { id });
      showToast('note deleted', 'ok');
    } catch (err) {
      showToast(err.message, 'error');
    }
  },

  // 'reset' and 'sign-out' aren't wired remotely on purpose — see
  // CLAUDE.md "Pause points". The buttons stay in the markup so we
  // don't drift visually from the local UI, but they show a toast.
  reset: () => {
    showToast('reset is local-only — run from the Mac UI', 'error');
  },
  'sign-out': () => {
    showToast('no sign-in — see CLAUDE.md auth note', 'error');
  },

  /* push notifications — settings sheet */
  'push-toggle': async () => {
    const ok = isPushEnabled() ? await disablePush() : await enablePush();
    // Re-render the panel either way so the button label + test-button
    // disabled-state reflect the new world.
    renderPushPanel();
  },
  'push-test': async () => {
    await sendTestPush();
  },
};

/* ---------- proposal-card status flip ---------- */

function markProposalStatus(target, status) {
  // Walk up to the .chat-proposal-card so we can stamp data-status
  // on the whole card (drives the CSS variant — approved / dismissed
  // / sending all dim the card differently).
  const card = target.closest('.chat-proposal-card');
  if (!card) return;
  card.dataset.status = status;
  const statusEl = card.querySelector('[data-id^="proposal-status-"]');
  if (statusEl) statusEl.textContent = status;
  // Disable the buttons once the user has decided, regardless of
  // which one they picked. The chat history will eventually re-render
  // from RTDB but we want the click to be visibly final immediately.
  if (status === 'approved' || status === 'dismissed') {
    for (const btn of card.querySelectorAll('.chat-proposal-btn')) {
      btn.setAttribute('disabled', 'true');
    }
  }
}

function markApprovalStatus(target, status) {
  const card = target.closest('.chat-approval-card');
  if (!card) return;
  card.dataset.status = status;
  const statusEl = card.querySelector('[data-id^="approval-status-"]');
  if (statusEl) statusEl.textContent = status;
  for (const btn of card.querySelectorAll('.chat-proposal-btn')) {
    btn.setAttribute('disabled', 'true');
  }
}

/* ---------- toggles (Summon, Away) ---------- */

async function handleToggle(target) {
  const which = target.dataset.toggle;       // 'summon' | 'away'
  const wasOn = target.dataset.on === 'true';
  const cmd   = which === 'summon' ? 'set_summon_enabled' : 'set_away_enabled';
  // Optimistic flip — the next /state push will reconcile.
  target.dataset.on = String(!wasOn);
  try {
    await sendCommand(cmd, { enabled: !wasOn });
  } catch (err) {
    target.dataset.on = String(wasOn); // rollback on failure
    showToast(err.message, 'error');
  }
}

/* ---------- delegated event wiring ---------- */

export function wireEventDelegation() {
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action], [data-toggle], [data-close]');
    if (!t) return;

    if (t.dataset.toggle) { handleToggle(t); return; }
    if (t.dataset.close)  { closeSheet(t.dataset.close); return; }

    const action = t.dataset.action;
    const fn = HANDLERS[action];
    if (!fn) {
      console.warn('[actions] no handler for', action);
      return;
    }
    Promise.resolve(fn(t)).catch((err) => showToast(err.message, 'error'));
  });

  // Voice profile + default away textareas — debounced auto-save on
  // input. The backend rejects nothing here, so a transient network
  // hiccup just means the next keystroke retries.
  wireDebouncedSave('voice-profile',  'set_voice_profile',  'voice profile saved');
  wireDebouncedSave('default-away',   'set_away_message',   'default away saved');

  // Escape closes any open sheet (desktop ergonomics)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllSheets();
  });
}

function wireDebouncedSave(dataId, commandType, successMsg) {
  const el = document.querySelector(`[data-id="${dataId}"]`);
  if (!el) return;
  let timer = null;
  el.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        await sendCommand(commandType, { text: el.value });
        showToast(successMsg, 'ok');
      } catch (err) {
        showToast(err.message, 'error');
      }
    }, 700);
  });
}
