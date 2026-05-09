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
//   #/summon                 → summon mode
//   #/galt                   → Galt's master config (persona, prompts, …)
//   #/prompts                → legacy alias for #/galt
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
import { renderSettingsView } from './views/settings.js';
import { renderRadarView, renderRadarDetail } from './views/radar.js';
import { renderAwayView } from './views/away.js';
import { renderAutoNotesView } from './views/auto-notes.js';
import { renderSummonView } from './views/summon.js';
import { renderGaltView } from './views/galt.js';
import { renderQueueView } from './views/queue.js';
import { setQueueTab } from './state.js';

/**
 * Apply a view immediately. Used internally by the hash listener and exposed
 * for cases where you want to navigate without a hash (e.g. SSE refreshing
 * the current view). Most callers should prefer `navigate()`.
 */
export async function setView(view, arg = null) {
  setCurrentView(view);
  setCurrentChatId(view === 'thread' ? arg : null);
  if (view !== 'radar-detail') setCurrentRadarHandle(null);

  // Sidebar highlight: thread inherits from inbox; radar-detail from radar;
  // legacy routes (search → home, drafts → inbox, flags/calendar/scheduled
  // → queue) inherit from the surface that subsumed them.
  const navKey = view === 'thread' ? 'inbox'
    : view === 'radar-detail' ? 'radar'
    : view === 'drafts' ? 'inbox'
    : view === 'search' ? 'home'
    : view === 'prompts' ? 'galt'
    : (view === 'flags' || view === 'calendar' || view === 'scheduled') ? 'queue'
    : view;
  setActiveNav(navKey);
  setRightPanelMode(view === 'thread' ? 'thread' : 'collapsed');
  clearDraftsToolbar();
  // Reset per-view body-class state. The home view sets .home-v9-active on
  // .main when it mounts; clearing here ensures other views see a clean
  // class list when they take over.
  document.querySelector('.main')?.classList.remove('home-v9-active');

  switch (view) {
    case 'home':          await renderHomeView(); break;
    case 'inbox':         await renderInboxView(); break;
    case 'thread':        await renderThreadView(arg); break;
    case 'settings':      await renderSettingsView(); break;
    case 'radar':         await renderRadarView(); break;
    case 'radar-detail':  setCurrentRadarHandle(arg); await renderRadarDetail(arg); break;
    case 'away':          await renderAwayView(); break;
    case 'auto-notes':    await renderAutoNotesView(); break;
    case 'summon':        await renderSummonView(); break;
    case 'galt':          await renderGaltView(); break;
    case 'prompts':       await renderGaltView(); break;          // legacy alias
    case 'queue':         await renderQueueView(); break;
    // Legacy routes — these used to be standalone pages but folded into
    // other surfaces during the sidebar cleanup. Old bookmarks and
    // home-page links keep working by redirecting in place.
    case 'drafts':        await renderInboxView(); break;          // drafts now sit at top of inbox
    case 'search':        await renderHomeView(); break;           // search panel embedded on home
    case 'flags':         setQueueTab('flags');     await renderQueueView(); break;
    case 'calendar':      setQueueTab('calendar');  await renderQueueView(); break;
    case 'scheduled':     setQueueTab('scheduled'); await renderQueueView(); break;
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
