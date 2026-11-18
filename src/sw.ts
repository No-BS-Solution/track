/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute, type PrecacheEntry } from 'workbox-precaching'

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (PrecacheEntry | string)[] }

// Static app shell only. Supabase API/auth requests are cross-origin and never cached.
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

self.addEventListener('install', () => void self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

type PushData = { title: string; body: string; url: string; tag: string }

self.addEventListener('push', (event) => {
  const data = event.data?.json() as PushData | undefined
  if (!data) return
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      // The open app already shows the message.
      if (windows.some((w) => w.focused && w.visibilityState === 'visible')) return
      await self.registration.showNotification(data.title, {
        body: data.body,
        tag: data.tag,
        icon: 'icon-192.png',
        data: { url: data.url },
      })
    })(),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL((event.notification.data as { url?: string } | null)?.url ?? '', self.registration.scope).href
  event.waitUntil(
    (async () => {
      const [win] = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      if (!win) return void (await self.clients.openWindow(url))
      win.postMessage({ type: 'open', url })
      await win.focus()
    })(),
  )
})
