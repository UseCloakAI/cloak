/* ════════════════════════════════════════════════════════
   CLOAK SERVICE WORKER
   App-shell caching for instant repeat loads + basic offline.

   HARD RULE: the AI API (api.usecloak.org) and Supabase (auth/DB)
   are NEVER cached. Only GET requests for the static shell, fonts,
   and pinned CDN libs are cached (stale-while-revalidate).

   Bump CACHE_VERSION in lockstep with the ?v= asset query strings
   in chat.html on every deploy so old shells are purged.
   ════════════════════════════════════════════════════════ */
const CACHE_VERSION = 'cloak-v20260928pages1';

const SHELL = [
  '/chat.html',
  '/cloak.css?v=20260928pages1',
  '/cloak.js?v=20260928pages1',
  '/search.js?v=20260928pages1',
  '/search-patch.js?v=20260928pages1',
  '/search.css?v=20260928pages1',
  '/brain.css?v=20260928pages1',
  '/memory.js?v=20260928pages1',
  '/context.js?v=20260928pages1',
  '/brain.js?v=20260928pages1',
  '/thread.js?v=20260928pages1',
  '/motion.js?v=20260928pages1',
  '/manifest.json?v=20260928pages1',
  '/icons/orb.svg',
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
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;            // never touch POSTs (chat API, auth)

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // AI / auth / DB → straight to network, no cache fallback.
  if (NETWORK_ONLY.some(h => url.hostname.includes(h))) return;

  const sameOrigin = url.origin === self.location.origin;
  const isFontFile = url.hostname === 'fonts.gstatic.com';
  const isCDN = url.hostname.includes('cdn.jsdelivr.net') || url.hostname.includes('cdnjs.cloudflare.com');

  if (sameOrigin || isFontFile || isCDN) {
    e.respondWith(
      caches.open(CACHE_VERSION).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req).then((res) => {
          if (res && res.status === 200 && res.type !== 'opaqueredirect') {
            cache.put(req, res.clone());
          }
          return res;
        }).catch(() => cached);
        return cached || network;   // stale-while-revalidate
      })
    );
  }
  // everything else: default network passthrough
});
