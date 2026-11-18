import { useSyncExternalStore } from 'react'

type InstallPromptEvent = Event & { prompt: () => Promise<void> }

// The browser fires this once, early, and only while the app is installable and not yet installed.
let deferred: InstallPromptEvent | null = null
const listeners = new Set<() => void>()
const set = (e: InstallPromptEvent | null) => {
  deferred = e
  listeners.forEach((l) => l())
}

addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  set(e as InstallPromptEvent)
})
addEventListener('appinstalled', () => set(null))

/** Returns a function that opens the install dialog, or null when install isn't available. */
export function useInstall(): (() => void) | null {
  const e = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
    () => deferred,
  )
  return e && (() => void e.prompt().then(() => set(null)))
}
