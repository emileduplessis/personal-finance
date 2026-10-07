/* ============================================================
   sw.js — Service worker: instant loads + offline app shell.
   Strategy:
   - Supabase (and any non-GET) requests: never intercepted.
   - Navigations: network-first, cached page as offline fallback.
   - Same-origin CSS/JS: network-first so styles always match the
     fresh HTML (stale-while-revalidate caused unstyled first loads
     after every deploy), cache as offline fallback.
   - Other static assets (icons, CDN, fonts): stale-while-revalidate.
   Bump CACHE_VERSION when shipping changes to force a refresh.
   ============================================================ */

const CACHE_VERSION = 'pf-v63';

/* Clean URLs (vercel.json cleanUrls:true / serve.json): pages are served
   without the ".html" suffix; "/dashboard" is the app, "/" the landing page. Precache the
   clean paths so install fetches a direct 200 (a ".html" path would 301 to
   the clean URL and fail to cache). */
const PRECACHE = [
  '/dashboard',
  '/login',
  '/manifest.json',
  '/transactions',
  '/add-transaction',
  '/budget',
  '/settings',
  '/cash-flow',
  '/subscriptions',
  '/crypto',
  '/hours-tracker',
  '/styles/fonts.css',
  '/fonts/inter-latin.woff2',
  '/fonts/jetbrains-mono-latin.woff2',
  '/styles/main.css',
  '/styles/layout.css',
  '/styles/components.css',
  '/styles/dashboard.css',
  '/styles/pages.css',
  '/scripts/vendor/supabase-2.117.3.min.js',
  '/scripts/data/supabase.js',
  '/scripts/data/store.js',
  '/scripts/data/crypto.js',
  '/scripts/engine/summary.js',
  '/scripts/engine/insights.js',
  '/scripts/engine/shifts.js',
  '/scripts/components/charts.js',
  '/scripts/components/nav.js',
  '/scripts/components/icons.js',
  '/scripts/components/ui.js',
  '/scripts/components/add-modal.js',
  '/scripts/components/insights-popover.js',
  '/scripts/components/tour.js',
  '/scripts/pages/dashboard.js',
  '/scripts/pages/shifts.js',
  '/scripts/pages/accounts.js',
  '/scripts/pages/transactions.js',
  '/scripts/pages/add-transaction.js',
  '/scripts/pages/budget.js',
  '/scripts/pages/settings.js',
  '/scripts/pages/spending.js',
  '/scripts/pages/subscriptions.js',
  '/scripts/pages/crypto.js',
  '/icons/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => Promise.allSettled(PRECACHE.map(url => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  /* live data + auth go straight to the network, always */
  if (url.hostname.endsWith('.supabase.co')) return;

  /* live crypto balances/prices: never cache — always hit the network so
     the SW can't serve a stale balance or sit in the failure path */
  if (url.hostname === 'blockstream.info' ||
      url.hostname === 'api.coingecko.com' ||
      url.hostname.endsWith('.publicnode.com')) return;

  /* our serverless API (e.g. /api/crypto) returns live data — never cache */
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  /* page navigations: fresh when online, cached shell when offline.
     Only cache clean 200s — never a redirect or error, or a stale bad
     response (e.g. a proxy's .html→clean redirect) gets pinned and
     served on every future load. */
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.ok && !res.redirected && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then(hit => hit || caches.match('/dashboard'))
        )
    );
    return;
  }

  /* same-origin CSS/JS: network-first so they never lag behind the HTML */
  const isStyleOrScript = url.origin === self.location.origin &&
    (req.destination === 'style' || req.destination === 'script' ||
     url.pathname.endsWith('.css') || url.pathname.endsWith('.js'));
  if (isStyleOrScript) {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  /* other static assets: serve cache immediately, refresh it in the background.
     Never cache a redirect (a proxy stripping .html would otherwise get pinned). */
  event.respondWith(
    caches.match(req).then(hit => {
      const refresh = fetch(req)
        .then(res => {
          if (res && !res.redirected && (res.ok || res.type === 'opaque')) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || refresh;
    })
  );
});
