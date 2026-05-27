// ROCKS Game — Service Worker
// Caches game files for offline play (VS AI and 2 Players modes)

const CACHE_NAME = 'rocks-game-v1';
const SERVER_URL = 'https://rocks-gmae-3.onrender.com';

// Files to cache for offline use
const STATIC_FILES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-72x72.png',
  '/icons/icon-96x96.png',
  '/icons/icon-128x128.png',
  '/icons/icon-144x144.png',
  '/icons/icon-152x152.png',
  '/icons/icon-192x192.png',
  '/icons/icon-384x384.png',
  '/icons/icon-512x512.png',
  'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Crimson+Pro:ital,wght@0,400;0,600;1,400&display=swap'
];

// Install — cache all static files
self.addEventListener('install', event => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Caching static files');
      return cache.addAll(STATIC_FILES.filter(url => !url.includes('fonts.googleapis')))
        .then(() => {
          // Try fonts separately — non-critical
          return cache.add('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Crimson+Pro:ital,wght@0,400;0,600;1,400&display=swap')
            .catch(() => console.log('[SW] Fonts not cached — ok'));
        });
    }).then(() => self.skipWaiting())
  );
});

// Activate — clean old caches
self.addEventListener('activate', event => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => {
          console.log('[SW] Deleting old cache:', key);
          return caches.delete(key);
        })
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch — serve from cache, fall back to network
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Skip Socket.IO requests — always go to network (online multiplayer)
  if (url.includes('/socket.io/') || url.includes('socket.io')) return;

  // Skip cross-origin API calls
  if (url.includes('onrender.com') && url.includes('/socket')) return;

  // For navigation requests (page load) — cache first, then network
  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.match('/index.html').then(cached => {
        if (cached) return cached;
        return fetch(event.request).catch(() => caches.match('/index.html'));
      })
    );
    return;
  }

  // For static assets — cache first, fall back to network
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache new successful responses
        if (response && response.status === 200 && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback for HTML
        if (event.request.headers.get('accept')?.includes('text/html')) {
          return caches.match('/index.html');
        }
      });
    })
  );
});

// Handle messages from the app
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
