/* ════════════════════════════════════════════════════════
   CLOAK SERVICE WORKER
   App-shell caching for instant repeat loads + basic offline.

   HARD RULE: the AI API (api.usecloak.org) and Supabase (auth/DB)
   are NEVER cached. Only GET requests for the static shell, fonts,
   and pinned CDN libs are cached (stale-while-revalidate).

   Bump CACHE_VERSION in lockstep with the ?v= asset query strings
   in chat.html on every deploy so old shells are purged.
   ════════════════════════════════════════════════════════ */
const CACHE_VERSION = 'cloak-v1.1.278';

const SHELL = [
  '/chat.html',
  '/version.js?v=1.1.278',
  '/cloak.css?v=1.1.278',
  '/cloak.js?v=1.1.278',
  '/phone-agent.js?v=1.1.278',
  '/search.js?v=1.1.278',
  '/effort.js?v=1.1.278',
  '/agent-orbit.js?v=1.1.278',
  '/search-patch.js?v=1.1.278',
  '/search.css?v=1.1.278',
  '/brain.css?v=1.1.278',
  '/memory.js?v=1.1.278',
  '/context.js?v=1.1.278',
  '/brain.js?v=1.1.278',
  '/thread.js?v=1.1.278',
  '/builds.js?v=1.1.278',
  '/builds.css?v=1.1.278',
  '/motion.js?v=1.1.278',
  '/manifest.json?v=20261001rollfix2',  '/icons/orb.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png'
];

// Hosts that must NEVER be cached (auth + AI + realtime DB).
const NETWORK_ONLY = ['api.usecloak.org', 'supabase.co', 'supabase.in'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      // addAll is atomic; use individual puts so one 404 can't abort install.
      .then(cache => Promise.allSettled(SHELL.map(u => cache.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
    // One reload per cache generation. A second worker install in the same
    // generation (the registration URL changing) must not reload again.
    const cache = await caches.open(CACHE_VERSION);
    if (await cache.match('/__reloaded')) return;
    await cache.put('/__reloaded', new Response('1'));
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await Promise.all(clients.map(async (client) => {
      if (typeof client.navigate !== 'function') return;
      try {
        const u = new URL(client.url);
        if (u.origin !== self.location.origin || u.searchParams.get('sw') === CACHE_VERSION) return;
        u.searchParams.set('sw', CACHE_VERSION);
        await client.navigate(u.toString());
      } catch (_) {}
    }));
  })());
});

// The version label and the document must not come from a stale shell.
// Caching sw.js itself also froze updates: the old worker kept serving itself.
function mustRevalidate(url, req) {
  return req.mode === 'navigate'
    || url.pathname === '/sw.js'
    || url.pathname === '/version.js'
    || url.pathname === '/chat.html'
    || url.pathname === '/';
}

async function fromNetwork(req) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const res = await fetch(req);
    if (res && res.ok && !res.redirected) cache.put(req, res.clone()).catch(() => {});
    if (res && res.ok) return res;
    return (await cache.match(req)) || res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;            // never touch POSTs (chat API, auth)

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // AI / auth / DB → straight to network, no cache fallback.
  if (NETWORK_ONLY.some(h => url.hostname.includes(h))) return;
  // Let the browser fetch the worker script itself. Responding here with a
  // cached copy means a new deploy never installs.
  if (url.origin === self.location.origin && url.pathname === '/sw.js') return;

  const sameOrigin = url.origin === self.location.origin;
  const isFontFile = url.hostname === 'fonts.gstatic.com';
  const isCDN = url.hostname.includes('cdn.jsdelivr.net') || url.hostname.includes('cdnjs.cloudflare.com');

  if (!(sameOrigin || isFontFile || isCDN)) return;

  if (mustRevalidate(url, req)) {
    e.respondWith(fromNetwork(req));
    return;
  }

  e.respondWith(
    caches.open(CACHE_VERSION).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => {
        if (res && res.ok && !res.redirected) cache.put(req, res.clone()).catch(() => {});
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
