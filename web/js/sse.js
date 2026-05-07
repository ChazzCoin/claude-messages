// Server-Sent Events — live updates from /api/stream. Re-renders the
// currently-visible view when the relevant event class arrives, and bumps
// nav-bar badges/counts even when the view isn't open.

import { refreshHealth } from './api.js';
import {
  currentView, currentChatId, currentRadarHandle,
  queueTab, settingsCache, setSettingsCache,
} from './state.js';
import { renderInboxView } from './views/inbox.js';
import { renderThreadView } from './views/thread.js';
import { refreshFlagsList } from './views/flags.js';
import { refreshScheduledList } from './views/scheduled.js';
import { refreshCalendarList } from './views/calendar.js';
import { refreshQueueBadge } from './views/queue.js';
import {
  renderRadarView, renderRadarDetail,
} from './views/radar.js';
import {
  renderAwayView, updateAwayPill,
} from './views/away.js';
import {
  renderAutoNotesView, refreshAutoNotesBadge,
} from './views/auto-notes.js';

let sse = null;

export function connectSSE() {
  if (sse) return;
  try {
    sse = new EventSource('/api/stream');

    sse.addEventListener('message.new', async (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      const messages = data.messages || [];
      if (!messages.length) return;
      if (currentView === 'inbox') {
        await renderInboxView();
      } else if (currentView === 'thread' && currentChatId != null
                 && messages.some((m) => m.chat_id === currentChatId)) {
        await renderThreadView(currentChatId);
      }
    });

    sse.addEventListener('flag.new', async (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      await refreshQueueBadge();
      if (currentView === 'queue' && queueTab === 'flags') await refreshFlagsList();
      const rule = data?.rule_name ? ` "${data.rule_name}"` : '';
      console.log(`[flag] new match${rule} (confidence ${data?.confidence ?? '?'})`);
    });

    sse.addEventListener('scheduled.sent', async () => {
      await refreshQueueBadge();
      if (currentView === 'queue' && queueTab === 'scheduled') await refreshScheduledList();
    });
    sse.addEventListener('scheduled.failed', async () => {
      await refreshQueueBadge();
      if (currentView === 'queue' && queueTab === 'scheduled') await refreshScheduledList();
    });

    sse.addEventListener('calendar.proposal', async (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      await refreshQueueBadge();
      if (currentView === 'queue' && queueTab === 'calendar') await refreshCalendarList();
      console.log('[calendar] new proposal:', data?.proposal?.title);
    });

    sse.addEventListener('radar.signals', async (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      if (currentView === 'radar-detail' && currentRadarHandle && data.handle === currentRadarHandle) {
        await renderRadarDetail(currentRadarHandle);
      } else if (currentView === 'radar') {
        await renderRadarView();
      }
      console.log(`[radar] +${data?.count} signals from ${data?.contact_name || data?.handle}`);
    });

    sse.addEventListener('away.greeting_sent', async (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      console.log(`[away] greeting sent to ${data?.session?.contact_name || data?.session?.handle}`);
      if (currentView === 'away') await renderAwayView();
    });
    sse.addEventListener('away.replied', async (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      console.log(`[away] auto-reply sent (count=${data?.session?.ai_reply_count})`);
      if (currentView === 'away') await renderAwayView();
    });
    sse.addEventListener('away.session_ended', async (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      console.log(`[away] session ended: ${data?.reason}`);
      if (currentView === 'away') await renderAwayView();
    });
    sse.addEventListener('away.mode_disabled', async () => {
      await refreshHealth();
      try {
        const r = await api('/api/settings');
        if (r.settings) setSettingsCache(r.settings);
      } catch { /* keep cache */ }
      updateAwayPill();
      if (currentView === 'away') await renderAwayView();
    });

    sse.addEventListener('autonote.created', async (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      await refreshAutoNotesBadge();
      // Re-render whichever view shows notes (auto-notes page itself, or
      // the home dashboard with its 'Latest auto notes' panel).
      if (currentView === 'auto-notes') await renderAutoNotesView();
      else if (currentView === 'home') {
        const { renderHomeView } = await import('./views/home.js');
        await renderHomeView();
      }
      const cat = data?.note?.category || 'note';
      const sender = data?.note?.contact_name || data?.note?.handle || 'someone';
      console.log(`[autonote] ${cat} from ${sender}: ${data?.note?.summary}`);
    });

    /* ---------- summon mode ---------- */
    const refreshOnSummonChange = async () => {
      if (currentView === 'summon') {
        const { renderSummonView } = await import('./views/summon.js');
        await renderSummonView();
      } else if (currentView === 'home') {
        const { renderHomeView } = await import('./views/home.js');
        await renderHomeView();
      }
    };
    sse.addEventListener('summon.session_started', async (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      console.log(`[summon] session ${data?.session?.id} opened with ${data?.session?.contact_name || data?.session?.handle}`);
      await refreshOnSummonChange();
    });
    sse.addEventListener('summon.replied', async (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      console.log(`[summon] reply ${data?.session?.ai_reply_count} sent in session ${data?.session?.id}`);
      await refreshOnSummonChange();
    });
    sse.addEventListener('summon.session_ended', async (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      console.log(`[summon] session ${data?.session?.id} ended (${data?.reason})`);
      await refreshOnSummonChange();
    });
    sse.addEventListener('summon.globally_disabled', async () => {
      await refreshOnSummonChange();
    });

    sse.onerror = () => {
      console.warn('[sse] disconnected, reconnecting…');
    };
  } catch (err) {
    console.warn('[sse] failed to connect:', err);
  }
}
