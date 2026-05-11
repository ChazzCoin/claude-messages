// Firebase init for the Galt remote console.
//
// No auth — single-user app, RTDB rules are wide-open during dev. The
// frontend reads /state + /notes and pushes to /commands; the backend
// (running on the user's Mac via firebase-admin SDK) does everything
// else.
//
// CRITICAL: this project has TWO Realtime Database instances. The
// backend mirror writes to the *named* `galt-messages` instance, NOT
// the default `msb-logistics-default-rtdb`. Pointing this client at
// the wrong one will silently read an empty database. The databaseURL
// override below is load-bearing.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js';
import {
  getDatabase, ref, onValue, off, push, set, update, remove, get, child,
} from 'https://www.gstatic.com/firebasejs/12.12.1/firebase-database.js';

const firebaseConfig = {
  apiKey: 'AIzaSyA88JZStjzaOLBPQYB3UmtGhDpibQsgIdA',
  authDomain: 'msb-logistics.firebaseapp.com',
  projectId: 'msb-logistics',
  storageBucket: 'msb-logistics.firebasestorage.app',
  messagingSenderId: '500956053184',
  appId: '1:500956053184:web:3af71ef9c602820960b725',
  databaseURL: 'https://galt-messages.firebaseio.com',
};

export const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export { ref, onValue, off, push, set, update, remove, get, child };

/* ============================================================
   Web Push (FCM) — public VAPID key
   ============================================================
   Required by getToken({ vapidKey }) when registering for web push.
   PUBLIC — safe to commit; this is the identity the browser's push
   service uses to recognize our project, not a secret. Get it from
   Firebase Console → Project Settings → Cloud Messaging → "Web Push
   certificates" → Generate key pair → copy the long base64-ish
   string and paste below (no quotes, no whitespace).

   The same key MUST stay stable for tokens issued under it to keep
   working — rotating it invalidates every device's saved token. */
export const WEB_PUSH_VAPID_KEY = 'BIaWNwFwukN9RplQn1aZMI4WryuPygnkJwOSFf3tI4w389upTFkAgu01XZSuKWgo1_YlafVBNp-2CIS1OlOL_U8';
