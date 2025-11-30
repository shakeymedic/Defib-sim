const CACHE_NAME = 'zoll-sim-v1';
const ASSETS = [
  './',
  './index.html',
  './images/logo.png',
  'https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((response) => response || fetch(e.request))
  );
});
