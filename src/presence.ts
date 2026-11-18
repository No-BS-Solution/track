import { useCallback, useEffect, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from './supabase'

type State = { typing: boolean }

/**
 * Who is online in a workspace and who is typing, over a private Realtime channel.
 * Membership is enforced by policies on realtime.messages (see migrations).
 */
export function usePresence(workspaceId: string, me: string) {
  const [state, setState] = useState<Record<string, State>>({})
  const channel = useRef<RealtimeChannel | null>(null)

  useEffect(() => {
    const ch = supabase.channel(`presence:${workspaceId}`, { config: { private: true, presence: { key: me } } })
    ch.on('presence', { event: 'sync' }, () => {
      const raw = ch.presenceState<State>()
      setState(Object.fromEntries(Object.entries(raw).map(([user, metas]) => [user, { typing: metas.some((m) => m.typing) }])))
    }).subscribe((status) => {
      if (status === 'SUBSCRIBED') void ch.track({ typing: false })
    })
    channel.current = ch
    return () => {
      channel.current = null
      void supabase.removeChannel(ch)
    }
  }, [workspaceId, me])

  const setTyping = useCallback((typing: boolean) => void channel.current?.track({ typing }), [])

  return {
    online: new Set(Object.keys(state)),
    typing: Object.entries(state).filter(([user, s]) => s.typing && user !== me).map(([user]) => user),
    setTyping,
  }
}
