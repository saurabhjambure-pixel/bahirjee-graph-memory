/*
 * Service-worker kill switch. This file exists to REMOVE a service worker, not to be one.
 *
 * Until 2026-08-16 the app shipped a vite-plugin-pwa worker at /sw.js (registerType:
 * 'autoUpdate', precaching index.html and every hashed bundle). The plugin and the
 * registration were then deleted — but a worker that is already installed in a browser does
 * not go away because the site stopped registering it. With /sw.js now a 404 it could never
 * update either, so every browser that visited before that date kept serving its precached
 * copy of the app: a deploy never reached them until a hard refresh bypassed the worker.
 *
 * Browsers re-fetch the worker's own script URL on navigation. Serving THIS file there
 * replaces the old worker, which then clears every cache, unregisters itself and reloads
 * its tabs onto the network. Once nothing is registered anywhere this file is inert, and
 * leaving it in place is what keeps a browser that has been away for months from staying
 * stranded. Do not add caching to it.
 */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    } catch { /* nothing cached, or caches unavailable */ }
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) client.navigate(client.url).catch(() => {});
  })());
});
