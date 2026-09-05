/*
 * sw.js — offline app-shell service worker for weather-dashboard.html.
 *
 * Scope: caches ONLY the static shell (the HTML + the two CDN library
 * files/styles it loads). It never touches any data API or map-tile
 * request — those always go straight to the network so forecasts, radar
 * tiles and lightning are never served stale from a cache.
 *
 * Bump CACHE below whenever the shell (this file's precache list, or the
 * app's pinned CDN versions) needs to be refreshed — the old cache is
 * deleted on activate and everything is refetched.
 */
const CACHE = 'wd-shell-v3.16';

const PRECACHE = [
  './weather-dashboard.html',
  './weather-dashboard', // Cloudflare serves the extensionless URL (and 307s the .html one to it)
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // best-effort: one flaky CDN fetch must not block the whole shell from installing
    await Promise.allSettled(PRECACHE.map((url) => cache.add(url).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => n.startsWith('wd-shell-') && n !== CACHE).map((n) => caches.delete(n))
    );
    self.clients.claim();
  })());
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) {
      // a redirected response (e.g. /x.html -> /x on Cloudflare) cannot be handed to a
      // navigation request (redirect mode 'manual') — unwrap it into a plain 200
      if (cached.redirected) return new Response(cached.body, { status: 200, headers: cached.headers });
      return cached;
    }
    throw e;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never touch non-GET requests

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  const sameOrigin = url.origin === self.location.origin;

  // (a) navigations and same-origin .html — network-first, cache fallback
  const isHtmlNav = req.mode === 'navigate' || (sameOrigin && url.pathname.endsWith('.html'));
  if (isHtmlNav) {
    event.respondWith(networkFirst(req));
    return;
  }

  // (b) the app's own CDN script/style URLs (cdnjs / jsDelivr) — cache-first,
  // versioned URLs so a stale cache hit is never wrong
  const isAppCdn = url.hostname === 'cdnjs.cloudflare.com' || url.hostname === 'cdn.jsdelivr.net';
  const isScriptOrStyle = req.destination === 'script' || req.destination === 'style'
    || url.pathname.endsWith('.js') || url.pathname.endsWith('.css');
  if (isAppCdn && isScriptOrStyle) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // (c) everything else — Open-Meteo, RainViewer tiles, OSM tiles, Nominatim,
  // Overpass, Blitzortung, the AI feed, manifest icons fetched standalone,
  // etc. — pass through untouched. No respondWith(): the network handles it
  // exactly as if this service worker did not exist. Never cache these.
});
