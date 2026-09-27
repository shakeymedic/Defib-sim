// sw.js - Offline support
// Bump CACHE_VERSION when the precached files change.
const CACHE_VERSION = 'defib-sim-v2';

const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './images/logo-192.png',
  './images/logo-512.png'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_VERSION).then(function(cache) {
      // Add individually so one missing file doesn't stop the app working offline
      return Promise.all(PRECACHE.map(function(url) {
        return cache.add(url).catch(function() {});
      }));
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames
          .filter(function(name) { return name !== CACHE_VERSION; })
          .map(function(name) { return caches.delete(name); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(e) {
  const request = e.request;
  if (request.method !== 'GET') return;

  // Pages: network first so updates arrive straight away, cache when offline
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request).then(function(response) {
        const copy = response.clone();
        caches.open(CACHE_VERSION).then(function(cache) { cache.put('./index.html', copy); });
        return response;
      }).catch(function() {
        return caches.match('./index.html');
      })
    );
    return;
  }

  // Everything else (images, manifest, web font): cache first, refreshed in the background
  e.respondWith(
    caches.match(request).then(function(cached) {
      const network = fetch(request).then(function(response) {
        if (response && (response.ok || response.type === 'opaque')) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then(function(cache) { cache.put(request, copy); });
        }
        return response;
      }).catch(function() {
        return cached;
      });
      return cached || network;
    })
  );
});
