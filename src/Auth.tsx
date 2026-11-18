import { useState, type FormEvent } from 'react'
import type { AuthError } from '@supabase/supabase-js'
import { appUrl, supabase } from './supabase'

const errorText: Record<string, string> = {
  email_not_confirmed: 'Your email is not confirmed yet. Open the confirmation link we emailed you, then sign in.',
  signup_disabled: 'Sign-ups are disabled on this server. Ask the person who runs it to create your account.',
  email_provider_disabled: 'Sign-ups are disabled on this server. Ask the person who runs it to create your account.',
  invalid_credentials: 'Wrong email or password.',
  user_already_exists: 'An account with this email already exists. Sign in instead.',
}

const describe = (e: AuthError) => (e.code && errorText[e.code]) || e.message

export function Auth({ notice }: { notice: string }) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState(notice)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setMessage('')
    if (mode === 'signin') {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) setMessage(describe(error))
    } else {
      const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: appUrl } })
      if (error) setMessage(describe(error))
      else if (!data.session) setMessage('Check your email and open the confirmation link, then sign in here.')
    }
    setBusy(false)
  }

  return (
    <main className="auth">
      <h1>Track</h1>
      <form onSubmit={submit} className="stack">
        <h2>{mode === 'signin' ? 'Sign in' : 'Create account'}</h2>
        {message && <p role="alert" className="notice">{message}</p>}
        <label>
          Email
          <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Password
          <input
            type="password"
            required
            minLength={6}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button className="primary" disabled={busy}>{mode === 'signin' ? 'Sign in' : 'Create account'}</button>
        <button type="button" className="link" onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setMessage('') }}>
          {mode === 'signin' ? 'No account? Create one' : 'Have an account? Sign in'}
        </button>
      </form>
    </main>
  )
}
