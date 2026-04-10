// Service Worker for PolicyLens PWA
// Handles offline receipt capture queuing and background sync

const CACHE_NAME = 'policylens-v1'
const OFFLINE_QUEUE_KEY = 'policylens-offline-queue'

// Cache static assets on install
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll([
        '/',
        '/employee/submit',
        '/employee/claims',
        '/employee/dashboard',
      ])
    )
  )
  self.skipWaiting()
})

// Activate and clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  )
  self.clients.claim()
})

// Intercept fetch: serve from cache for navigation, network-first for API
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // Pass through non-GET and API calls normally (those are handled by the client-side queue)
  if (event.request.method !== 'GET') return
  if (url.pathname.startsWith('/api/')) return

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        // Update cache for navigation requests
        if (event.request.mode === 'navigate') {
          const clone = res.clone()
          caches.open(CACHE_NAME).then((c) => c.put(event.request, clone))
        }
        return res
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('/')))
  )
})

// Background Sync: flush offline queued claims when back online
self.addEventListener('sync', (event) => {
  if (event.tag === 'flush-offline-claims') {
    event.waitUntil(flushOfflineClaims())
  }
})

async function flushOfflineClaims() {
  // Signal all open windows to flush the queue
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const client of clients) {
    client.postMessage({ type: 'FLUSH_OFFLINE_QUEUE' })
  }
}
