import { useState, type FormEvent } from 'react'
import type { AuthError } from '@supabase/supabase-js'
import { appUrl, supabase } from './supabase'
import { Logo } from './Icon'

const errorText: Record<string, string> = {
  email_not_confirmed: 'Your email is not confirmed yet. Open the confirmation link we emailed you, then sign in.',
  signup_disabled: 'Sign-ups are disabled on this server. Ask the person who runs it to create your account.',
  email_provider_disabled: 'Sign-ups are disabled on this server. Ask the person who runs it to create your account.',
  invalid_credentials: 'Wrong email or password.',
  user_already_exists: 'An account with this email already exists. Sign in instead.',
  same_password: 'Choose a password different from your old one.',
  weak_password: 'That password is too weak. Use at least 6 characters.',
  over_email_send_rate_limit: 'Too many emails were sent. Wait a few minutes and try again.',
}

const describe = (e: AuthError) => (e.code && errorText[e.code]) || e.message

type Mode = 'signin' | 'signup' | 'reset'
const titles: Record<Mode, string> = { signin: 'Welcome back', signup: 'Create your account', reset: 'Reset your password' }

export function Auth({ notice }: { notice: string }) {
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState(notice)
  const [busy, setBusy] = useState(false)

  const switchTo = (m: Mode) => {
    setMode(m)
    setMessage('')
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setMessage('')
    if (mode === 'signin') {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) setMessage(describe(error))
    } else if (mode === 'signup') {
      const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: appUrl } })
      if (error) setMessage(describe(error))
      else if (!data.session) setMessage('Check your email and open the confirmation link, then sign in here.')
    } else {
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: appUrl })
      setMessage(error ? describe(error) : 'If that email has an account, a reset link is on its way. Open it on this device.')
    }
    setBusy(false)
  }

  return (
    <main className="auth">
      <div className="auth-brand">
        <Logo />
        <span>Track</span>
      </div>
      <form onSubmit={submit} className="panel stack">
        <div>
          <h1>{titles[mode]}</h1>
          <p className="muted">Team chat and a board, in one place.</p>
        </div>
        {message && <p role="alert" className="notice">{message}</p>}
        <label className="field">
          <span>Email</span>
          <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {mode !== 'reset' && (
          <label className="field">
            <span className="row spread">
              Password
              {mode === 'signin' && (
                <button type="button" className="link" onClick={() => switchTo('reset')}>Forgot password?</button>
              )}
            </span>
            <input
              type="password"
              required
              minLength={6}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        )}
        <button className="btn primary block" disabled={busy}>
          {mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}
        </button>
        <p className="center-text muted">
          {mode === 'signin' ? 'No account yet? ' : mode === 'signup' ? 'Already have an account? ' : 'Remembered it? '}
          <button type="button" className="link" onClick={() => switchTo(mode === 'signin' ? 'signup' : 'signin')}>
            {mode === 'signin' ? 'Create one' : 'Sign in'}
          </button>
        </p>
      </form>
    </main>
  )
}

export function SetPassword({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    const { error } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (error) setMessage(describe(error))
    else onDone()
  }

  return (
    <main className="auth">
      <div className="auth-brand">
        <Logo />
        <span>Track</span>
      </div>
      <form onSubmit={submit} className="panel stack">
        <h1>Choose a new password</h1>
        {message && <p role="alert" className="notice">{message}</p>}
        <label className="field">
          <span>New password</span>
          <input type="password" required minLength={6} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="btn primary block" disabled={busy}>Save password</button>
      </form>
    </main>
  )
}
