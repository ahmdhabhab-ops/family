// Minimal service worker - just enough to satisfy PWA "installable" criteria.
// This app is data-live (Supabase), so we don't cache app data - just pass requests through.
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Pass-through: always go to network, no offline caching of live data.
  event.respondWith(fetch(event.request));
});
