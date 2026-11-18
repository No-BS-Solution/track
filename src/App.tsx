import { useEffect, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { endPasswordRecovery, passwordRecovery, supabase } from './supabase'
import { Auth, SetPassword } from './Auth'
import { Home } from './Home'
import { WorkspaceView } from './Workspace'
import { stopPush, syncPush } from './push'

function useHash(): string {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const onChange = () => setHash(location.hash)
    addEventListener('hashchange', onChange)
    return () => removeEventListener('hashchange', onChange)
  }, [])
  return hash
}

// A tapped notification asks the open window to go to its workspace.
navigator.serviceWorker?.addEventListener('message', (e: MessageEvent<{ type?: string; url?: string }>) => {
  if (e.data?.type === 'open' && e.data.url) location.href = e.data.url
})

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [recovering, setRecovering] = useState(false)
  const [notice, setNotice] = useState('')
  const signingOut = useRef(false)
  const hash = useHash()

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    supabase.auth.getSession().then(({ data }) => {
      const linkError = params.get('error_description')
      if (linkError) setNotice(linkError)
      else if (params.has('code') && !data.session)
        setNotice('That link expired or was opened in a different browser. If you just confirmed your email, sign in below.')
      if (location.search) history.replaceState(null, '', location.pathname + location.hash)
      setRecovering(passwordRecovery)
      setSession(data.session)
    })
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'SIGNED_OUT' && !signingOut.current) setNotice('Your session expired. Please sign in again.')
      if (event === 'PASSWORD_RECOVERY') setRecovering(true)
      signingOut.current = false
      setSession(s)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  const userId = session?.user.id
  useEffect(() => {
    if (userId) void syncPush()
  }, [userId])

  const signOut = async () => {
    signingOut.current = true
    setNotice('')
    await stopPush().catch(() => {})
    void supabase.auth.signOut()
  }

  if (session === undefined) return <p className="center muted">Loading...</p>
  if (!session) return <Auth notice={notice} />
  if (recovering)
    return (
      <SetPassword
        onDone={() => {
          endPasswordRecovery()
          setRecovering(false)
        }}
      />
    )

  const me = session.user.id
  const ws = hash.match(/^#\/w\/([0-9a-f-]{36})$/)
  if (ws) return <WorkspaceView key={ws[1]} workspaceId={ws[1]} me={me} />
  const join = hash.match(/^#\/join\/([0-9a-fA-F]{12})$/)
  return <Home me={me} email={session.user.email ?? ''} joinCode={join?.[1] ?? ''} onSignOut={signOut} />
}
