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
import { showToast, openSheet, closeSheet, closeAllSheets, renderSourceSheet, renderPushPanel, renderRepoPage, openRepoPage, closeRepoPage, renderTaskDetail } from './render.js';
import { enablePush, disablePush, sendTestPush, isPushEnabled } from './push.js';
import { sendChatTurn, sendChatText, clearChat, recordApprovalDecision, toggleVoice, toggleMic, testVoice, startMemoryMic, dismissMemoryResponse, initVoice, startClaudeMic, dismissClaudePanel, openClaudeOutputSheet, selectCOSTask, getCOSOpenPRsForRepo, getActiveCOSRepoId, openCOSSSheet } from './galt-chat.js';

/* ---------- the registry ---------- */

const HANDLERS = {
  /* sheet open/close */
  'open-status':   () => openSheet('status'),
  'edit-away':     () => openSheet('away'),

  /* navigation — hash-routed SPA. main.js applyRoute() reacts to
     hashchange and starts the chat subscription / focuses input. */
  'open-chat':     () => { location.hash = '#/chat'; },
  'open-notes':     () => { location.hash = '#/notes'; },
  'open-briefing':  () => { location.hash = '#/briefing'; },
  'nav-home':      () => { location.hash = '#/'; },
  // Re-apply voice UI every time settings opens so the toggle reflects
  // the real localStorage state regardless of when it was last set.
  'open-settings': () => { openSheet('settings'); initVoice(); },

  'chat-send':     () => { void sendChatTurn(); },
  'chat-clear':    () => { void clearChat(); },
  'voice-toggle':         () => { toggleVoice(); },
  'voice-settings-toggle':() => { toggleVoice(); },
  'chat-mic':             () => { toggleMic(); },
  'voice-test':           () => { testVoice(); },
  'memory-mic':           () => { startMemoryMic(); },
  'memory-dismiss':       () => { dismissMemoryResponse(); },
  'claude-mic':           () => { startClaudeMic(); },
  'claude-dismiss':       () => { dismissClaudePanel(); },

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

  /* Calendar picker on the proposal card. Change event fires when
     user picks a different calendar; the choice gets stored on the
     proposal row and the .ics export stamps X-WR-CALNAME. */
  'proposal-set-calendar': async (target) => {
    const id = parseInt(target.dataset.proposalId, 10);
    if (!Number.isFinite(id)) return;
    const calendar = target.value || null;
    try {
      await sendCommand('set_proposal_calendar', { id, calendar });
    } catch (err) {
      showToast(err.message, 'error');
    }
  },

  /* task-cancel — cancel a running Claude task. Fires
     cancel_task RTDB command; the backend kills the subprocess
     and flips status. The card's RTDB subscription picks up the
     status change and updates the UI. */
  'task-cancel': async (target) => {
    const taskId = target.dataset.taskId;
    if (!taskId) return;
    target.setAttribute('disabled', 'true');
    target.textContent = 'Cancelling…';
    try {
      await sendCommand('cancel_task', { task_id: taskId });
    } catch (err) {
      target.removeAttribute('disabled');
      target.textContent = 'Cancel';
      showToast(err.message, 'error');
    }
  },

  /* request_user_approval — generic Approve/Deny inline prompt.
     Click sends the chosen label as a new chat turn so Galt sees
     the decision on the next round. No backend command needed —
     the user's response goes through the regular chat flow. */
  'approval-approve': async (target) => {
    const label = target.dataset.label || 'Approve';
    const fp = target.dataset.approvalFp;
    if (fp) recordApprovalDecision(fp, 'approved');
    markApprovalStatus(target, 'approved');
    await sendChatText(label);
  },
  'approval-deny': async (target) => {
    const label = target.dataset.label || 'Deny';
    const fp = target.dataset.approvalFp;
    if (fp) recordApprovalDecision(fp, 'denied');
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

  'briefing-refresh': async () => {
    try {
      await sendCommand('refresh_repos');
      // No toast needed — the /repos subscription re-renders automatically.
    } catch (err) {
      showToast(err.message, 'error');
    }
  },

  /* open-repo — tap a repo row in the briefing → full-screen task management page */
  'open-repo': (target) => {
    const repoId = parseInt(target.closest('[data-repo-id]')?.dataset.repoId ?? target.dataset.repoId, 10);
    if (!Number.isFinite(repoId)) return;
    const repo = (getStore().repos || []).find((r) => r.id === repoId);
    if (!repo) { showToast('repo not found', 'error'); return; }
    // Merge in-session COS PRs (local dashboard) with snapshot PRs (companion).
    // Snapshot PRs use task_id (snake_case); normalize to taskId for renderRepoPage.
    const cosPRs  = getCOSOpenPRsForRepo(repoId);
    const cosIds  = new Set(cosPRs.map((x) => x.taskId));
    const snapPRs = (repo.open_prs || [])
      .filter((x) => !cosIds.has(x.task_id))
      .map((x) => ({ taskId: x.task_id, pr: x.pr }));
    const openPRs = [...cosPRs, ...snapPRs];
    renderRepoPage(repo, openPRs);
    openRepoPage();
  },

  /* close-repo-page — back button on the repo page overlay */
  'close-repo-page': () => closeRepoPage(),

  /* close-task-detail — dismiss task detail sheet */
  'close-task-detail': () => closeSheet('task-detail'),

  /* view-task — tap a task row to read its full spec */
  'view-task': (target) => {
    const taskId = target.closest('[data-task-id]')?.dataset.taskId;
    const repoId = parseInt(target.closest('[data-repo-id]')?.dataset.repoId, 10);
    if (!taskId || !repoId) return;

    const store = getStore();
    const repo  = (store.repos || []).find((r) => r.id === repoId);
    if (!repo) return;

    // Search across all task lists
    const allTasks = [
      ...(repo.active_tasks || []),
      ...(repo.backlog_tasks || []),
      ...(repo.done_tasks || []),
    ];
    const task = allTasks.find((t) => t.task_id === taskId);
    if (!task) return;

    // Build phase map for the detail label
    const phaseMap = {};
    for (const p of (repo.phases || [])) phaseMap[p.phase_num] = p;

    renderTaskDetail(task, repo, phaseMap);
    openSheet('task-detail');
  },

  /* rsh-tab — tab strip in the repo page */
  'rsh-tab': (target) => {
    const tab = target.dataset.tab;
    if (!tab) return;
    const tabStrip = target.closest('[data-id="rsh-tabs"]');
    if (tabStrip) {
      for (const btn of tabStrip.querySelectorAll('.rsh-tab')) btn.classList.remove('active');
      target.classList.add('active');
    }
    const panels = document.querySelectorAll('.rsh-tab-panel');
    for (const panel of panels) {
      panel.style.display = panel.dataset.tabPanel === tab ? '' : 'none';
    }
  },

  /* claude-action — unified "send to Claude" button (TASK-076).
     Reads data-claude-action for the verb: assign | spec | create */
  'claude-action': async (target) => {
    const verb   = target.dataset.claudeAction;
    const repoId = parseInt(
      target.closest('[data-repo-id]')?.dataset.repoId ?? target.dataset.repoId ?? '',
      10
    );
    const taskId = target.closest('[data-task-id]')?.dataset.taskId ?? target.dataset.taskId;

    const originalLabel = target.querySelector('.ca-label')?.textContent;
    target.dataset.state = 'loading';
    target.disabled = true;

    try {
      let result;
      let title;

      if (verb === 'assign') {
        if (!Number.isFinite(repoId) || !taskId) throw new Error('repo + task required');
        result = await sendCommand('start_repo_task', { repo_id: repoId, task_id: taskId });
        title  = `Assign: ${result?.spec_title || taskId}`;
        closeSheet('task-detail');
      } else if (verb === 'spec') {
        if (!Number.isFinite(repoId) || !taskId) throw new Error('repo + task required');
        result = await sendCommand('spec_task', { repo_id: repoId, task_id: taskId });
        title  = `Spec: ${result?.spec_title || taskId}`;
        closeSheet('task-detail');
      } else if (verb === 'create') {
        const form       = document.querySelector('[data-id="rsh-create-form"]');
        const createType = form?.dataset.createType;
        const narrative  = form?.querySelector('[data-id="rsh-create-input"]')?.value?.trim();
        const fRepoId    = parseInt(form?.dataset.repoId ?? '', 10);
        if (!narrative) throw new Error('describe what you want first');
        const cmd = createType === 'task' ? 'create_repo_task' : 'create_repo_phase';
        result = await sendCommand(cmd, { repo_id: fRepoId, narrative });
        title  = createType === 'task' ? '＋ Create task' : '⊕ Plan phase';
        if (form) form.style.display = 'none';
      } else {
        throw new Error(`unknown claude-action: ${verb}`);
      }

      const uuid = result?.task_id;
      if (!uuid) throw new Error('no task_id returned');
      const effectiveRepoId = verb === 'create'
        ? parseInt(document.querySelector('[data-id="rsh-create-form"]')?.dataset.repoId ?? '', 10)
        : repoId;
      openClaudeOutputSheet(uuid, title, effectiveRepoId);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      target.dataset.state = '';
      target.disabled = false;
      const labelEl = target.querySelector('.ca-label');
      if (labelEl && originalLabel) labelEl.textContent = originalLabel;
    }
  },

  /* cos-session-send — follow-up input in the COS sheet (TASK-077) */
  'cos-session-send': async () => {
    const input  = document.querySelector('[data-id="cos-session-input"]');
    const text   = input?.value?.trim();
    if (!text) return;

    const repoId = getActiveCOSRepoId();
    if (!repoId) { showToast('no repo session active', 'error'); return; }

    input.value = '';

    try {
      const result = await sendCommand('repo_claude_task', { repo_id: repoId, text });
      const uuid   = result?.task_id;
      if (!uuid) throw new Error('no task_id returned');
      openClaudeOutputSheet(uuid, text.slice(0, 48), repoId);
    } catch (err) {
      showToast(err.message, 'error');
    }
  },

  /* repo-mic-select-change — persist selected repo + sync both selectors (TASK-078) */
  'repo-mic-select-change': (target) => {
    localStorage.setItem('galt_repo_mic_repo_id', target.value);
    for (const sel of document.querySelectorAll(
      '[data-id="repo-mic-select"], [data-id="d-repo-mic-select"]'
    )) {
      if (sel !== target) sel.value = target.value;
    }
  },

  /* rsh-create-task — reveal narrative form for task creation */
  'rsh-create-task': (target) => {
    const form = document.querySelector('[data-id="rsh-create-form"]');
    if (!form) return;
    form.dataset.createType = 'task';
    form.dataset.repoId = target.dataset.repoId;
    const label = form.querySelector('[data-id="rsh-create-label"]');
    if (label) label.textContent = 'Describe the task you want:';
    const input = form.querySelector('[data-id="rsh-create-input"]');
    if (input) input.value = '';
    form.style.display = 'flex';
    input?.focus();
  },

  /* rsh-create-phase — reveal narrative form for phase creation */
  'rsh-create-phase': (target) => {
    const form = document.querySelector('[data-id="rsh-create-form"]');
    if (!form) return;
    form.dataset.createType = 'phase';
    form.dataset.repoId = target.dataset.repoId;
    const label = form.querySelector('[data-id="rsh-create-label"]');
    if (label) label.textContent = 'Describe the phase you want to plan:';
    const input = form.querySelector('[data-id="rsh-create-input"]');
    if (input) input.value = '';
    form.style.display = 'flex';
    input?.focus();
  },

  /* rsh-create-cancel — hide the narrative form */
  'rsh-create-cancel': () => {
    const form = document.querySelector('[data-id="rsh-create-form"]');
    if (form) form.style.display = 'none';
  },

  /* cos-task-select — switch the active task view in the COS */
  'cos-task-select': (target) => {
    const taskId = target.dataset.taskId;
    if (taskId) selectCOSTask(taskId);
  },

  /* open-cos — reopen the COA sheet (floating pill or any trigger) */
  'open-cos': () => openSheet('cos'),

  /* close-cos — dismiss the COA sheet (tasks keep running) */
  'close-cos': () => closeSheet('cos'),

  /* cos-session-send — send a follow-up prompt to the active COA repo session */
  'cos-session-send': async () => {
    const input = document.querySelector('[data-id="cos-session-input"]');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    const repoId = getActiveCOSRepoId();
    if (!repoId) return;
    input.value = '';
    try {
      await sendCommand('repo_claude_task', { repo_id: repoId, text });
      showToast('sent to session', 'ok');
    } catch (err) {
      showToast(`session: ${err.message}`, 'error');
    }
  },

  /* open-coss-session — open the COSS sheet */
  'open-coss-session': () => openCOSSSheet(),

  /* coss-send — send a prompt to the active COS session */
  'coss-send': async () => {
    const input = document.querySelector('[data-id="coss-input"]');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    showToast('session input coming soon', 'ok');
  },

  /* approve-pr — squash merge the open PR */
  'approve-pr': async (target) => {
    const taskId  = target.dataset.taskId;
    const repoId  = parseInt(target.dataset.repoId, 10);
    const prNumber = parseInt(target.dataset.prNumber, 10);
    if (!taskId || !Number.isFinite(prNumber)) return;
    target.disabled = true;
    target.textContent = 'Merging…';
    try {
      await sendCommand('approve_pr', { task_id: taskId, repo_id: repoId, pr_number: prNumber });
      showToast('PR merged ✓', 'ok');
    } catch (err) {
      target.disabled = false;
      target.textContent = '✓ Merge';
      showToast(`merge failed: ${err.message}`, 'error');
    }
  },

  /* deny-pr — close (reject) the open PR */
  'deny-pr': async (target) => {
    const taskId  = target.dataset.taskId;
    const repoId  = parseInt(target.dataset.repoId, 10);
    const prNumber = parseInt(target.dataset.prNumber, 10);
    if (!taskId || !Number.isFinite(prNumber)) return;
    target.disabled = true;
    target.textContent = 'Closing…';
    try {
      await sendCommand('deny_pr', { task_id: taskId, repo_id: repoId, pr_number: prNumber });
      showToast('PR closed', 'ok');
    } catch (err) {
      target.disabled = false;
      target.textContent = '✗ Close';
      showToast(`close failed: ${err.message}`, 'error');
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
  'mark-all-reviewed': async () => {
    try {
      await sendCommand('mark_all_notes_reviewed');
      showToast('all notes marked reviewed', 'ok');
    } catch (err) {
      showToast(err.message, 'error');
    }
  },

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

    // If the click landed inside a [data-action-stop] zone but the resolved
    // action element (t) is outside that zone, we're about to fire a parent
    // action that the stop zone is blocking. Skip it.
    const stopZone = e.target.closest('[data-action-stop]');
    if (stopZone && !stopZone.contains(t)) return;

    // <select> change events handled below — clicking the select to
    // open it shouldn't trigger the action handler.
    if (t.tagName === 'SELECT') return;

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

  // <select> change events for actions on dropdowns (calendar picker).
  document.addEventListener('change', (e) => {
    const t = e.target.closest('select[data-action]');
    if (!t) return;
    const fn = HANDLERS[t.dataset.action];
    if (!fn) return;
    Promise.resolve(fn(t)).catch((err) => showToast(err.message, 'error'));
  });

  // Voice profile + default away textareas — debounced auto-save on
  // input. The backend rejects nothing here, so a transient network
  // hiccup just means the next keystroke retries.
  wireDebouncedSave('voice-profile',  'set_voice_profile',  'voice profile saved');
  wireDebouncedSave('default-away',   'set_away_message',   'default away saved');

  // Enter (no shift) submits COS session inputs
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    const id = e.target.dataset?.id;
    if (id === 'cos-session-input') {
      e.preventDefault();
      Promise.resolve(HANDLERS['cos-session-send']?.()).catch((err) => showToast(err.message, 'error'));
    } else if (id === 'coss-input') {
      e.preventDefault();
      Promise.resolve(HANDLERS['coss-send']?.()).catch((err) => showToast(err.message, 'error'));
    }
  });

  // Escape closes any open sheet or page overlay (desktop ergonomics)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeAllSheets(); closeRepoPage(); }
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
