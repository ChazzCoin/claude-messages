// Centralized click + submit + change + keydown handlers, delegated at the
// document level. Imports view/refresh functions and dispatches by data-action
// or data-form. Keeping it in one place mirrors the original inline script
// and avoids the ordering/ownership questions you'd hit with per-view listeners.

import { api } from './api.js';
import { escapeHtml } from './utils.js';
import { openForm, closeForm } from './shell.js';
import { navigate } from './router.js';
import {
  chatsCache, settingsCache, radarHandlesCache,
  flagsTab, calendarTab, currentView, currentChatId, currentRadarHandle,
  scheduleFormPicker,
  setSettingsCache, setFlagsTab, setCalendarTab, setRadarSignalsTab,
  setInboxTab,
} from './state.js';

import { refreshWorkbenchPanel } from './views/thread.js';
import { renderInboxView } from './views/inbox.js';
import { renderSettingsView } from './views/settings.js';
import { refreshFlagsList, renderFlagsView } from './views/flags.js';
import {
  refreshScheduledList, refreshScheduledCount,
} from './views/scheduled.js';
import {
  refreshCalendarList, renderCalendarView,
} from './views/calendar.js';
import {
  refreshRadarHandlesCache, renderRadarView, renderRadarDetail,
} from './views/radar.js';
import {
  renderAwayView, updateAwayPill,
} from './views/away.js';
import {
  renderAutoNotesView, refreshAutoNotesBadge,
} from './views/auto-notes.js';
import { refreshRules } from './views/rules.js';
import { runSearch } from './views/search.js';

let searchTimer = null;

/** Re-render whichever view currently shows auto-note rows (the dedicated
 *  page or the home dashboard). Used after any review/delete action. */
async function rerenderNotesView() {
  if (currentView === 'auto-notes') await renderAutoNotesView();
  else if (currentView === 'home') {
    const { renderHomeView } = await import('./views/home.js');
    await renderHomeView();
  }
}

/** Wire up every document-level listener once at startup. */
export function installActionHandlers() {
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
}

async function onClick(e) {
  // Action buttons / rows
  const btn = e.target.closest?.('[data-action]');
  if (!btn || btn.disabled) return;
  const action = btn.dataset.action;

  if (action === 'show-form')      { openForm(btn.dataset.target); return; }
  if (action === 'hide-form')      { closeForm(btn.dataset.target); return; }

  // Settings: reset AI context window to default
  if (action === 'reset-settings') {
    if (!confirm('Reset all settings to defaults?')) return;
    try {
      const r = await api('/api/settings', { method: 'PUT', body: { ai_context_count: 20 } });
      if (r.settings) setSettingsCache(r.settings);
      await renderSettingsView();
    } catch (err) { alert(`reset failed: ${err.message}`); }
    return;
  }

  // Navigation
  if (action === 'open-thread') {
    const chatId = parseInt(btn.dataset.chatId, 10);
    if (Number.isFinite(chatId)) navigate('thread', chatId);
    return;
  }
  if (action === 'back-to-inbox') { navigate('inbox'); return; }

  // Home dashboard "see all" links.
  if (action === 'open-inbox')      { setInboxTab('chats'); navigate('inbox'); return; }
  if (action === 'open-away')       { navigate('away'); return; }
  // Summon was folded into Galt — both legacy `open-summon` callers and
  // any direct /#/summon route end up on /#/galt now.
  if (action === 'open-summon')     { navigate('galt'); return; }
  if (action === 'open-auto-notes') { navigate('auto-notes'); return; }
  // Queue tabs now live on Inbox. Each open-* sets the inbox tab and
  // navigates to /#/inbox.
  if (action === 'open-calendar')   { setInboxTab('calendar'); navigate('inbox'); return; }
  if (action === 'open-flags')      { setInboxTab('flags'); navigate('inbox'); return; }
  if (action === 'open-scheduled')  { setInboxTab('scheduled'); navigate('inbox'); return; }
  if (action === 'open-queue')      { navigate('inbox'); return; }
  if (action === 'open-settings')   { navigate('settings'); return; }

  /* ---------- Reset prompt-card override ---------- */
  // Clears the override (sends empty string) so the built-in default runs
  // again. Triggered by the "Reset" button on each Galt prompt card.
  if (action === 'reset-prompt-card') {
    const key = btn.dataset.key;
    if (!key) return;
    if (!confirm(`Reset ${key} to the built-in default? Your custom text will be cleared.`)) return;
    try {
      const r = await api('/api/settings', { method: 'PUT', body: { [key]: '' } });
      if (r.settings) setSettingsCache(r.settings);
      if (currentView === 'galt' || currentView === 'prompts') {
        const { renderGaltView } = await import('./views/galt.js');
        await renderGaltView();
      }
    } catch (err) { alert(`reset failed: ${err.message}`); }
    return;
  }

  if (action === 'open-thread-by-handle') {
    const handle = btn.dataset.handle;
    const meta = chatsCache.find((c) => c.identifier === handle);
    if (meta) navigate('thread', meta.id);
    else alert('chat not found in current list');
    return;
  }

  /* ---------- Inbox tabs (chats / calendar / flags / scheduled) ---------- */
  if (action === 'inbox-tab') {
    const t = btn.dataset.tab;
    if (t === 'chats' || t === 'calendar' || t === 'flags' || t === 'scheduled') {
      setInboxTab(t);
      await renderInboxView();
    }
    return;
  }

  /* ---------- Flags ---------- */
  if (action === 'flags-tab') {
    setFlagsTab(btn.dataset.tab === 'all' ? 'all' : 'unreviewed');
    // Re-render the flags pane inside the Queue host (no targetEl == top
    // level, but we want to stay nested — pass the queue-content element).
    const target = document.getElementById('queue-content');
    await renderFlagsView(target || undefined);
    return;
  }
  if (action === 'review-flag') {
    const id = parseInt(btn.dataset.id, 10);
    if (!Number.isFinite(id)) return;
    try {
      await api(`/api/monitor/flags/${id}/review`, { method: 'POST', body: {} });
      await refreshFlagsList();
    } catch (err) { alert(`review failed: ${err.message}`); }
    return;
  }
  if (action === 'remove-flag') {
    const id = parseInt(btn.dataset.id, 10);
    if (!Number.isFinite(id)) return;
    try {
      await api(`/api/monitor/flags/${id}`, { method: 'DELETE' });
      await refreshFlagsList();
    } catch (err) { alert(`remove failed: ${err.message}`); }
    return;
  }

  /* ---------- Rules ---------- */
  if (action === 'toggle-rule') {
    const id = parseInt(btn.dataset.id, 10);
    const wasEnabled = btn.dataset.enabled === '1';
    if (!Number.isFinite(id)) return;
    try {
      await api(`/api/monitor/rules/${id}`, { method: 'PATCH', body: { enabled: !wasEnabled } });
      await refreshRules();
    } catch (err) { alert(`toggle failed: ${err.message}`); }
    return;
  }
  if (action === 'remove-rule') {
    const id = parseInt(btn.dataset.id, 10);
    if (!Number.isFinite(id)) return;
    if (!confirm('Remove this rule?')) return;
    try {
      await api(`/api/monitor/rules/${id}`, { method: 'DELETE' });
      await refreshRules();
    } catch (err) { alert(`remove failed: ${err.message}`); }
    return;
  }
  /* ---------- Scheduled ---------- */
  if (action === 'cancel-sched') {
    const id = parseInt(btn.dataset.id, 10);
    if (!Number.isFinite(id)) return;
    if (!confirm('Cancel this scheduled message?')) return;
    try {
      await api(`/api/scheduled/${id}`, { method: 'DELETE' });
      await refreshScheduledList();
    } catch (err) { alert(`cancel failed: ${err.message}`); }
    return;
  }

  /* ---------- AI summarize / dismiss ---------- */
  if (action === 'ai-summarize') {
    const chatId = parseInt(btn.dataset.chatId, 10);
    if (!Number.isFinite(chatId)) return;
    const status = document.querySelector('[data-toolbar-status]');
    const panel = document.querySelector('[data-summary-panel]');
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = '<span style="margin-right:6px;">⠋</span>Summarizing…';
    if (status) { status.className = 'toolbar-status'; status.textContent = ''; }
    try {
      const r = await api('/api/ai/summarize', {
        method: 'POST',
        body: { chat_id: chatId, count: settingsCache.ai_context_count },
      });
      if (panel) {
        panel.hidden = false;
        const tokens = r.usage ? `${r.usage.total_tokens} tok` : '';
        panel.innerHTML = `
          <div class="summary-head">
            <span>summary</span>
            <span class="badge">${r.turns} turns</span>
            <span style="margin-left:auto;text-transform:none;letter-spacing:0;">${escapeHtml(tokens)}</span>
          </div>
          <div class="summary-body">${escapeHtml(r.summary)}</div>
          <div class="summary-foot">
            <button class="btn ghost" data-action="dismiss-summary">Dismiss</button>
          </div>
        `;
      }
    } catch (err) {
      if (status) { status.className = 'toolbar-status err'; status.textContent = err.message; }
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
    return;
  }
  if (action === 'dismiss-summary') {
    const panel = document.querySelector('[data-summary-panel]');
    if (panel) { panel.hidden = true; panel.innerHTML = ''; }
    return;
  }

  /* ---------- Auto Notes ---------- */
  if (action === 'toggle-auto-notes') {
    const next = !settingsCache.auto_notes_enabled;
    try {
      const r = await api('/api/settings', { method: 'PUT', body: { auto_notes_enabled: next } });
      if (r.settings) setSettingsCache(r.settings);
      if (currentView === 'auto-notes') await renderAutoNotesView();
      else if (currentView === 'home') {
        const { renderHomeView } = await import('./views/home.js');
        await renderHomeView();
      }
    } catch (err) { alert(`toggle failed: ${err.message}`); }
    return;
  }

  /* ---------- Away mode ---------- */
  if (action === 'toggle-away-mode') {
    const next = !settingsCache.away_mode_enabled;
    if (settingsCache.away_mode_enabled && !next) {
      if (!confirm('Turn off away mode? Every active AI conversation will end immediately.')) return;
    }
    try {
      const r = await api('/api/settings', { method: 'PUT', body: { away_mode_enabled: next } });
      if (r.settings) setSettingsCache(r.settings);
      updateAwayPill();
      // Re-render whichever view shows this toggle. Away view gets its own
      // detailed render; Home gets the Switches grid refreshed.
      if (currentView === 'away') await renderAwayView();
      else if (currentView === 'home') {
        const { renderHomeView } = await import('./views/home.js');
        await renderHomeView();
      }
    } catch (err) { alert(`toggle failed: ${err.message}`); }
    return;
  }

  /* ---------- Summon mode ---------- */
  if (action === 'toggle-summon-mode') {
    const next = !settingsCache.summon_enabled;
    if (settingsCache.summon_enabled && !next) {
      if (!confirm('Turn off summon mode? Every active summon session will end immediately and the trigger phrase will stop working.')) return;
    }
    try {
      const r = await api('/api/settings', { method: 'PUT', body: { summon_enabled: next ? 1 : 0 } });
      if (r.settings) setSettingsCache(r.settings);
      if (currentView === 'summon') {
        const { renderSummonView } = await import('./views/summon.js');
        await renderSummonView();
      } else if (currentView === 'home') {
        const { renderHomeView } = await import('./views/home.js');
        await renderHomeView();
      }
    } catch (err) { alert(`toggle failed: ${err.message}`); }
    return;
  }
  if (action === 'toggle-away-contact') {
    const id = parseInt(btn.dataset.id, 10);
    const wasEnabled = btn.dataset.enabled === '1';
    if (!Number.isFinite(id)) return;
    try {
      await api(`/api/away/contacts/${id}`, { method: 'PATCH', body: { enabled: !wasEnabled } });
      await renderAwayView();
    } catch (err) { alert(`toggle failed: ${err.message}`); }
    return;
  }
  if (action === 'remove-away-contact') {
    const id = parseInt(btn.dataset.id, 10);
    if (!Number.isFinite(id)) return;
    try {
      await api(`/api/away/contacts/${id}`, { method: 'DELETE' });
      await renderAwayView();
    } catch (err) { alert(`remove failed: ${err.message}`); }
    return;
  }
  if (action === 'end-away-session') {
    const id = parseInt(btn.dataset.id, 10);
    if (!Number.isFinite(id)) return;
    if (!confirm('End this session? The AI will stop replying to this contact.')) return;
    try {
      await api(`/api/away/sessions/${id}`, { method: 'DELETE' });
      await renderAwayView();
    } catch (err) { alert(`end failed: ${err.message}`); }
    return;
  }
  if (action === 'end-summon-session') {
    const id = parseInt(btn.dataset.id, 10);
    if (!Number.isFinite(id)) return;
    if (!confirm('Dismiss Galt from this conversation?')) return;
    try {
      await api(`/api/summon/sessions/${id}`, { method: 'DELETE' });
      // Re-render whichever view is up — summon page, home, or away (legacy).
      if (currentView === 'summon') {
        const { renderSummonView } = await import('./views/summon.js');
        await renderSummonView();
      } else if (currentView === 'home') {
        const { renderHomeView } = await import('./views/home.js');
        await renderHomeView();
      } else if (currentView === 'away') {
        await renderAwayView();
      }
    } catch (err) { alert(`dismiss failed: ${err.message}`); }
    return;
  }
  if (action === 'review-auto-note') {
    const id = parseInt(btn.dataset.id, 10);
    if (!Number.isFinite(id)) return;
    try {
      await api(`/api/auto-notes/${id}/review`, { method: 'POST', body: {} });
      await refreshAutoNotesBadge();
      await rerenderNotesView();
    } catch (err) { alert(`review failed: ${err.message}`); }
    return;
  }
  if (action === 'review-all-auto-notes') {
    try {
      await api('/api/auto-notes/review-all', { method: 'POST', body: {} });
      await refreshAutoNotesBadge();
      await rerenderNotesView();
    } catch (err) { alert(`review all failed: ${err.message}`); }
    return;
  }
  if (action === 'delete-auto-note') {
    const id = parseInt(btn.dataset.id, 10);
    if (!Number.isFinite(id)) return;
    try {
      await api(`/api/auto-notes/${id}`, { method: 'DELETE' });
      await refreshAutoNotesBadge();
      await rerenderNotesView();
    } catch (err) { alert(`delete failed: ${err.message}`); }
    return;
  }

  /* ---------- Radar ---------- */
  if (action === 'open-radar') {
    const handle = btn.dataset.handle;
    if (handle) navigate('radar-detail', handle);
    return;
  }
  if (action === 'radar-back') { navigate('radar'); return; }
  if (action === 'radar-cat') {
    setRadarSignalsTab(btn.dataset.cat || 'all');
    if (currentRadarHandle) await renderRadarDetail(currentRadarHandle);
    return;
  }
  if (action === 'toggle-radar') {
    const handle = btn.dataset.handle;
    if (!handle) return;
    const meta = chatsCache.find((c) => c.identifier === handle);
    const label = meta?.contact_name || meta?.display_name || null;
    const onRadar = radarHandlesCache.has(handle);
    btn.disabled = true;
    try {
      if (onRadar) {
        const r = await api('/api/radar/contacts');
        const existing = (r.contacts || []).find((c) => c.handle === handle);
        if (existing) await api(`/api/radar/contacts/${existing.id}`, { method: 'DELETE' });
      } else {
        await api('/api/radar/contacts', { method: 'POST', body: { handle, label } });
      }
      await refreshRadarHandlesCache();
      // Refresh the workbench: identity card (radar pill flips) + radar
      // card (appears when turning on, disappears when turning off).
      if (currentView === 'thread' && currentChatId != null) {
        await refreshWorkbenchPanel('identity', handle, currentChatId);
        await refreshWorkbenchPanel('radar', handle, currentChatId);
      }
    } catch (err) { alert(`radar toggle failed: ${err.message}`); }
    finally { btn.disabled = false; }
    return;
  }
  if (action === 'toggle-radar-enabled') {
    const id = parseInt(btn.dataset.id, 10);
    const wasEnabled = btn.dataset.enabled === '1';
    if (!Number.isFinite(id)) return;
    try {
      await api(`/api/radar/contacts/${id}`, { method: 'PATCH', body: { enabled: !wasEnabled } });
      await renderRadarView();
    } catch (err) { alert(`toggle failed: ${err.message}`); }
    return;
  }
  if (action === 'remove-radar') {
    const id = parseInt(btn.dataset.id, 10);
    if (!Number.isFinite(id)) return;
    if (!confirm('Remove this contact from radar? Existing signals stay in the database.')) return;
    try {
      await api(`/api/radar/contacts/${id}`, { method: 'DELETE' });
      await refreshRadarHandlesCache();
      await renderRadarView();
    } catch (err) { alert(`remove failed: ${err.message}`); }
    return;
  }
  if (action === 'remove-radar-signal') {
    const id = parseInt(btn.dataset.id, 10);
    if (!Number.isFinite(id)) return;
    try {
      await api(`/api/radar/signals/${id}`, { method: 'DELETE' });
      if (currentRadarHandle) await renderRadarDetail(currentRadarHandle);
    } catch (err) { alert(`remove failed: ${err.message}`); }
    return;
  }
  if (action === 'radar-regenerate') {
    const handle = btn.dataset.handle;
    if (!handle) return;
    const status = btn.closest('form')?.querySelector('[data-error]');
    if (status) { status.classList.remove('ok', 'err'); status.textContent = ''; }
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = '<span style="margin-right:6px;">⠋</span>Distilling…';
    try {
      const r = await api(`/api/radar/contacts/by-handle/${encodeURIComponent(handle)}/regenerate`, {
        method: 'POST', body: {},
      });
      const tok = r.usage ? ` · ${r.usage.total_tokens} tok` : '';
      if (status) {
        status.classList.add('ok');
        status.textContent = `✓ regenerated · ${r.signal_count} signals${tok}`;
      }
      // Refresh the right surface — workbench panel on the thread page,
      // global radar detail otherwise.
      if (currentView === 'thread' && currentChatId != null) {
        await refreshWorkbenchPanel('radar', handle, currentChatId);
      } else {
        await renderRadarDetail(handle);
      }
    } catch (err) {
      if (status) { status.classList.add('err'); status.textContent = err.message; }
      btn.disabled = false;
      btn.innerHTML = orig;
    }
    return;
  }

  /* ---------- Calendar ---------- */
  if (action === 'cal-tab') {
    setCalendarTab(btn.dataset.tab || 'pending');
    const target = document.getElementById('queue-content');
    await renderCalendarView(target || undefined);
    return;
  }
  if (action === 'cal-export') {
    const id = parseInt(btn.dataset.id, 10);
    if (!Number.isFinite(id)) return;
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = '<span style="margin-right:6px;">⠋</span>Exporting…';
    try {
      await api(`/api/calendar/proposals/${id}/export`, { method: 'POST', body: {} });
      await refreshCalendarList();
    } catch (err) {
      alert(`export failed: ${err.message}`);
      btn.disabled = false;
      btn.innerHTML = orig;
    }
    return;
  }
  if (action === 'cal-dismiss') {
    const id = parseInt(btn.dataset.id, 10);
    if (!Number.isFinite(id)) return;
    try {
      await api(`/api/calendar/proposals/${id}/dismiss`, { method: 'POST', body: {} });
      await refreshCalendarList();
    } catch (err) { alert(`dismiss failed: ${err.message}`); }
    return;
  }
  if (action === 'cal-remove') {
    const id = parseInt(btn.dataset.id, 10);
    if (!Number.isFinite(id)) return;
    if (!confirm('Delete this proposal?')) return;
    try {
      await api(`/api/calendar/proposals/${id}`, { method: 'DELETE' });
      await refreshCalendarList();
    } catch (err) { alert(`delete failed: ${err.message}`); }
    return;
  }

  // Manual AI draft flow ('ai-draft-row', 'ai-draft', 'ai-draft-variants',
  // 'save-variant', 'dismiss-variants', 'vp-regenerate', 'stage',
  // 'schedule' on a draft) was retired when Galt became the system-wide
  // AI. Server endpoints /api/drafts/:id/* still exist (orphaned) but
  // no UI feeds them. Direct send below is preserved.

  // Direct send — what the user typed, no AI involvement. Empty body is a no-op.
  if (action === 'send-direct') {
    const chatId = parseInt(btn.dataset.chatId, 10);
    if (!Number.isFinite(chatId)) return;
    const ta = document.querySelector('[data-compose-input]');
    const status = document.querySelector('[data-compose-status]');
    const body = (ta?.value || '').trim();
    if (!body) {
      if (status) { status.className = 'compose-status err'; status.textContent = 'type something first'; }
      return;
    }
    btn.disabled = true;
    const originalLabel = btn.innerHTML;
    btn.innerHTML = '<span style="margin-right:6px;">⠋</span>Sending…';
    if (status) { status.className = 'compose-status'; status.textContent = ''; }
    try {
      await api('/api/send', { method: 'POST', body: { chat_id: chatId, body } });
      if (ta) ta.value = '';
      if (status) { status.className = 'compose-status ok'; status.textContent = '✓ sent'; }
      // Watcher will fire message.new SSE shortly to reflect the send.
    } catch (err) {
      if (status) { status.className = 'compose-status err'; status.textContent = err.message; }
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalLabel;
    }
    return;
  }

  /* ---------- OpenAI key clear ---------- */
  if (action === 'oa-clear-key') {
    if (!confirm('Clear the saved OpenAI API key? AI features will use .env if a key is set there, otherwise return 503.')) return;
    try {
      const r = await api('/api/settings', {
        method: 'PUT',
        body: { openai_api_key: '' },
      });
      if (r.settings) setSettingsCache(r.settings);
      await renderSettingsView();
    } catch (err) { alert(`clear failed: ${err.message}`); }
    return;
  }

  /* ---------- Thread notes ---------- */
  if (action === 'remove-note') {
    const id = parseInt(btn.dataset.id, 10);
    if (!Number.isFinite(id)) return;
    try {
      await api(`/api/contacts/notes/${id}`, { method: 'DELETE' });
      const meta = chatsCache.find((c) => c.id === currentChatId);
      if (meta?.identifier) await refreshWorkbenchPanel('notes', meta.identifier, currentChatId);
    } catch (err) { alert(`remove failed: ${err.message}`); }
    return;
  }

  // 'stage' / 'approve' / 'discard' draft-queue handlers retired with
  // the rest of the manual AI draft flow. Server endpoints still exist
  // but no UI feeds them.
}

async function onSubmit(e) {
  const form = e.target.closest?.('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form;
  const errEl = form.querySelector('[data-error]');
  if (errEl) errEl.textContent = '';
  const data = Object.fromEntries(new FormData(form));
  const submitBtn = form.querySelector('button[type="submit"]');
  const originalLabel = submitBtn?.textContent;
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Saving…'; }

  try {
    if (kind === 'monitor-rule') {
      const payload = {
        name: data.name,
        kind: data.kind || 'flag',
        scope_type: data.scope_type,
        scope_handle: data.scope_type === 'contact' ? (data.scope_handle || '') : null,
        prompt: data.kind === 'calendar' ? '' : (data.prompt || ''),
      };
      await api('/api/monitor/rules', { method: 'POST', body: payload });
      closeForm('form-monitor-rule');
      await refreshRules();
    } else if (kind === 'away-contact') {
      await api('/api/away/contacts', {
        method: 'POST',
        body: { handle: data.handle, label: data.label || null },
      });
      closeForm('form-away-contact');
      await renderAwayView();
    } else if (kind === 'away-greeting') {
      // Home-page quick-edit form for just the greeting. Lighter than the
      // full away-config form on the Away view.
      const r = await api('/api/settings', {
        method: 'PUT',
        body: { away_message: data.away_message || '' },
      });
      if (r.settings) setSettingsCache(r.settings);
      if (errEl) {
        errEl.classList.add('ok');
        errEl.textContent = '✓ saved';
        setTimeout(() => { errEl.classList.remove('ok'); errEl.textContent = ''; }, 2500);
      }
    } else if (kind === 'summon-config') {
      // The on/off master switch lives in the page header (toggle-summon-mode)
      // — this form only owns activation + safety knobs. Prompt content
      // (persona, custom prompt override) lives on #/galt.
      const trigger = (data.summon_trigger_phrase || '').trim();
      const endP = (data.summon_end_phrase || '').trim();
      if (!trigger) throw new Error('Trigger phrase cannot be empty');
      if (!endP) throw new Error('End phrase cannot be empty');
      const r = await api('/api/settings', {
        method: 'PUT',
        body: {
          summon_trigger_phrase: trigger,
          summon_end_phrase: endP,
          summon_max_replies_per_session: parseInt(data.summon_max_replies_per_session, 10),
          summon_idle_timeout_min: parseInt(data.summon_idle_timeout_min, 10),
        },
      });
      if (r.settings) setSettingsCache(r.settings);
      if (errEl) {
        errEl.classList.add('ok');
        errEl.textContent = '✓ saved';
        setTimeout(() => { errEl.classList.remove('ok'); errEl.textContent = ''; }, 2500);
      }
    } else if (kind === 'away-config') {
      // Checkbox: missing key in form data = unchecked. Coerce to bool.
      const delayEnabled = data.away_send_delay_enabled === 'on' ? 1 : 0;
      const r = await api('/api/settings', {
        method: 'PUT',
        body: {
          away_max_replies_per_session: parseInt(data.away_max_replies_per_session, 10),
          away_send_delay_enabled: delayEnabled,
        },
      });
      if (r.settings) setSettingsCache(r.settings);
      if (errEl) {
        errEl.classList.add('ok');
        errEl.textContent = '✓ saved';
        setTimeout(() => { errEl.classList.remove('ok'); errEl.textContent = ''; }, 2500);
      }
    } else if (kind === 'prompts-away' || kind === 'prompts-summon' || kind === 'prompts-universal' || kind === 'prompts-wrappers') {
      // Legacy section-level prompts form. Kept for compatibility — current
      // Galt page renders per-card forms (see kind === 'prompt-card' below).
      const r = await api('/api/settings', { method: 'PUT', body: { ...data } });
      if (r.settings) setSettingsCache(r.settings);
      if (errEl) {
        errEl.classList.add('ok');
        errEl.textContent = '✓ saved';
        setTimeout(() => { errEl.classList.remove('ok'); errEl.textContent = ''; }, 2500);
      }
    } else if (kind === 'prompt-card') {
      // Per-card prompt save. The form has a single named textarea whose
      // name matches the AppSettings column. PUT /api/settings gates each
      // known key, so adding a prompt to the registry "just works" without
      // any change here. After save, re-render Galt so the override-state
      // pill flips and the type-stripe lights up.
      const r = await api('/api/settings', { method: 'PUT', body: { ...data } });
      if (r.settings) setSettingsCache(r.settings);
      if (errEl) {
        errEl.classList.add('ok');
        errEl.textContent = '✓ saved';
        setTimeout(() => { errEl.classList.remove('ok'); errEl.textContent = ''; }, 2500);
      }
      if (currentView === 'galt' || currentView === 'prompts') {
        const { renderGaltView } = await import('./views/galt.js');
        await renderGaltView();
      }
    } else if (kind === 'auto-notes-config') {
      // Excluded handles textarea: one per line, trim, drop blanks.
      const excluded = String(data.auto_notes_excluded_handles || '')
        .split('\n')
        .map((h) => h.trim())
        .filter((h) => h.length > 0);
      const r = await api('/api/settings', {
        method: 'PUT',
        body: {
          auto_notes_enabled: data.auto_notes_enabled === 'on' ? 1 : 0,
          auto_notes_min_confidence: parseInt(data.auto_notes_min_confidence, 10) || 0,
          auto_notes_excluded_handles: JSON.stringify(excluded),
        },
      });
      if (r.settings) setSettingsCache(r.settings);
      if (errEl) {
        errEl.classList.add('ok');
        errEl.textContent = '✓ saved';
        setTimeout(() => { errEl.classList.remove('ok'); errEl.textContent = ''; }, 2500);
      }
      if (currentView === 'auto-notes') await renderAutoNotesView();
    } else if (kind === 'radar-profile') {
      const handle = form.dataset.handle;
      await api(`/api/radar/contacts/by-handle/${encodeURIComponent(handle)}/profile`, {
        method: 'PUT',
        body: { profile: data.profile || '' },
      });
      if (errEl) {
        errEl.classList.add('ok');
        errEl.textContent = '✓ profile saved';
        setTimeout(() => { errEl.classList.remove('ok'); errEl.textContent = ''; }, 2500);
      }
    } else if (kind === 'schedule') {
      const ts = scheduleFormPicker?.getMs();
      if (!Number.isFinite(ts)) throw new Error('pick a date and time first');
      if (ts <= Date.now()) throw new Error('that time is in the past');
      await api('/api/scheduled', {
        method: 'POST',
        body: { chat_id: parseInt(data.chat_id, 10), body: data.body, send_at: ts },
      });
      closeForm('form-schedule');
      await refreshScheduledList();
    } else if (kind === 'settings') {
      const r = await api('/api/settings', {
        method: 'PUT',
        body: { ai_context_count: parseInt(data.ai_context_count, 10) },
      });
      if (r.settings) setSettingsCache(r.settings);
      if (errEl) {
        errEl.classList.add('ok');
        errEl.textContent = `✓ saved · ai_context_count = ${settingsCache.ai_context_count}`;
        setTimeout(() => { errEl.classList.remove('ok'); errEl.textContent = ''; }, 2500);
      }
    } else if (kind === 'contact-note') {
      const handle = form.dataset.handle;
      const body = (data.body || '').trim();
      if (!body) {
        if (errEl) { errEl.classList.add('err'); errEl.textContent = 'note body required'; }
      } else {
        await api('/api/contacts/notes', { method: 'POST', body: { handle, body } });
        form.reset();
        await refreshWorkbenchPanel('notes', handle, currentChatId);
      }
    } else if (kind === 'contact-profile') {
      const handle = form.dataset.handle;
      const profile = typeof data.profile === 'string' ? data.profile : '';
      await api('/api/contacts/profile', { method: 'PUT', body: { handle, profile } });
      // Re-render the workbench profile card so "last updated" + filled-
      // state pill refresh.
      await refreshWorkbenchPanel('profile', handle, currentChatId);
      const newErr = document.querySelector(`form[data-form="contact-profile"][data-handle="${handle.replace(/"/g, '\\"')}"] [data-error]`);
      if (newErr) {
        newErr.classList.add('ok');
        newErr.textContent = '✓ saved';
        setTimeout(() => { newErr.classList.remove('ok'); newErr.textContent = ''; }, 2500);
      }
    } else if (kind === 'openai') {
      // Empty input means "no change" — only send fields that have content,
      // so accidentally submitting a blank form doesn't wipe a configured key.
      const body = {};
      if (typeof data.openai_api_key === 'string' && data.openai_api_key.trim().length > 0) {
        body.openai_api_key = data.openai_api_key.trim();
      }
      if (typeof data.openai_model === 'string') {
        // Model field can be cleared (empty string is a valid "use default" value).
        body.openai_model = data.openai_model.trim();
      }
      if (Object.keys(body).length === 0) {
        if (errEl) { errEl.classList.add('err'); errEl.textContent = 'nothing to save — paste a key or change the model'; }
      } else {
        const r = await api('/api/settings', { method: 'PUT', body });
        if (r.settings) setSettingsCache(r.settings);
        // Re-render so masked-state + last4 + Clear button reflect the save.
        await renderSettingsView();
        const newErr = document.querySelector('form[data-form="openai"] [data-error]');
        if (newErr) {
          newErr.classList.add('ok');
          newErr.textContent = '✓ saved';
          setTimeout(() => { newErr.classList.remove('ok'); newErr.textContent = ''; }, 2500);
        }
      }
    }
  } catch (err) {
    if (errEl) {
      errEl.classList.add('err');
      errEl.textContent = err.message;
    }
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = originalLabel ?? 'Save'; }
  }
}

// ⌘ / Ctrl + Enter inside compose textareas = trigger their primary submit.
function onKeydown(e) {
  if (!(e.target instanceof HTMLTextAreaElement)) return;
  if (e.key !== 'Enter') return;
  if (!(e.metaKey || e.ctrlKey)) return;

  if (e.target.matches('[data-compose-input]')) {
    e.preventDefault();
    const btn = document.querySelector('[data-action="send-direct"]');
    if (btn && !btn.disabled) btn.click();
  } else if (e.target.matches('form.note-add textarea')) {
    e.preventDefault();
    const btn = e.target.closest('form')?.querySelector('button[type="submit"]');
    if (btn && !btn.disabled) btn.click();
  }
}

// Live search input (debounced).
function onInput(e) {
  if (e.target instanceof HTMLInputElement && e.target.id === 'search-input') {
    const q = e.target.value.trim();
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(q), 200);
  }
}

// Monitor-rule form: scope reveal + kind reveal (for the Rules add-rule form).
function onChange(e) {
  if (e.target instanceof HTMLSelectElement && e.target.matches('[data-scope-select]')) {
    const form = e.target.closest('form');
    const row = form?.querySelector('[data-scope-handle-row]');
    const input = row?.querySelector('input[name="scope_handle"]');
    if (!row || !input) return;
    if (e.target.value === 'contact') {
      row.classList.add('show');
      input.required = true;
    } else {
      row.classList.remove('show');
      input.required = false;
      input.value = '';
    }
  }
  if (e.target instanceof HTMLSelectElement && e.target.matches('[data-kind-select]')) {
    const form = e.target.closest('form');
    const row = form?.querySelector('[data-prompt-row]');
    const ta = row?.querySelector('textarea[name="prompt"]');
    if (!row || !ta) return;
    if (e.target.value === 'calendar') {
      row.style.display = 'none';
      ta.required = false;
      ta.value = '';
    } else {
      row.style.display = '';
      ta.required = true;
    }
  }
}
