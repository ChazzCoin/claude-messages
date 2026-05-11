// Hash-based router. Reads/writes location.hash and dispatches to view modules.
//
// Active routes (the sidebar surfaces):
//   #/home                   → home dashboard
//   #/galt                   → Galt's pipeline visualization + Summon ops
//   #/away                   → Away mode + opted-in contacts
//   #/auto-notes             → Notes (24/7 inbound triage review)
//   #/radar                  → per-contact memory bank
//   #/radar/<handle>         → radar detail
//   #/inbox                  → unified inbox (chats / calendar / flags / scheduled tabs)
//   #/inbox/<tab>            → inbox at a specific tab
//   #/thread/<chatId>        → a single thread
//   #/settings               → system / account
//
// Legacy redirects (kept so old bookmarks and links keep working):
//   #/summon                 → #/galt
//   #/queue                  → #/inbox
//   #/calendar #/flags #/scheduled → #/inbox?tab=…
//   #/prompts                → #/galt
//   #/drafts #/sent #/search → #/home (or inbox)

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
import { renderGaltView } from './views/galt.js';
import { renderGaltChatView, stopGaltChatPolling } from './views/galt-chat.js';
import { renderGChatView, stopGChatPolling } from './views/gchat.js';
import { setInboxTab } from './state.js';

/**
 * Apply a view immediately. Used internally by the hash listener and exposed
 * for cases where you want to navigate without a hash (e.g. SSE refreshing
 * the current view). Most callers should prefer `navigate()`.
 */
export async function setView(view, arg = null) {
  setCurrentView(view);
  setCurrentChatId(view === 'thread' ? arg : null);
  if (view !== 'radar-detail') setCurrentRadarHandle(null);

  // Cancel galt-chat polling whenever we leave that view.
  if (view !== 'galt-chat') stopGaltChatPolling();
  // Cancel gchat polling whenever we leave that view.
  if (view !== 'gchat') stopGChatPolling();

  // Sidebar highlight mapping. Thread inherits from inbox; radar-detail
  // from radar. Legacy routes (search → home, drafts → inbox, summon →
  // galt, calendar/flags/scheduled/queue → inbox) light up the surface
  // that absorbed them.
  const navKey = view === 'thread' ? 'inbox'
    : view === 'radar-detail' ? 'radar'
    : view === 'drafts' ? 'inbox'
    : view === 'search' ? 'home'
    : view === 'prompts' ? 'galt'
    : view === 'summon' ? 'galt'
    : view === 'galt-chat' ? 'galt-chat'
    : view === 'gchat' ? 'gchat'
    : (view === 'queue' || view === 'flags' || view === 'calendar' || view === 'scheduled') ? 'inbox'
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
    case 'galt':          await renderGaltView(); break;
    case 'galt-chat':     await renderGaltChatView(); break;
    case 'gchat':         await renderGChatView(); break;
    case 'prompts':       await renderGaltView(); break;          // legacy alias
    // Legacy routes folded into surfaces above. They keep working but
    // route through the new surface and (where applicable) pre-select
    // the right tab.
    case 'summon':        await renderGaltView(); break;
    case 'queue':         await renderInboxView(); break;
    case 'flags':         setInboxTab('flags');     await renderInboxView(); break;
    case 'calendar':      setInboxTab('calendar');  await renderInboxView(); break;
    case 'scheduled':     setInboxTab('scheduled'); await renderInboxView(); break;
    case 'drafts':        await renderInboxView(); break;
    case 'search':        await renderHomeView(); break;
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
