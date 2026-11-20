import { useCallback, useEffect, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from './supabase'

// `at` changes on every refresh so a still-typing user re-syncs; old clients omit it.
type State = { typing: boolean; at?: number }
// A typing flag not refreshed for this long is stale (sender backgrounded, closed or dropped the "stopped" update).
const TYPING_STALE_MS = 8000

/**
 * Who is online in a workspace and who is typing, over a private Realtime channel.
 * Membership is enforced by policies on realtime.messages (see migrations).
 */
export function usePresence(workspaceId: string, me: string) {
  const [state, setState] = useState<Record<string, State>>({})
  const [now, setNow] = useState(Date.now)
  // When each user's latest typing refresh arrived, in local time (device clocks can't be compared).
  const seen = useRef<Record<string, { at: number; local: number }>>({})
  const channel = useRef<RealtimeChannel | null>(null)

  useEffect(() => {
    const ch = supabase.channel(`presence:${workspaceId}`, { config: { private: true, presence: { key: me } } })
    ch.on('presence', { event: 'sync' }, () => {
      const raw = ch.presenceState<State>()
      for (const [user, metas] of Object.entries(raw)) {
        const at = Math.max(-1, ...metas.filter((m) => m.typing).map((m) => m.at ?? 0))
        if (at < 0) delete seen.current[user]
        else if (seen.current[user]?.at !== at) seen.current[user] = { at, local: Date.now() }
      }
      setState(Object.fromEntries(Object.entries(raw).map(([user, metas]) => [user, { typing: metas.some((m) => m.typing) }])))
      setNow(Date.now())
    }).subscribe((status) => {
      if (status === 'SUBSCRIBED') void ch.track({ typing: false })
    })
    channel.current = ch
    return () => {
      channel.current = null
      void supabase.removeChannel(ch)
    }
  }, [workspaceId, me])

  const setTyping = useCallback((typing: boolean) => void channel.current?.track({ typing, at: Date.now() }), [])

  const typing = Object.entries(state)
    .filter(([user, s]) => s.typing && user !== me && now - (seen.current[user]?.local ?? 0) < TYPING_STALE_MS)
    .map(([user]) => user)

  // Re-check once the oldest shown typing flag would go stale.
  useEffect(() => {
    if (typing.length === 0) return
    const t = setTimeout(() => setNow(Date.now()), 1000)
    return () => clearTimeout(t)
  }, [typing.length, now])

  return { online: new Set(Object.keys(state)), typing, setTyping }
}
