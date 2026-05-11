// Firebase Messaging service worker for the Galt companion PWA.
//
// MUST live at the site root (firebase-messaging-sw.js). Firebase
// Messaging looks for this exact path when registering for web push;
// putting it under js/ or anywhere else will silently fail to wire
// up background notifications.
//
// Uses the COMPAT SDK because service workers can't import ES modules
// in all browsers — `importScripts()` is the universal path. Init
// values mirror frontend/galt-messages/js/firebase.js; if you change
// project keys there, change them here too.
//
// Responsibilities:
//   1. Initialize Firebase + Messaging in the service-worker context.
//   2. Receive background push events when the PWA isn't focused.
//   3. Render the browser notification (the FCM SDK does this
//      automatically when the payload has a `notification` field, so
//      we mostly just route).
//   4. Handle notificationclick — open or focus the companion site.

/* eslint-env serviceworker */
/* global firebase, clients */

importScripts('https://www.gstatic.com/firebasejs/12.12.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.12.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyA88JZStjzaOLBPQYB3UmtGhDpibQsgIdA',
  authDomain: 'msb-logistics.firebaseapp.com',
  projectId: 'msb-logistics',
  storageBucket: 'msb-logistics.firebasestorage.app',
  messagingSenderId: '500956053184',
  appId: '1:500956053184:web:3af71ef9c602820960b725',
});

const messaging = firebase.messaging();

// Background push handler. Browser auto-renders the notification when
// the payload has `notification`; we log here for debugging and to
// have a hook for future custom-rendering (e.g. action buttons).
messaging.onBackgroundMessage((payload) => {
  console.log('[galt-sw] background push:', payload);
  // Optional: render a custom notification here when we want action
  // buttons or richer layout than the default FCM render.
});

// When the user taps a notification, focus an existing companion tab
// if one is open, otherwise open the site. Honor click_action from
// the payload when present.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.click_action || data.FCM_MSG?.data?.click_action || 'https://galt-messages.web.app/';

  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      // If the companion is already open, focus that tab.
      if (c.url.startsWith('https://galt-messages.web.app') && 'focus' in c) {
        return c.focus();
      }
    }
    if (clients.openWindow) return clients.openWindow(url);
  })());
});
