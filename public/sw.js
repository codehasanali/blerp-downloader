// Basit, boş bir service worker.
// Sadece /sw.js isteğine 200 dönmesi için var; herhangi bir cache mantığı yok.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", () => {
  self.clients.claim();
});

