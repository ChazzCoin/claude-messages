// Hash-based router. Reads/writes location.hash and dispatches to view modules.
// URL forms:
//   #/inbox                  → inbox list
//   #/thread/<chatId>        → a single thread
//   #/drafts                 → drafts queue
//   #/sent                   → sent (drafts queue, alias)
//   #/search                 → search
//   #/flags                  → flags queue
//   #/calendar               → calendar proposals
//   #/scheduled              → scheduled messages
//   #/radar                  → radar list
//   #/radar/<handle>         → radar detail
//   #/rules                  → rules detail panel (drafts col header)
//   #/settings               → settings
//   #/away                   → away mode
//
// Also keeps state.currentView / state.currentChatId / state.currentRadarHandle
// in sync, and handles "back to inbox" / sidebar nav-item clicks.

import {
  setCurrentView, setCurrentChatId, setCurrentRadarHandle,
} from './state.js';
import {
  setActiveNav, setRightPanelMode, clearDraftsToolbar,
} from './shell.js';
import { renderHomeView } from './views/home.js';
import { renderInboxView } from './views/inbox.js';
import { renderThreadView } from './views/thread.js';
import { renderDraftsView } from './views/drafts.js';
import { renderSettingsView } from './views/settings.js';
import { renderSearchView } from './views/search.js';
import { renderFlagsView } from './views/flags.js';
import { renderScheduledView } from './views/scheduled.js';
import { renderRadarView, renderRadarDetail } from './views/radar.js';
import { renderCalendarView } from './views/calendar.js';
import { renderAwayView } from './views/away.js';
import { renderSummonView } from './views/summon.js';

/**
 * Apply a view immediately. Used internally by the hash listener and exposed
 * for cases where you want to navigate without a hash (e.g. SSE refreshing
 * the current view). Most callers should prefer `navigate()`.
 */
export async function setView(view, arg = null) {
  setCurrentView(view);
  setCurrentChatId(view === 'thread' ? arg : null);
  if (view !== 'radar-detail') setCurrentRadarHandle(null);

  // Sidebar highlight: thread inherits from inbox; radar-detail from radar.
  const navKey = view === 'thread' ? 'inbox'
    : view === 'radar-detail' ? 'radar'
    : view;
  setActiveNav(navKey);
  setRightPanelMode(view === 'thread' ? 'thread' : 'collapsed');
  if (view !== 'drafts') clearDraftsToolbar();

  switch (view) {
    case 'home':          await renderHomeView(); break;
    case 'inbox':         await renderInboxView(); break;
    case 'thread':        await renderThreadView(arg); break;
    case 'drafts':        await renderDraftsView(); break;
    case 'settings':      await renderSettingsView(); break;
    case 'search':        await renderSearchView(); break;
    case 'flags':         await renderFlagsView(); break;
    case 'scheduled':     await renderScheduledView(); break;
    case 'radar':         await renderRadarView(); break;
    case 'radar-detail':  setCurrentRadarHandle(arg); await renderRadarDetail(arg); break;
    case 'calendar':      await renderCalendarView(); break;
    case 'away':          await renderAwayView(); break;
    case 'summon':        await renderSummonView(); break;
    default:              await renderHomeView();
  }
}

/** Translate a (view, arg) pair into the canonical hash string. */
function hashFor(view, arg) {
  if (view === 'thread' && arg != null) return `#/thread/${encodeURIComponent(arg)}`;
  if (view === 'radar-detail' && arg) return `#/radar/${encodeURIComponent(arg)}`;
  return `#/${view}`;
}

/** Parse location.hash into (view, arg). Returns ('home', null) for empty/invalid. */
function parseHash(hash) {
  const raw = (hash || '').replace(/^#\/?/, '').trim();
  if (!raw) return ['home', null];
  const [view, ...rest] = raw.split('/').map(decodeURIComponent);
  const arg = rest.join('/') || null;
  if (view === 'thread' && arg) {
    const id = parseInt(arg, 10);
    return Number.isFinite(id) ? ['thread', id] : ['home', null];
  }
  if (view === 'radar' && arg) return ['radar-detail', arg];
  return [view, null];
}

/**
 * Public navigate. Writes the hash; the popstate/hashchange listener picks
 * it up and calls setView. If we're already at that hash, force-render.
 */
export async function navigate(view, arg = null) {
  const newHash = hashFor(view, arg);
  if (location.hash === newHash) {
    await setView(view, arg);
  } else {
    location.hash = newHash;
  }
}

/** Wire up the hashchange listener + sidebar nav-item clicks. */
export function installRouter() {
  window.addEventListener('hashchange', async () => {
    const [view, arg] = parseHash(location.hash);
    await setView(view, arg);
  });

  // Sidebar nav clicks → navigate (hash drives the actual view switch).
  document.addEventListener('click', (e) => {
    const nav = e.target.closest?.('.nav-item[data-view]');
    if (!nav) return;
    e.preventDefault();
    navigate(nav.dataset.view);
  });
}

/** Returns the (view, arg) the router should land on given current location.hash. */
export function initialRoute() {
  return parseHash(location.hash);
}
