// Server-Sent Events — live updates from /api/stream. Re-renders the
// currently-visible view when the relevant event class arrives, and bumps
// nav-bar badges/counts even when the view isn't open.

import { api, refreshHealth } from './api.js';
import {
  currentView, currentChatId, currentRadarHandle,
  settingsCache, setSettingsCache,
} from './state.js';
import { renderInboxView } from './views/inbox.js';
import { renderThreadView } from './views/thread.js';
import {
  refreshFlagsList, updateFlagsBadge,
} from './views/flags.js';
import {
  refreshScheduledList, refreshScheduledCount,
} from './views/scheduled.js';
import {
  refreshCalendarBadgeOnly, refreshCalendarList,
} from './views/calendar.js';
import {
  renderRadarView, renderRadarDetail,
} from './views/radar.js';
import {
  renderAwayView, updateAwayPill, refreshAwayNotesBadge,
} from './views/away.js';

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
      try {
        const r = await api('/api/monitor/flags?reviewed=false&limit=1');
        updateFlagsBadge(r.unreviewed);
      } catch { /* badge stays */ }
      if (currentView === 'flags') await refreshFlagsList();
      const rule = data?.rule_name ? ` "${data.rule_name}"` : '';
      console.log(`[flag] new match${rule} (confidence ${data?.confidence ?? '?'})`);
    });

    sse.addEventListener('scheduled.sent', async () => {
      if (currentView === 'scheduled') await refreshScheduledList();
      else refreshScheduledCount();
    });
    sse.addEventListener('scheduled.failed', async () => {
      if (currentView === 'scheduled') await refreshScheduledList();
    });

    sse.addEventListener('calendar.proposal', async (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      await refreshCalendarBadgeOnly();
      if (currentView === 'calendar') await refreshCalendarList();
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

    sse.addEventListener('away.note_created', async (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      await refreshAwayNotesBadge();
      if (currentView === 'away') await renderAwayView();
      const cat = data?.note?.category || 'note';
      const sender = data?.note?.contact_name || data?.note?.handle || 'someone';
      console.log(`[away:note] ${cat} from ${sender}: ${data?.note?.summary}`);
    });

    /* ---------- summon mode ---------- */
    const refreshOnSummonChange = async () => {
      if (currentView === 'away') await renderAwayView();
      else if (currentView === 'home') {
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
