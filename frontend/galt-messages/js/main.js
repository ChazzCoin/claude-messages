// Entry point — boots the app.

import { startSubscriptions, subscribe } from './state.js';
import { renderAll, hideBoot } from './render.js';
import { wireEventDelegation } from './actions.js';
import { wireChatInput, startChatSubscription, focusChatInput, startMemoryMic, initResizableSheets } from './galt-chat.js';

// Hash routing — minimal SPA.
//   #/        → home (toggles + quick views + quick actions)
//   #/chat    → galt chat full-page
//   #/notes   → notes feed full-page
// We don't bring in a router library; the surface is tiny.
function applyRoute() {
  const raw = (location.hash || '#/').replace(/^#/, '');
  const route = raw.startsWith('/chat')     ? 'chat'
              : raw.startsWith('/notes')    ? 'notes'
              : raw.startsWith('/briefing') ? 'briefing'
              : 'home';
  const app = document.querySelector('.app');
  if (app) app.dataset.route = route;
  if (route === 'chat') {
    // Idempotent — both are safe to call repeatedly.
    startChatSubscription();
    focusChatInput();
  }
}

function boot() {
  wireEventDelegation();
  wireChatInput();
  initResizableSheets();
  startSubscriptions();
  subscribe(renderAll);

  // Start the chat subscription at boot — not just when the chat route
  // opens. This makes TTS and the memory mic work from any page since
  // renderMessages (and its speakText call) fires globally.
  startChatSubscription();

  applyRoute();
  window.addEventListener('hashchange', applyRoute);

  // Hide the boot screen as soon as the first /state callback fires —
  // or after a short fallback timeout if the database is empty / the
  // backend hasn't pushed yet (so we don't hang on a black screen).
  let booted = false;
  subscribe(() => {
    if (booted) return;
    booted = true;
    hideBoot();
  });
  setTimeout(() => {
    if (!booted) {
      booted = true;
      hideBoot();
    }
  }, 1500);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
