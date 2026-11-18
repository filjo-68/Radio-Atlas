const APP_URL = new URL(self.registration.scope);
const CACHE_PREFIX = `radio-atlas:${APP_URL.href}:`;
const CACHE_VERSION = '5';
const SHELL_CACHE = `${CACHE_PREFIX}shell-${CACHE_VERSION}`;
const CATALOG_CACHE = `${CACHE_PREFIX}catalog-2`;
const SHELL_PATHS = new Set([
  'index.html',
  'styles.css',
  'app.js',
  'i18n.js',
  'translations.js',
  'data.js',
  'player.js',
  'stats.js',
  'manifest.webmanifest',
  'assets/hero.webp',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png'
]);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const requests = Array.from(SHELL_PATHS, (path) =>
      new Request(new URL(path, APP_URL), { cache: 'reload' })
    );
    await cache.addAll(requests);
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const activeCaches = new Set([SHELL_CACHE, CATALOG_CACHE]);
    const staleCaches = (await caches.keys()).filter(
      (name) => name.startsWith(CACHE_PREFIX) && !activeCaches.has(name)
    );
    await Promise.all(staleCaches.map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function appShellResponse(request, path) {
  const cache = await caches.open(SHELL_CACHE);
  return (await cache.match(new URL(path, APP_URL))) || fetch(request);
}

async function catalogResponse(request) {
  const path = new URL(request.url).pathname;
  const refresh = path.endsWith('.json');
  const expectedType = refresh ? 'json'
    : path.endsWith('.png') ? 'image/png'
      : 'javascript';
  let cache, stored;
  try {
    cache = await caches.open(CATALOG_CACHE);
    stored = await cache.match(request);
    if (stored && !refresh) return stored;
  } catch {
    // Storage can be unavailable in private mode or at quota.
  }
  try {
    const response = await fetch(request, refresh ? { cache: 'no-cache' } : undefined);
    if (!response.ok || !response.headers.get('Content-Type')?.includes(expectedType)) {
      return stored || response;
    }
    try {
      await cache?.put(request, response.clone());
    } catch {
      // The live response is still useful when the cache is full.
    }
    return response;
  } catch {
    return stored || new Response('Resource unavailable offline.', { status: 503 });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.headers.has('Range')) return;
  const url = new URL(request.url);
  if (url.origin !== APP_URL.origin || !url.pathname.startsWith(APP_URL.pathname)) return;
  const path = url.pathname.slice(APP_URL.pathname.length);

  if (request.mode === 'navigate' && (path === '' || path === 'index.html')) {
    event.respondWith(appShellResponse(request, 'index.html'));
  } else if (SHELL_PATHS.has(path)) {
    event.respondWith(appShellResponse(request, path));
  } else if (path === 'vendor/hls.light.min.mjs' ||
    /^(?:data\/[a-z]{2}\.json|assets\/flags\/[a-z]{2}\.png)$/.test(path)) {
    event.respondWith(catalogResponse(request));
  }
});
