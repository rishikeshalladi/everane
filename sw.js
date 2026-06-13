// Everane Service Worker - handles Web Push + notification clicks.

const SW_VERSION = 'everane-sw-v3';

// In-memory cache of the user's Firebase ID token.
// Pages push fresh tokens to the SW via `EVERANE_SET_ID_TOKEN` messages.
// Fallback: if the SW wakes up with no client open, we use this cache.
// ID tokens are valid for 60 min; Firebase clients refresh them automatically.
let cachedIdToken = null;
let cachedIdTokenExpiresAt = 0;

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Pages can push a fresh ID token into the SW so that notificationclick can
// authenticate even when no app window is currently open.
self.addEventListener('message', (event) => {
  const msg = event && event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'EVERANE_SET_ID_TOKEN' && typeof msg.idToken === 'string') {
    cachedIdToken = msg.idToken;
    // Be conservative — assume 55 min of remaining validity
    cachedIdTokenExpiresAt = Date.now() + (typeof msg.expiresInMs === 'number' ? msg.expiresInMs : 55 * 60 * 1000);
  } else if (msg.type === 'EVERANE_CLEAR_ID_TOKEN') {
    cachedIdToken = null;
    cachedIdTokenExpiresAt = 0;
  }
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    try {
      payload = { title: 'Everane', body: event.data ? event.data.text() : '' };
    } catch (_) {
      payload = { title: 'Everane', body: '' };
    }
  }

  const title = payload.title || 'Everane';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/logo.svg',
    badge: payload.badge || '/logo.svg',
    tag: payload.tag || undefined,
    renotify: payload.renotify === true,
    requireInteraction: payload.requireInteraction === true,
    // Vibrate pattern (ms): vibrate, pause, vibrate, pause, vibrate.
    // Helps make the notification noticeable on Android even with the screen off.
    vibrate: payload.vibrate || [200, 100, 200, 100, 200],
    // Allow the OS to play the default notification sound (it does anyway, but
    // marking silent:false explicitly prevents Android from ever silencing).
    silent: false,
    timestamp: Date.now(),
    data: payload.data || {},
    actions: Array.isArray(payload.actions) ? payload.actions : []
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Handle action buttons AND the notification body click.
self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {};
  const action = event.action || '';
  event.notification.close();

  // Action button -> Mark dose as Taken / Not Taken directly, without opening the app.
  if ((action === 'taken' || action === 'not_taken') && data.medId && data.doseDate && data.doseNumber) {
    event.waitUntil((async () => {
      try {
        await markDoseFromPush({
          medId: data.medId,
          doseDate: data.doseDate,
          doseNumber: data.doseNumber,
          doseTime: data.doseTime || '',
          taken: action === 'taken'
        });
        // Show a small confirmation notification so the user knows it worked.
        await self.registration.showNotification(
          action === 'taken' ? `✓ Marked as Taken` : `✓ Marked as Not Taken`,
          {
            body: `${data.medName || 'Medication'}${data.doseNumber ? ' · Dose #' + data.doseNumber : ''}`,
            icon: '/logo.svg',
            badge: '/logo.svg',
            tag: 'confirm-' + (data.medId || '') + '-' + (data.doseDate || '') + '-' + (data.doseNumber || ''),
            requireInteraction: false,
            silent: true
          }
        );
      } catch (err) {
        // Fall back to opening the email-action page so the user can mark manually.
        const url = data.url || '/home.html';
        if (self.clients.openWindow) await self.clients.openWindow(url);
      }
    })());
    return;
  }

  // Default click -> open the app to the relevant page.
  const actionUrl = data.url || '/home.html';
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      try {
        const url = new URL(client.url);
        if (url.origin === self.location.origin) {
          await client.focus();
          if ('navigate' in client) {
            try { await client.navigate(actionUrl); } catch (e) { /* ignore */ }
          }
          return;
        }
      } catch (e) { /* ignore */ }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(actionUrl);
    }
  })());
});

self.addEventListener('pushsubscriptionchange', (event) => {
  // Browser invalidated the subscription; the app will re-subscribe next visit.
});

/**
 * Mark a dose's taken/not-taken status from within the service worker.
 * Uses the Firebase callable endpoint `markDoseFromPush`. Auth comes from
 * an ID token — first tries any open app window (freshest), then falls back
 * to the cached token from a previous session.
 */
async function markDoseFromPush({ medId, doseDate, doseNumber, doseTime, taken }) {
  const idToken = await getIdToken();
  if (!idToken) throw new Error('no-auth-client');

  const projectId = 'medtracker-8c467';
  const url = `https://us-central1-${projectId}.cloudfunctions.net/markDoseFromPush`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + idToken
    },
    body: JSON.stringify({
      data: { medId, doseDate, doseNumber, doseTime, taken }
    })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // If the token is expired/invalid, clear our cache so we don't keep trying it
    if (res.status === 401 || res.status === 403) {
      cachedIdToken = null;
      cachedIdTokenExpiresAt = 0;
    }
    throw new Error('markDoseFromPush ' + res.status + ': ' + text.slice(0, 200));
  }
  return res.json();
}

/**
 * Get a Firebase ID token to authenticate SW-side calls.
 * Order of preference:
 *   1. Ask any currently-open client window for a fresh token (best)
 *   2. Use our cached token if still within its validity window
 * Returns null if neither is available.
 */
async function getIdToken() {
  const fromClient = await getIdTokenFromAnyClient();
  if (fromClient) {
    cachedIdToken = fromClient;
    cachedIdTokenExpiresAt = Date.now() + 55 * 60 * 1000;
    return fromClient;
  }
  if (cachedIdToken && Date.now() < cachedIdTokenExpiresAt) {
    return cachedIdToken;
  }
  return null;
}

/**
 * Post a message to any client window asking for the current user's
 * Firebase ID token. Uses a MessageChannel so we can await the reply.
 * Returns null if no client is open or replies in time.
 */
async function getIdTokenFromAnyClient(timeoutMs = 2500) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (clients.length === 0) return null;

  return await new Promise((resolve) => {
    let done = false;
    const chan = new MessageChannel();
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeoutMs);
    chan.port1.onmessage = (ev) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve((ev.data && ev.data.idToken) || null);
    };
    try {
      clients[0].postMessage({ type: 'EVERANE_GET_ID_TOKEN' }, [chan.port2]);
    } catch (e) {
      if (!done) { done = true; clearTimeout(timer); resolve(null); }
    }
  });
}
