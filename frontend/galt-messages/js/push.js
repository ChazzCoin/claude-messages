// Push notifications — client-side flow for the companion PWA.
//
// Lifecycle:
//   1. User clicks "Enable push notifications" in Settings.
//   2. We request Notification.permission via the browser API.
//   3. On grant, we register the service worker, init Firebase
//      Messaging, and call getToken({ vapidKey }) to get an FCM
//      registration token.
//   4. We send register_device_token through the existing /commands
//      bus — the backend persists the token under /devices/<auto_id>.
//   5. When the user disables push from Settings, we send
//      unregister_device_token and delete the token client-side.
//
// Permission is a single browser-level grant — once granted, the
// PWA can receive pushes via the service worker even when the page
// is closed.
//
// iOS note: Safari requires the PWA to be installed to the home
// screen BEFORE Notification.requestPermission() will work. The
// user already has the PWA on their home screen, so this isn't a
// blocker for the primary user — but if anyone else tries this
// from a regular browser tab on iOS, they'll get permission=denied
// without an obvious reason.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js';
import {
  getMessaging, getToken, deleteToken, onMessage,
} from 'https://www.gstatic.com/firebasejs/12.12.1/firebase-messaging.js';
import { sendCommand } from './state.js';
import { showToast } from './render.js';
import { WEB_PUSH_VAPID_KEY } from './firebase.js';

const LS_DEVICE_ID = 'galt:push:device_id';
const LS_TOKEN     = 'galt:push:token';

// Lazy Messaging init — Firebase Messaging in the page context is
// separate from the SDK init in js/firebase.js (which set up RTDB).
// Reusing the same config keeps both ends pointing at the same
// project.
let _messaging = null;
async function getMessagingClient() {
  if (_messaging) return _messaging;
  // Mirror the config in js/firebase.js — they must agree.
  const app = initializeApp({
    apiKey: 'AIzaSyA88JZStjzaOLBPQYB3UmtGhDpibQsgIdA',
    authDomain: 'msb-logistics.firebaseapp.com',
    projectId: 'msb-logistics',
    storageBucket: 'msb-logistics.firebasestorage.app',
    messagingSenderId: '500956053184',
    appId: '1:500956053184:web:3af71ef9c602820960b725',
  }, 'galt-messaging');  // named app so we don't collide with the default RTDB init
  _messaging = getMessaging(app);
  return _messaging;
}

/* ============================================================
   Public API
   ============================================================ */

export function pushSupported() {
  return 'serviceWorker' in navigator
      && 'Notification' in window
      && 'PushManager' in window;
}

export function pushPermission() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;  // 'granted' | 'denied' | 'default'
}

export function isPushEnabled() {
  return pushPermission() === 'granted' && !!localStorage.getItem(LS_TOKEN);
}

/** Enable push: request permission → register SW → get FCM token
 *  → save to backend. Idempotent — re-running is safe and just
 *  refreshes the token. */
export async function enablePush() {
  if (!pushSupported()) {
    showToast('push not supported in this browser', 'error');
    return false;
  }
  if (WEB_PUSH_VAPID_KEY.includes('PASTE_YOUR_VAPID')) {
    showToast('VAPID key not set in firebase.js', 'error');
    return false;
  }

  // 1. Permission. Browsers gate this behind a user gesture — must
  // be called from a click handler, not on page load.
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    showToast(`permission ${perm}`, 'error');
    return false;
  }

  // 2. Service worker registration. The SW lives at the site root;
  // explicit register so we know it's active before Messaging
  // tries to attach.
  let sw;
  try {
    sw = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
  } catch (err) {
    showToast(`sw register failed: ${err.message}`, 'error');
    return false;
  }

  // 3. FCM token.
  let token;
  try {
    const messaging = await getMessagingClient();
    token = await getToken(messaging, {
      vapidKey: WEB_PUSH_VAPID_KEY,
      serviceWorkerRegistration: sw,
    });
  } catch (err) {
    showToast(`getToken failed: ${err.message}`, 'error');
    return false;
  }
  if (!token) {
    showToast('no token returned', 'error');
    return false;
  }

  // 4. Register with backend via /commands.
  try {
    const r = await sendCommand('register_device_token', {
      token,
      user_agent: navigator.userAgent,
    });
    localStorage.setItem(LS_DEVICE_ID, r.device_id || '');
    localStorage.setItem(LS_TOKEN, token);

    // 5. Wire up foreground message handler — when the PWA is open,
    // the SW doesn't render anything; we toast instead.
    const messaging = await getMessagingClient();
    onMessage(messaging, (payload) => {
      const t = payload.notification?.title || 'Galt';
      const b = payload.notification?.body  || '';
      showToast(`${t} — ${b}`, 'ok');
    });

    showToast('push notifications enabled', 'ok');
    return true;
  } catch (err) {
    showToast(`register failed: ${err.message}`, 'error');
    return false;
  }
}

/** Disable push: tell the backend to forget us + delete the local
 *  token. Doesn't revoke browser permission (the user can re-enable
 *  without a new prompt). */
export async function disablePush() {
  const deviceId = localStorage.getItem(LS_DEVICE_ID);
  try {
    if (deviceId) {
      await sendCommand('unregister_device_token', { device_id: deviceId });
    }
    const messaging = await getMessagingClient();
    await deleteToken(messaging).catch(() => {/* tolerate */});
  } catch (err) {
    console.warn('[push] disable hit:', err.message);
  }
  localStorage.removeItem(LS_DEVICE_ID);
  localStorage.removeItem(LS_TOKEN);
  showToast('push notifications disabled', 'ok');
}

/** Test send — asks the backend to fire a push at every registered
 *  device. The current device should see it (foreground toast) plus
 *  the system tray if the PWA is backgrounded. */
export async function sendTestPush() {
  try {
    const result = await sendCommand('send_test_push', {
      title: 'Galt test',
      body: `Test push fired from Settings at ${new Date().toLocaleTimeString()}.`,
    });
    if (result.sent > 0) {
      showToast(`test sent to ${result.sent} device${result.sent === 1 ? '' : 's'}`, 'ok');
    } else {
      showToast(`no devices reached (failed ${result.failed}, pruned ${result.pruned})`, 'error');
    }
  } catch (err) {
    showToast(`test failed: ${err.message}`, 'error');
  }
}
