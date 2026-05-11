// Entry point — boots the app.

import { startSubscriptions, subscribe } from './state.js';
import { renderAll, hideBoot } from './render.js';
import { wireEventDelegation } from './actions.js';
import { wireChatInput, startChatSubscription, focusChatInput } from './galt-chat.js';

// Hash routing — minimal SPA.
//   #/        → home (notes feed)
//   #/chat    → galt chat full-page
// More routes (e.g. #/chat/settings) can land here later. We don't
// bring in a router library; the surface is tiny.
function applyRoute() {
  const raw = (location.hash || '#/').replace(/^#/, '');
  const route = raw.startsWith('/chat') ? 'chat' : 'home';
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
  startSubscriptions();
  subscribe(renderAll);

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
