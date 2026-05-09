// Entrypoint. Loaded as <script type="module" src="/js/main.js"></script>.
// Imports run top-to-bottom; init() fires after DOMContentLoaded.

import { refreshHealth, fetchContacts } from './api.js';
import { setContactsCache } from './state.js';
import { installContactAutocomplete } from './components/autocomplete.js';
import { installRouter, initialRoute, setView } from './router.js';
import { installActionHandlers } from './actions.js';
import { connectSSE } from './sse.js';

import { refreshSettings } from './views/settings.js';
import { refreshRadarHandlesCache } from './views/radar.js';
import { updateAwayPill } from './views/away.js';
import { refreshAutoNotesBadge } from './views/auto-notes.js';
import { refreshQueueBadge } from './views/queue.js';

async function refreshContactsCache() {
  try {
    const r = await fetchContacts();
    const filtered = (r.contacts || []).filter((c) => c.handles && c.handles.length);
    setContactsCache(filtered);
  } catch { /* keep prior cache */ }
}

async function init() {
  // Settings first so dependent renderers see the cached values.
  await refreshSettings();
  updateAwayPill();

  // Wire up event delegation up front so anything rendered below already works.
  installContactAutocomplete();
  installActionHandlers();
  installRouter();

  // Sidebar/badge data — same regardless of which main view is up.
  // refreshQueueBadge sweeps calendar+flags+scheduled counts in one call.
  await Promise.all([
    refreshHealth(),
    refreshRadarHandlesCache(),
    refreshContactsCache(),
    refreshAutoNotesBadge(),
    refreshQueueBadge(),
  ]);

  // Land on whatever the URL hash says (defaults to inbox).
  const [view, arg] = initialRoute();
  await setView(view, arg);

  // Live updates from the watcher.
  connectSSE();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
