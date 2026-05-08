// Entry point — boots the app.

import { startSubscriptions, subscribe } from './state.js';
import { renderAll, hideBoot } from './render.js';
import { wireEventDelegation } from './actions.js';

function boot() {
  wireEventDelegation();
  startSubscriptions();
  subscribe(renderAll);

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
