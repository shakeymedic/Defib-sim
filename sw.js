// sw.js - Offline support
// Bump CACHE_VERSION when the precached file list changes.
const CACHE_VERSION = 'defib-sim-v4';

const PRECACHE = [
  './',
  './index.html',
  './instructor.html',
  './manifest.json',
  './css/styles.css',
  './css/instructor.css',
  './js/rhythms.js',
  './js/data.js',
  './js/link.js',
  './js/app.js',
  './js/instructor.js',
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

function putInCache(request, response) {
  if (response && (response.ok || response.type === 'opaque')) {
    const copy = response.clone();
    caches.open(CACHE_VERSION).then(function(cache) { cache.put(request, copy); });
  }
  return response;
}

self.addEventListener('fetch', function(e) {
  const request = e.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // Pages: network first, fall back to the cached copy of that page when
  // offline (ignoring ?session=...), then to the simulator itself
  if (request.mode === 'navigate') {
    const page = new URL(url.pathname, url.origin).href;
    e.respondWith(
      fetch(request).then(function(response) {
        return sameOrigin ? putInCache(page, response) : response;
      }).catch(function() {
        return caches.match(page).then(function(cached) {
          return cached || caches.match('./index.html');
        });
      })
    );
    return;
  }

  // App code and styles: network first so a new deploy never mixes old and new files
  if (sameOrigin && /\.(js|css|json)$/.test(url.pathname)) {
    e.respondWith(
      fetch(request).then(function(response) {
        return putInCache(request, response);
      }).catch(function() {
        return caches.match(request);
      })
    );
    return;
  }

  // Images and the web font: cache first, refreshed in the background
  e.respondWith(
    caches.match(request).then(function(cached) {
      const network = fetch(request).then(function(response) {
        return putInCache(request, response);
      }).catch(function() {
        return cached;
      });
      return cached || network;
    })
  );
});
