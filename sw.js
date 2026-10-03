// Bump this on every release that changes any cached first-party file - it's what triggers
// clients to pick up the new version (see the activate handler below, and registerServiceWorker
// in app.js which prompts an already-open tab to reload once the new worker takes over).
const CACHE_NAME = 'mathamorph-v1.7';

// MathLive, Compute Engine, and MathJax are all pinned to exact versions in index.html/app.js
// rather than loaded as "latest" - this is deliberate: an unannounced upstream release could
// otherwise silently change behaviour (or break something) underneath the app. Because every
// cached URL below therefore points at content that can never change, these never need
// revalidating - see isPinnedLibraryRequest/cacheFirstForever.
const PINNED_LIBRARY_ASSETS = [
  'https://unpkg.com/mathlive@0.111.0?module',
  'https://unpkg.com/mathlive@0.111.0/mathlive-static.css',
  'https://unpkg.com/mathlive@0.111.0/fonts/KaTeX_AMS-Regular.woff2',
  'https://unpkg.com/mathlive@0.111.0/fonts/KaTeX_Caligraphic-Bold.woff2',
  'https://unpkg.com/mathlive@0.111.0/fonts/KaTeX_Caligraphic-Regular.woff2',
  'https://unpkg.com/mathlive@0.111.0/fonts/KaTeX_Fraktur-Bold.woff2',
  'https://unpkg.com/mathlive@0.111.0/fonts/KaTeX_Fraktur-Regular.woff2',
  'https://unpkg.com/mathlive@0.111.0/fonts/KaTeX_Main-Bold.woff2',
  'https://unpkg.com/mathlive@0.111.0/fonts/KaTeX_Main-BoldItalic.woff2',
  'https://unpkg.com/mathlive@0.111.0/fonts/KaTeX_Main-Italic.woff2',
  'https://unpkg.com/mathlive@0.111.0/fonts/KaTeX_Main-Regular.woff2',
  'https://unpkg.com/mathlive@0.111.0/fonts/KaTeX_Math-BoldItalic.woff2',
  'https://unpkg.com/mathlive@0.111.0/fonts/KaTeX_Math-Italic.woff2',
  'https://unpkg.com/mathlive@0.111.0/fonts/KaTeX_SansSerif-Bold.woff2',
  'https://unpkg.com/mathlive@0.111.0/fonts/KaTeX_SansSerif-Italic.woff2',
  'https://unpkg.com/mathlive@0.111.0/fonts/KaTeX_SansSerif-Regular.woff2',
  'https://unpkg.com/mathlive@0.111.0/fonts/KaTeX_Script-Regular.woff2',
  'https://unpkg.com/mathlive@0.111.0/fonts/KaTeX_Size1-Regular.woff2',
  'https://unpkg.com/mathlive@0.111.0/fonts/KaTeX_Size2-Regular.woff2',
  'https://unpkg.com/mathlive@0.111.0/fonts/KaTeX_Size3-Regular.woff2',
  'https://unpkg.com/mathlive@0.111.0/fonts/KaTeX_Size4-Regular.woff2',
  'https://unpkg.com/mathlive@0.111.0/fonts/KaTeX_Typewriter-Regular.woff2',
  'https://unpkg.com/mathlive@0.111.0/sounds/keypress-delete.wav',
  'https://unpkg.com/mathlive@0.111.0/sounds/keypress-return.wav',
  'https://unpkg.com/mathlive@0.111.0/sounds/keypress-spacebar.wav',
  'https://unpkg.com/mathlive@0.111.0/sounds/keypress-standard.wav',
  'https://unpkg.com/mathlive@0.111.0/sounds/plonk.wav',
  'https://unpkg.com/@cortex-js/compute-engine@0.147.0?module',
  'https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-svg.js',
];

const OWN_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './images/logo.svg',
  './images/icon-192.png',
  './images/icon-512.png',
  './images/apple-touch-icon.png',
  './images/screenshot.png',
];

const ASSETS_TO_CACHE = [...OWN_ASSETS, ...PINNED_LIBRARY_ASSETS];

const PINNED_LIBRARY_HOSTS = new Set(['unpkg.com', 'cdn.jsdelivr.net']);

function isPinnedLibraryRequest(request) {
  try {
    return PINNED_LIBRARY_HOSTS.has(new URL(request.url).hostname);
  } catch {
    return false;
  }
}

// Install event - cache all first-party and pinned third-party assets.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS_TO_CACHE))
      .then(() => self.skipWaiting())
      .catch((error) => {
        console.error('Cache failed:', error);
        throw error;
      })
  );
});

// Activate event - clean up any caches left over from a previous version.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

function fetchWithTimeout(request, timeout) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timeoutId));
}

// Pinned library URLs point at content that can never change (see PINNED_LIBRARY_ASSETS above),
// so once cached they're served straight from the cache forever - no background revalidation,
// no re-downloading multi-megabyte bundles on every load.
async function cacheFirstForever(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetchWithTimeout(request, 10000);
    if (response.ok || response.type === 'opaque') {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('', { status: 504, statusText: 'Gateway Timeout' });
  }
}

// First-party assets change between releases, so serve the cached copy immediately but refresh
// it in the background for next time.
async function cacheFirstWithRevalidate(request) {
  const cached = await caches.match(request);
  if (cached) {
    fetchWithTimeout(request, 5000)
      .then((fresh) => {
        if (fresh && (fresh.ok || fresh.type === 'opaque')) {
          caches.open(CACHE_NAME).then((cache) => cache.put(request, fresh));
        }
      })
      .catch(() => {});
    return cached;
  }

  try {
    const response = await fetchWithTimeout(request, 5000);
    if (response.ok || response.type === 'opaque') {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const fallback = await caches.match(request, { ignoreSearch: true });
    return fallback || new Response('', { status: 504, statusText: 'Gateway Timeout' });
  }
}

async function handleNavigate(request) {
  const cached = await caches.match(request);
  if (cached) {
    fetchWithTimeout(request, 2000)
      .then((fresh) => {
        if (fresh.status === 200) {
          caches.open(CACHE_NAME).then((cache) => cache.put(request, fresh.clone()));
        }
      })
      .catch(() => {});
    return cached;
  }

  try {
    return await fetchWithTimeout(request, 2000);
  } catch {
    const fallback = await caches.match('./index.html');
    return fallback || new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigate(request));
    return;
  }

  if (isPinnedLibraryRequest(request)) {
    event.respondWith(cacheFirstForever(request));
    return;
  }

  event.respondWith(cacheFirstWithRevalidate(request));
});

// Lets a freshly-installed worker take over immediately when app.js asks it to (see
// registerServiceWorker), instead of waiting for every tab to close first.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
