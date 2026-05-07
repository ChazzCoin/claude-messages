// Centralized click + submit + change + keydown handlers, delegated at the
// document level. Imports view/refresh functions and dispatches by data-action
// or data-form. Keeping it in one place mirrors the original inline script
// and avoids the ordering/ownership questions you'd hit with per-view listeners.

import { api } from './api.js';
import { escapeHtml } from './utils.js';
import { openForm, closeForm } from './shell.js';
import { openModal } from './components/modal.js';
import { mountDatePicker } from './components/datepicker.js';
import { navigate } from './router.js';
import {
  chatsCache, settingsCache, radarHandlesCache,
  flagsTab, calendarTab, currentView, currentChatId, currentRadarHandle,
  pendingVariants, scheduleFormPicker,
  setSettingsCache, setFlagsTab, setCalendarTab, setRadarSignalsTab,
  setQueueTab, setPendingVariants,
} from './state.js';

import { refreshDrafts } from './views/drafts.js';
import { renderThreadToolbar, renderVariantCards } from './views/thread.js';
import { loadAndRenderNotes, loadAndRenderProfile } from './views/inbox.js';
import { renderSettingsView } from './views/settings.js';
import { refreshFlagsList, renderFlagsView } from './views/flags.js';
import {
  refreshScheduledList, refreshScheduledCount,
} from './views/scheduled.js';
import {
  refreshCalendarList, renderCalendarView,
} from './views/calendar.js';
import { renderQueueView } from './views/queue.js';
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

  // Settings: reset to defaults
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
  if (action === 'open-inbox')      { navigate('inbox'); return; }
  if (action === 'open-away')       { navigate('away'); return; }
  if (action === 'open-summon')     { navigate('summon'); return; }
  if (action === 'open-auto-notes') { navigate('auto-notes'); return; }
  if (action === 'open-calendar')   { setQueueTab('calendar'); navigate('queue'); return; }
  if (action === 'open-queue')      { navigate('queue'); return; }

  if (action === 'open-thread-by-handle') {
    const handle = btn.dataset.handle;
    const meta = chatsCache.find((c) => c.identifier === handle);
    if (meta) navigate('thread', meta.id);
    else alert('chat not found in current list');
    return;
  }

  /* ---------- Queue (consolidated calendar / flags / scheduled) ---------- */
  if (action === 'queue-tab') {
    const t = btn.dataset.tab;
    if (t === 'calendar' || t === 'flags' || t === 'scheduled') {
      setQueueTab(t);
      await renderQueueView();
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
      await renderAwayView();
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
      // Re-render the toolbar so the button label flips.
      if (currentView === 'thread' && currentChatId != null) {
        const tb = document.getElementById('thread-toolbar');
        if (tb) tb.innerHTML = renderThreadToolbar(currentChatId);
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
      await renderRadarDetail(handle);
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

  /* ---------- Drafts ---------- */
  if (action === 'schedule') {
    const id = btn.dataset.id;
    if (!id) return;
    const card = btn.closest('.draft');
    const recipient = card?.querySelector('.draft-name')?.textContent?.trim() || 'this contact';
    const pickerEl = document.createElement('div');
    let modalPicker = null;
    openModal({
      title: `Schedule send to ${recipient}`,
      contentEl: pickerEl,
      confirmLabel: 'Schedule',
      onConfirm: async () => {
        const ts = modalPicker?.getMs();
        if (!Number.isFinite(ts)) throw new Error('pick a date and time first');
        if (ts <= Date.now()) throw new Error('that time is in the past');
        await api(`/api/drafts/${id}/schedule`, { method: 'POST', body: { send_at: ts } });
        refreshScheduledCount();
        await refreshDrafts();
      },
    });
    modalPicker = mountDatePicker(pickerEl);
    return;
  }

  // One-click predict from the inbox row (last N msgs, no extra prompt).
  if (action === 'ai-draft-row') {
    const chatId = parseInt(btn.dataset.chatId, 10);
    if (!Number.isFinite(chatId)) return;
    e.preventDefault();
    e.stopPropagation();

    const original = btn.innerHTML;
    btn.disabled = true;
    btn.classList.remove('ok', 'err');
    btn.classList.add('busy');

    const ctxCount = settingsCache.ai_context_count;
    const titleBase = `Predict and draft a reply (last ${ctxCount} messages)`;

    try {
      const r = await api('/api/ai/draft', {
        method: 'POST', body: { chat_id: chatId, save: true },
      });
      btn.classList.remove('busy');
      if (r.skipped) {
        btn.classList.add('err');
        btn.title = 'model returned SKIP — no draft saved';
      } else {
        btn.classList.add('ok');
        btn.title = `draft saved · ${r.thread.length} turns of context${r.usage ? ' · ' + r.usage.total_tokens + ' tok' : ''}`;
        await refreshDrafts();
      }
      setTimeout(() => {
        btn.classList.remove('ok', 'err');
        btn.title = titleBase;
        btn.innerHTML = original;
        btn.disabled = false;
      }, 2500);
    } catch (err) {
      btn.classList.remove('busy');
      btn.classList.add('err');
      btn.title = err.message;
      setTimeout(() => {
        btn.classList.remove('err');
        btn.title = titleBase;
        btn.innerHTML = original;
        btn.disabled = false;
      }, 3000);
    }
    return;
  }

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
      // Optimistic refresh — the watcher will also fire message.new SSE shortly.
      await refreshDrafts();
    } catch (err) {
      if (status) { status.className = 'compose-status err'; status.textContent = err.message; }
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalLabel;
    }
    return;
  }

  if (action === 'ai-draft-variants') {
    const chatId = parseInt(btn.dataset.chatId, 10);
    if (!Number.isFinite(chatId)) return;
    const ta = document.querySelector('[data-compose-input]');
    const tempSel = document.querySelector('[data-temperament-input]');
    const status = document.querySelector('[data-compose-status]');
    const variantsEl = document.querySelector('[data-variants]');
    const note = (ta?.value || '').trim();
    const temperament = tempSel?.value || 'normal';

    btn.disabled = true;
    const originalLabel = btn.innerHTML;
    btn.innerHTML = '<span style="margin-right:6px;">⠋</span>Generating 3…';
    if (status) { status.className = 'compose-status'; status.textContent = ''; }

    try {
      const r = await api('/api/ai/draft', {
        method: 'POST',
        body: { chat_id: chatId, save: false, count: 3, context_note: note, temperament },
      });
      const next = {
        variants: r.variants,
        chat_id: r.chat_id,
        handle: r.handle,
        contact_name: r.contact_name,
        source_msg_guid: r.source_msg_guid,
        model: r.model,
        usage: r.usage,
        temperament: r.temperament,
        contextNote: note,
        voice_profile_applied: r.voice_profile_applied,
        thread_turns: r.thread_turns,
      };
      setPendingVariants(next);
      if (variantsEl) variantsEl.innerHTML = renderVariantCards(next);
      if (status) {
        status.className = 'compose-status ok';
        const tokens = r.usage ? ` · ${r.usage.total_tokens} tok` : '';
        status.textContent = `${r.variants.filter((v) => !v.skipped).length} of ${r.variants.length} usable${tokens} · pick one`;
      }
    } catch (err) {
      if (status) { status.className = 'compose-status err'; status.textContent = err.message; }
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalLabel;
    }
    return;
  }

  if (action === 'save-variant') {
    if (!pendingVariants) return;
    const idx = parseInt(btn.dataset.index, 10);
    const usable = pendingVariants.variants.filter((v) => !v.skipped && v.body.trim().length > 0);
    const chosen = usable[idx];
    if (!chosen) return;

    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = 'Saving…';

    try {
      const tokenLine = pendingVariants.usage
        ? `tokens: ${pendingVariants.usage.prompt_tokens}+${pendingVariants.usage.completion_tokens}`
        : 'tokens: ?';
      const tempLine = pendingVariants.temperament && pendingVariants.temperament !== 'normal'
        ? ` · temperament: ${pendingVariants.temperament}` : '';
      const noteLine = pendingVariants.contextNote ? ` · note: ${JSON.stringify(pendingVariants.contextNote)}` : '';
      const vpLine = pendingVariants.voice_profile_applied ? ' · voice-profile: applied' : '';
      const variantLine = ` · variant ${idx + 1} of ${usable.length}`;

      await api('/api/drafts', {
        method: 'POST',
        body: {
          chat_id: pendingVariants.chat_id,
          handle: pendingVariants.handle,
          body: chosen.body,
          source_msg_guid: pendingVariants.source_msg_guid,
          reasoning: `AI · model=${pendingVariants.model} · context=${pendingVariants.thread_turns} turns · ${tokenLine}${vpLine}${tempLine}${noteLine}${variantLine}`,
        },
      });
      const variantsEl = document.querySelector('[data-variants]');
      const status = document.querySelector('[data-compose-status]');
      const ta = document.querySelector('[data-compose-input]');
      if (variantsEl) variantsEl.innerHTML = '';
      if (ta) ta.value = '';
      if (status) { status.className = 'compose-status ok'; status.textContent = '✓ saved to drafts'; }
      setPendingVariants(null);
      await refreshDrafts();
    } catch (err) {
      alert(`save failed: ${err.message}`);
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
    return;
  }

  if (action === 'dismiss-variants') {
    const variantsEl = document.querySelector('[data-variants]');
    if (variantsEl) variantsEl.innerHTML = '';
    setPendingVariants(null);
    const status = document.querySelector('[data-compose-status]');
    if (status) { status.className = 'compose-status'; status.textContent = ''; }
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

  /* ---------- Voice profile regenerate ---------- */
  if (action === 'vp-regenerate') {
    const form = btn.closest('form[data-form="voice-profile"]');
    if (!form) return;
    const sample = parseInt(form.querySelector('[name="voice_profile_sample_count"]').value, 10);
    const userContext = form.querySelector('[name="voice_profile_user_context"]').value;
    const errEl = form.querySelector('[data-error]');
    if (errEl) { errEl.classList.remove('ok', 'err'); errEl.textContent = ''; }

    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span style="margin-right:6px;">⠋</span>Reading chat.db & calling model…';
    try {
      const r = await api('/api/ai/voice-profile/regenerate', {
        method: 'POST',
        body: { sample_count: sample, user_context: userContext },
      });
      if (r.settings) setSettingsCache(r.settings);
      await renderSettingsView();
      const newErr = document.querySelector('form[data-form="voice-profile"] [data-error]');
      if (newErr) {
        newErr.classList.add('ok');
        const tok = r.usage ? ` · ${r.usage.total_tokens} tok` : '';
        newErr.textContent = `✓ regenerated · ${r.sample_count} samples${tok}`;
      }
    } catch (err) {
      if (errEl) { errEl.classList.add('err'); errEl.textContent = err.message; }
      btn.disabled = false;
      btn.innerHTML = original;
    }
    return;
  }

  /* ---------- Thread AI draft ---------- */
  if (action === 'ai-draft') {
    const chatId = parseInt(btn.dataset.chatId, 10);
    if (!Number.isFinite(chatId)) return;
    const ctxInput = document.querySelector('[data-ctx-input]');
    const status = document.querySelector('[data-toolbar-status]');
    const ctx = parseInt(ctxInput?.value, 10);
    const contextCount = Number.isFinite(ctx) ? Math.max(1, Math.min(50, ctx)) : 10;

    btn.disabled = true;
    const originalLabel = btn.innerHTML;
    btn.innerHTML = '<span style="margin-right:6px;">⠋</span>Drafting…';
    if (status) { status.className = 'toolbar-status'; status.textContent = ''; }

    try {
      const r = await api('/api/ai/draft', {
        method: 'POST',
        body: { chat_id: chatId, context_count: contextCount, save: true },
      });
      if (r.skipped) {
        if (status) { status.className = 'toolbar-status err'; status.textContent = 'model returned SKIP — no draft saved'; }
      } else {
        const tokens = r.usage ? ` · ${r.usage.total_tokens} tok` : '';
        if (status) { status.className = 'toolbar-status ok'; status.textContent = `✓ saved · ${r.thread.length} turns of context${tokens}`; }
        await refreshDrafts();
      }
    } catch (err) {
      if (status) { status.className = 'toolbar-status err'; status.textContent = err.message; }
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalLabel;
    }
    return;
  }

  /* ---------- Thread notes ---------- */
  if (action === 'remove-note') {
    const id = parseInt(btn.dataset.id, 10);
    if (!Number.isFinite(id)) return;
    try {
      await api(`/api/contacts/notes/${id}`, { method: 'DELETE' });
      const meta = chatsCache.find((c) => c.id === currentChatId);
      if (meta?.identifier) await loadAndRenderNotes(meta.identifier);
    } catch (err) { alert(`remove failed: ${err.message}`); }
    return;
  }

  /* ---------- Stage in Messages ---------- */
  if (action === 'stage') {
    const id = btn.dataset.id;
    if (!id) return;
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = '<span style="margin-right:6px;">⠋</span>Opening Messages…';
    try {
      await api(`/api/drafts/${id}/stage`, { method: 'POST', body: {} });
      await refreshDrafts();
    } catch (err) {
      alert(`stage failed: ${err.message}`);
      btn.disabled = false;
      btn.innerHTML = orig;
    }
    return;
  }

  /* ---------- Approve / discard (id-based draft actions) ---------- */
  const id = btn.dataset.id;
  if (!id) return;

  if (action === 'approve') {
    const card = btn.closest('.draft');
    const handle = card?.querySelector('.draft-name')?.textContent || 'this contact';
    if (!confirm(`Send this reply to ${handle}?`)) return;
  }

  btn.disabled = true;
  const originalText = btn.textContent;
  if (action === 'approve') btn.textContent = 'Sending…';
  if (action === 'discard') btn.textContent = 'Dismissing…';

  try {
    if (action === 'approve') {
      await api(`/api/drafts/${id}/approve`, { method: 'POST', body: {} });
    } else if (action === 'discard') {
      await api(`/api/drafts/${id}/discard`, { method: 'POST', body: {} });
    } else {
      return;
    }
    await refreshDrafts();
  } catch (err) {
    alert(`${action} failed: ${err.message}`);
    btn.disabled = false;
    btn.textContent = originalText;
  }
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
      // Checkbox: missing key in form data = unchecked. Coerce to bool.
      const summonOn = data.summon_enabled === 'on' ? 1 : 0;
      const trigger = (data.summon_trigger_phrase || '').trim();
      const endP = (data.summon_end_phrase || '').trim();
      if (!trigger) throw new Error('Trigger phrase cannot be empty');
      if (!endP) throw new Error('End phrase cannot be empty');
      const r = await api('/api/settings', {
        method: 'PUT',
        body: {
          summon_enabled: summonOn,
          summon_trigger_phrase: trigger,
          summon_end_phrase: endP,
          summon_persona: data.summon_persona || '',
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
          away_message: data.away_message || '',
          away_persona: data.away_persona || '',
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
    } else if (kind === 'draft') {
      await api('/api/drafts', {
        method: 'POST',
        body: { chat_id: parseInt(data.chat_id, 10), body: data.body },
      });
      closeForm('form-draft');
      await refreshDrafts();
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
        await loadAndRenderNotes(handle);
      }
    } else if (kind === 'contact-profile') {
      const handle = form.dataset.handle;
      const profile = typeof data.profile === 'string' ? data.profile : '';
      await api('/api/contacts/profile', { method: 'PUT', body: { handle, profile } });
      // Re-render so the "last updated" line refreshes.
      await loadAndRenderProfile(handle);
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
    } else if (kind === 'voice-profile') {
      const r = await api('/api/settings', {
        method: 'PUT',
        body: {
          voice_profile: data.voice_profile ?? '',
          voice_profile_sample_count: parseInt(data.voice_profile_sample_count, 10),
          voice_profile_user_context: data.voice_profile_user_context ?? '',
        },
      });
      if (r.settings) setSettingsCache(r.settings);
      if (errEl) {
        errEl.classList.add('ok');
        errEl.textContent = '✓ voice profile saved';
        setTimeout(() => { errEl.classList.remove('ok'); errEl.textContent = ''; }, 2500);
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
