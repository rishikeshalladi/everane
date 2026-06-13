// Everane push-subscribe helper.
// Exposes window.Everane.Push with:
//   - isSupported()
//   - getPermissionState()
//   - isIosSafariNotInstalled()
//   - subscribe(auth, db)  -> requests permission, registers SW, subscribes, stores in Firestore
//   - unsubscribe(auth, db)
//   - getCurrentSubscription()
//
// This file is plain (non-module) so it can be loaded from any HTML with a <script src="/push-subscribe.js">.
//
// Depends on the user being signed in via firebase-auth, and Firestore being available as
// `db` (Firestore instance). Each HTML page already has these; callers pass them in.

(function () {
  const VAPID_PUBLIC_KEY = 'BDFTKQIe6uolT9cKyf_SjIY25z94EdwlzDtvt7ux8bBbFJ1EBOkGuGvfjJO6aYnbGG--KB2yiRG1xXJfDY-y5co';

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function isSupported() {
    return (
      typeof window !== 'undefined' &&
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window
    );
  }

  function getPermissionState() {
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission; // 'default' | 'granted' | 'denied'
  }

  function isIos() {
    const ua = navigator.userAgent || '';
    const isIpad = /iPad|Macintosh/.test(ua) && 'ontouchend' in document;
    return /iPhone|iPod/.test(ua) || isIpad;
  }

  function isStandalonePwa() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true
    );
  }

  function isIosSafariNotInstalled() {
    return isIos() && !isStandalonePwa();
  }

  async function registerSW() {
    try {
      const existing = await navigator.serviceWorker.getRegistration('/');
      if (existing) return existing;
    } catch (_) {}
    return navigator.serviceWorker.register('/sw.js', { scope: '/' });
  }

  async function getCurrentSubscription() {
    if (!isSupported()) return null;
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      if (!reg) return null;
      return await reg.pushManager.getSubscription();
    } catch (e) {
      return null;
    }
  }

  function serializeSubscription(sub) {
    const json = sub.toJSON ? sub.toJSON() : sub;
    return {
      endpoint: json.endpoint,
      keys: {
        p256dh: (json.keys && json.keys.p256dh) || '',
        auth: (json.keys && json.keys.auth) || ''
      },
      userAgent: (navigator.userAgent || '').slice(0, 500),
      createdAt: new Date().toISOString()
    };
  }

  // Get Firestore modular helpers that host pages expose on `window`.
  // (Pages import them from the v9 modular SDK and assign to window.)
  function firestoreApi() {
    return {
      doc: window.doc,
      getDoc: window.getDoc,
      setDoc: window.setDoc
    };
  }

  // Wait until window.auth, window.db, and the Firestore modular helpers are all
  // attached (module script has run), up to `timeoutMs`.
  async function waitForFirebaseGlobals(timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (window.auth && window.db && window.doc && window.getDoc && window.setDoc) return true;
      await new Promise(r => setTimeout(r, 50));
    }
    return (!!window.auth && !!window.db && !!window.doc && !!window.getDoc && !!window.setDoc);
  }

  async function storeSubscriptionInFirestore(db, uid, record) {
    if (!db || !uid) throw new Error('missing db or uid');
    const { doc: dref, getDoc, setDoc } = firestoreApi();
    if (!dref || !getDoc || !setDoc) {
      throw new Error('Firestore modular helpers (window.doc/getDoc/setDoc) not available on this page');
    }
    const userRef = dref(db, 'users', uid);
    const snap = await getDoc(userRef);
    const existing = (snap.exists() && (snap.data().pushSubscriptions || [])) || [];
    // Replace any entry with the same endpoint, then append this one
    const deduped = existing.filter((s) => s && s.endpoint !== record.endpoint);
    deduped.push(record);
    await setDoc(userRef, { pushSubscriptions: deduped }, { merge: true });
  }

  async function removeSubscriptionFromFirestore(db, uid, endpoint) {
    if (!db || !uid || !endpoint) return;
    const { doc: dref, getDoc, setDoc } = firestoreApi();
    if (!dref || !getDoc || !setDoc) return; // silently skip
    const userRef = dref(db, 'users', uid);
    const snap = await getDoc(userRef);
    const existing = (snap.exists() && (snap.data().pushSubscriptions || [])) || [];
    const filtered = existing.filter((s) => s && s.endpoint !== endpoint);
    await setDoc(userRef, { pushSubscriptions: filtered }, { merge: true });
  }

  // Compare two ArrayBuffers/Uint8Arrays byte-for-byte.
  function buffersEqual(a, b) {
    if (!a || !b) return false;
    const av = new Uint8Array(a);
    const bv = new Uint8Array(b);
    if (av.length !== bv.length) return false;
    for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
    return true;
  }

  // Wait until a service worker registration has an *active* worker.
  async function waitForActiveSW(reg) {
    if (reg.active) return;
    const sw = reg.installing || reg.waiting;
    if (!sw) return;
    await new Promise((resolve) => {
      const onChange = () => {
        if (sw.state === 'activated') { sw.removeEventListener('statechange', onChange); resolve(); }
      };
      sw.addEventListener('statechange', onChange);
      // Safety timeout — never hang forever
      setTimeout(resolve, 4000);
    });
  }

  async function subscribe(auth, db) {
    if (!isSupported()) {
      return { ok: false, reason: 'unsupported', error: 'Service Worker or PushManager not supported' };
    }
    if (isIosSafariNotInstalled()) {
      return { ok: false, reason: 'ios-install-required' };
    }
    // Callers often pass window.auth / window.db which may not be populated yet
    // if the module init script has not finished. Wait for it, and fall back to
    // whatever ends up on window.
    await waitForFirebaseGlobals(5000);
    auth = auth || window.auth;
    db   = db   || window.db;

    const user = auth && auth.currentUser;
    if (!user) return { ok: false, reason: 'not-signed-in', error: 'auth.currentUser is null' };
    if (!db) return { ok: false, reason: 'firestore-failed', error: 'Firestore (window.db) not available' };

    // Ask permission (this is the native browser popup).
    let permission = Notification.permission;
    if (permission === 'default') {
      try {
        permission = await Notification.requestPermission();
      } catch (e) {
        return { ok: false, reason: 'denied', error: 'requestPermission threw: ' + (e && e.message || e) };
      }
    }
    if (permission !== 'granted') {
      return { ok: false, reason: 'denied', error: 'Notification.permission = ' + permission };
    }

    let reg;
    try {
      reg = await registerSW();
      await waitForActiveSW(reg);
    } catch (e) {
      return { ok: false, reason: 'sw-register-failed', error: String(e && e.message || e) };
    }

    const expectedKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);

    // If there's an existing subscription that was created with a different
    // applicationServerKey (e.g. before we configured VAPID, or a stale one),
    // it is unusable — we must unsubscribe before resubscribing with the right key.
    let sub = null;
    try {
      sub = await reg.pushManager.getSubscription();
    } catch (e) {
      console.warn('[Push] getSubscription threw:', e);
    }
    if (sub) {
      const opts = sub.options || {};
      const existingKey = opts.applicationServerKey;
      if (!existingKey || !buffersEqual(existingKey, expectedKey)) {
        console.info('[Push] Existing subscription uses a different VAPID key — unsubscribing and resubscribing.');
        try { await sub.unsubscribe(); } catch (e) { console.warn('[Push] unsubscribe failed:', e); }
        sub = null;
      }
    }

    if (!sub) {
      try {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: expectedKey
        });
      } catch (e) {
        // Some browsers throw InvalidStateError if a stale sub still exists.
        // Try one forced recovery: unsubscribe ANY existing sub, then retry.
        if (e && /InvalidStateError/i.test(String(e.name || e))) {
          try {
            const stale = await reg.pushManager.getSubscription();
            if (stale) await stale.unsubscribe();
            sub = await reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: expectedKey
            });
          } catch (e2) {
            return { ok: false, reason: 'subscribe-failed', error: 'retry failed: ' + String(e2 && e2.message || e2) };
          }
        } else {
          return { ok: false, reason: 'subscribe-failed', error: (e && e.name ? e.name + ': ' : '') + String(e && e.message || e) };
        }
      }
    }

    const record = serializeSubscription(sub);
    try {
      await storeSubscriptionInFirestore(db, user.uid, record);
    } catch (e) {
      return { ok: false, reason: 'firestore-failed', error: String(e && e.message || e) };
    }

    // Seed the SW with a fresh ID token so notification action buttons work
    // even when no app window is open later.
    try {
      const idToken = await user.getIdToken(true);
      const target = reg.active || reg.waiting || reg.installing || navigator.serviceWorker.controller;
      if (target) target.postMessage({ type: 'EVERANE_SET_ID_TOKEN', idToken, expiresInMs: 55 * 60 * 1000 });
    } catch (_) { /* ignore */ }

    return { ok: true, subscription: record };
  }

  async function unsubscribe(auth, db) {
    await waitForFirebaseGlobals(5000);
    auth = auth || window.auth;
    db   = db   || window.db;
    const user = auth && auth.currentUser;
    if (!user) return { ok: false, reason: 'not-signed-in' };
    const sub = await getCurrentSubscription();
    if (!sub) return { ok: true, reason: 'none' };
    const endpoint = sub.endpoint;
    try { await sub.unsubscribe(); } catch (_) {}
    try { await removeSubscriptionFromFirestore(db, user.uid, endpoint); } catch (_) {}
    return { ok: true };
  }

  window.Everane = window.Everane || {};
  window.Everane.Push = {
    isSupported,
    getPermissionState,
    isIos,
    isStandalonePwa,
    isIosSafariNotInstalled,
    getCurrentSubscription,
    subscribe,
    unsubscribe,
    VAPID_PUBLIC_KEY
  };

  // Push the current user's Firebase ID token into the SW so it can authenticate
  // markDoseFromPush calls even when no app window is open later.
  async function pushIdTokenToSW(force = false) {
    try {
      if (!('serviceWorker' in navigator)) return;
      const reg = await navigator.serviceWorker.getRegistration('/');
      const target = (reg && (reg.active || reg.waiting || reg.installing)) || navigator.serviceWorker.controller;
      if (!target) return;
      await waitForFirebaseGlobals(2000);
      const auth = window.auth;
      const user = auth && auth.currentUser;
      if (!user) return;
      const idToken = await user.getIdToken(force === true);
      target.postMessage({ type: 'EVERANE_SET_ID_TOKEN', idToken, expiresInMs: 55 * 60 * 1000 });
    } catch (_) { /* ignore */ }
  }

  // Auto-register the service worker on any page that loads this script, so existing
  // subscriptions keep working across sessions. Safe no-op if SW not supported.
  if (isSupported()) {
    window.addEventListener('load', async () => {
      try { await registerSW(); } catch (_) {}
      // Push an initial token to the SW (best-effort)
      pushIdTokenToSW();
    });

    // Refresh the SW's cached token whenever the page becomes visible again
    // (covers laptops waking up, mobile resume, etc.).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') pushIdTokenToSW();
    });
    window.addEventListener('focus', () => pushIdTokenToSW());

    // Refresh every 30 minutes while the page is open, to keep the SW cache warm.
    setInterval(() => pushIdTokenToSW(true), 30 * 60 * 1000);

    // Listen for requests from the SW for a Firebase ID token (live fetch path).
    navigator.serviceWorker.addEventListener('message', async (event) => {
      if (!event || !event.data || event.data.type !== 'EVERANE_GET_ID_TOKEN') return;
      const port = event.ports && event.ports[0];
      if (!port) return;
      try {
        const auth = window.auth || (window.firebase && window.firebase.auth && window.firebase.auth());
        const user = auth && auth.currentUser;
        if (!user) { port.postMessage({ idToken: null }); return; }
        const idToken = await user.getIdToken();
        port.postMessage({ idToken });
      } catch (e) {
        try { port.postMessage({ idToken: null }); } catch (_) {}
      }
    });
  }

  // Expose the helper so callers can manually refresh after sign-in/out
  window.Everane.Push.pushIdTokenToSW = pushIdTokenToSW;
})();
