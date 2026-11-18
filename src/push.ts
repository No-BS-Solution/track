import { supabase } from './supabase'

const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY
// Without a VAPID key (e.g. a fork that skipped push setup) the app falls back to in-page notifications.
export const pushAvailable = !!vapidKey && 'serviceWorker' in navigator && 'PushManager' in window

/** Saves this browser's push subscription for the signed-in user. Safe to call repeatedly. */
export async function syncPush(): Promise<void> {
  if (!pushAvailable || Notification.permission !== 'granted') return
  const reg = await navigator.serviceWorker.ready
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKey }))
  const { keys } = sub.toJSON()
  if (keys) await supabase.rpc('save_push_subscription', { p_endpoint: sub.endpoint, p_p256dh: keys.p256dh, p_auth: keys.auth })
}

export async function enableNotifications(): Promise<NotificationPermission> {
  const permission = await Notification.requestPermission()
  await syncPush()
  return permission
}

/** Stops pushes to this browser, e.g. on sign out. */
export async function stopPush(): Promise<void> {
  if (!pushAvailable) return
  const sub = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription()
  if (!sub) return
  await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)
  await sub.unsubscribe()
}
