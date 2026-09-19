
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
    return Notification.permission;
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

  function firestoreApi() {
    return {
      doc: window.doc,
      getDoc: window.getDoc,
      setDoc: window.setDoc
    };
  }

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
    const deduped = existing.filter((s) => s && s.endpoint !== record.endpoint);
    deduped.push(record);
    await setDoc(userRef, { pushSubscriptions: deduped }, { merge: true });
  }

  async function removeSubscriptionFromFirestore(db, uid, endpoint) {
    if (!db || !uid || !endpoint) return;
    const { doc: dref, getDoc, setDoc } = firestoreApi();
    if (!dref || !getDoc || !setDoc) return;
    const userRef = dref(db, 'users', uid);
    const snap = await getDoc(userRef);
    const existing = (snap.exists() && (snap.data().pushSubscriptions || [])) || [];
    const filtered = existing.filter((s) => s && s.endpoint !== endpoint);
    await setDoc(userRef, { pushSubscriptions: filtered }, { merge: true });
  }

  function buffersEqual(a, b) {
    if (!a || !b) return false;
    const av = new Uint8Array(a);
    const bv = new Uint8Array(b);
    if (av.length !== bv.length) return false;
    for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
    return true;
  }

  async function waitForActiveSW(reg) {
    if (reg.active) return;
    const sw = reg.installing || reg.waiting;
    if (!sw) return;
    await new Promise((resolve) => {
      const onChange = () => {
        if (sw.state === 'activated') { sw.removeEventListener('statechange', onChange); resolve(); }
      };
      sw.addEventListener('statechange', onChange);
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
    await waitForFirebaseGlobals(5000);
    auth = auth || window.auth;
    db   = db   || window.db;

    const user = auth && auth.currentUser;
    if (!user) return { ok: false, reason: 'not-signed-in', error: 'auth.currentUser is null' };
    if (!db) return { ok: false, reason: 'firestore-failed', error: 'Firestore (window.db) not available' };

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

    try {
      const idToken = await user.getIdToken(true);
      const target = reg.active || reg.waiting || reg.installing || navigator.serviceWorker.controller;
      if (target) target.postMessage({ type: 'EVERANE_SET_ID_TOKEN', idToken, expiresInMs: 55 * 60 * 1000 });
    } catch (_) { }

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
    selfHeal,
    VAPID_PUBLIC_KEY
  };

  async function waitForSignedInUser(timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (window.auth && window.auth.currentUser) return window.auth.currentUser;
      await new Promise(r => setTimeout(r, 100));
    }
    return (window.auth && window.auth.currentUser) || null;
  }

  async function selfHeal() {
    try {
      if (!isSupported()) return;
      if (isIosSafariNotInstalled()) return;
      if (getPermissionState() !== 'granted') return;

      await waitForFirebaseGlobals(8000);
      const user = await waitForSignedInUser(8000);
      if (!user || !window.db) return;

      const reg = await navigator.serviceWorker.getRegistration('/');
      let live = null;
      if (reg) {
        try { live = await reg.pushManager.getSubscription(); } catch (_) {}
      }

      const result = await subscribe(window.auth, window.db);
      if (result && result.ok) {
        if (!live) console.info('[Push] Subscription was missing - re-established.');
      } else if (result) {
        console.warn('[Push] Self-heal could not restore subscription:', result.reason);
      }
    } catch (e) {
      console.warn('[Push] Self-heal error:', (e && e.message) || e);
    }
  }

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
    } catch (_) { }
  }

  if (isSupported()) {
    window.addEventListener('load', async () => {
      try { await registerSW(); } catch (_) {}
      pushIdTokenToSW();
      selfHeal();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') pushIdTokenToSW();
    });
    window.addEventListener('focus', () => pushIdTokenToSW());

    setInterval(() => pushIdTokenToSW(true), 30 * 60 * 1000);

    navigator.serviceWorker.addEventListener('message', async (event) => {
      if (event && event.data && event.data.type === 'EVERANE_PUSH_RESUBSCRIBED') {
        // The browser rotated the subscription and the service worker created a
        // replacement. Persist it now so the server stops pushing to the dead
        // endpoint.
        selfHeal();
        return;
      }
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

  window.Everane.Push.pushIdTokenToSW = pushIdTokenToSW;
})();
