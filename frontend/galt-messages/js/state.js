// State store + RTDB subscriptions + command-push helpers.
//
// Three responsibilities:
//   1. Subscribe to /state and /notes on connect; expose the latest
//      snapshot synchronously (rendered components read from here).
//   2. Push commands to /commands/<auto_id> and resolve when the
//      backend writes a result onto the same node. Promise-based API.
//   3. Optimistically apply mutations locally so UI feels instant —
//      then reconcile with the next /state push.

import { db, ref, onValue, push, set, update, remove } from './firebase.js';

const listeners = new Set();

const store = {
  state: null,         // { settings, watched_contacts, health, ... }
  notes: [],           // array, sorted newest-first
  notesByGuid: new Map(),
  connected: false,
  lastError: null,
};

export function getStore() {
  return store;
}

/** Subscribe to store changes. Returns an unsubscribe fn. */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) {
    try { fn(store); } catch (err) { console.error('[state] listener error:', err); }
  }
}

/** Wire up the two RTDB subscriptions. Call once at boot. */
export function startSubscriptions() {
  // /state — single key, full snapshot. RTDB always delivers the
  // current value on subscribe + on every change.
  onValue(
    ref(db, '/state'),
    (snap) => {
      store.state = snap.val();
      store.connected = true;
      store.lastError = null;
      notify();
    },
    (err) => {
      store.connected = false;
      store.lastError = err.message;
      notify();
    },
  );

  // /notes — collection. Listen on the parent and keep an in-memory
  // sorted array. Cheap because the auto-notes feed is small (capped
  // at the unreviewed count + a tail of reviewed history).
  onValue(
    ref(db, '/notes'),
    (snap) => {
      const map = new Map();
      const arr = [];
      const val = snap.val() || {};
      for (const [guid, payload] of Object.entries(val)) {
        if (!payload) continue;
        map.set(guid, payload);
        arr.push(payload);
      }
      arr.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      store.notes = arr;
      store.notesByGuid = map;
      notify();
    },
    (err) => {
      store.lastError = err.message;
      notify();
    },
  );
}

/** Push a command to /commands and wait for the backend to write a
 *  result. Resolves with the result.data on success, throws with the
 *  backend's error message on failure. Times out after 10s — the
 *  backend processes commands in milliseconds normally, so a 10s
 *  silence means the listener isn't running. */
export async function sendCommand(type, payload = {}) {
  const cmdRef = push(ref(db, '/commands'));
  await set(cmdRef, {
    type,
    payload,
    requested_at: Date.now(),
  });

  return new Promise((resolve, reject) => {
    const resultRef = ref(db, `/commands/${cmdRef.key}/result`);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('command timed out — is the backend running?'));
    }, 10_000);

    const unsub = onValue(resultRef, (snap) => {
      const v = snap.val();
      if (!v) return;
      cleanup();
      if (v.ok) resolve(v.data);
      else reject(new Error(v.error || 'command failed'));
    });

    function cleanup() {
      clearTimeout(timer);
      try { unsub(); } catch {}
    }
  });
}
