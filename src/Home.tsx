import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from './supabase'
import { useInstall } from './install'
import { Avatar, Icon, Logo } from './Icon'
import { ThemeToggle } from './theme'

type Row = { workspace_id: string; role: string; last_read_at: string; workspaces: { name: string } | null; unread: number }

export function Home({ me, email, joinCode, onSignOut }: { me: string; email: string; joinCode: string; onSignOut: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [newName, setNewName] = useState('')
  const [code, setCode] = useState(joinCode)
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const install = useInstall()

  useEffect(() => {
    supabase
      .from('workspace_members')
      .select('workspace_id, role, last_read_at, workspaces(name)')
      .eq('user_id', me)
      .then(async ({ data, error }) => {
        if (error) return setError(error.message)
        // shortcut: one count query per workspace, fine for a handful of workspaces.
        const withUnread = await Promise.all(
          (data as unknown as Row[]).map(async (r) => {
            const { count } = await supabase
              .from('messages')
              .select('id', { count: 'exact', head: true })
              .eq('workspace_id', r.workspace_id)
              .neq('user_id', me)
              .gt('created_at', r.last_read_at)
            return { ...r, unread: count ?? 0 }
          }),
        )
        setRows(withUnread.sort((a, b) => (a.workspaces?.name ?? '').localeCompare(b.workspaces?.name ?? '')))
      })
    supabase
      .from('profiles')
      .select('display_name')
      .eq('id', me)
      .single()
      .then(({ data }) => data && setDisplayName(data.display_name))
  }, [me])

  const go = (id: string) => (location.hash = `#/w/${id}`)

  const create = async (e: FormEvent) => {
    e.preventDefault()
    const { data, error } = await supabase.rpc('create_workspace', { p_name: newName })
    if (error) setError(error.message)
    else go(data as string)
  }

  const join = async (e: FormEvent) => {
    e.preventDefault()
    const { data, error } = await supabase.rpc('join_workspace', { p_code: code })
    if (error) setError(error.message.includes('invalid invite code') ? 'That invite code is not valid.' : error.message)
    else go(data as string)
  }

  const saveName = async (e: FormEvent) => {
    e.preventDefault()
    const { error } = await supabase.from('profiles').update({ display_name: displayName.trim() }).eq('id', me)
    if (error) setError(error.message)
    else setSaved(true)
  }

  return (
    <div className="page">
      <header className="topbar">
        <a href="#/" className="brand">
          <Logo />
          <span>Track</span>
        </a>
        <span className="topbar-actions">
          {install && (
            <button className="btn primary" onClick={install}>
              <Icon name="download" /> Install app
            </button>
          )}
          <ThemeToggle />
          <button className="btn ghost" onClick={onSignOut} title={`Signed in as ${email}`}>
            <Icon name="logout" /> <span className="hide-sm">Sign out</span>
          </button>
        </span>
      </header>

      <main className="home">
        {error && <p role="alert" className="notice" onClick={() => setError('')}>{error}</p>}

        <section className="stack">
          <h1>Your workspaces</h1>
          {rows === null ? (
            <p className="muted">Loading...</p>
          ) : rows.length === 0 ? (
            <div className="empty">
              <p><strong>No workspaces yet.</strong></p>
              <p className="muted">Create one below, or join with an invite code from a teammate.</p>
            </div>
          ) : (
            <ul className="plain ws-grid">
              {rows.map((r) => (
                <li key={r.workspace_id}>
                  <a className="ws-tile" href={`#/w/${r.workspace_id}`}>
                    <Avatar name={r.workspaces?.name ?? '?'} id={r.workspace_id} size={40} />
                    <span className="ws-tile-text">
                      <strong>{r.workspaces?.name}</strong>
                      <span className="muted small">{r.role === 'owner' ? 'Owner' : 'Member'}</span>
                    </span>
                    {r.unread > 0 && <span className="badge" aria-label={`${r.unread} unread`}>{r.unread}</span>}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="two-col">
          <form onSubmit={create} className="panel stack">
            <h2>Create a workspace</h2>
            <p className="muted small">You become its owner and can invite others.</p>
            <div className="input-row">
              <input aria-label="Workspace name" placeholder="e.g. Marketing team" required maxLength={100} value={newName} onChange={(e) => setNewName(e.target.value)} />
              <button className="btn primary"><Icon name="plus" /> Create</button>
            </div>
          </form>

          <form onSubmit={join} className="panel stack">
            <h2>Join a workspace</h2>
            <p className="muted small">Paste the 12-character code from an invite link.</p>
            <div className="input-row">
              <input aria-label="Invite code" placeholder="Invite code" required pattern="[0-9a-fA-F]{12}" value={code} onChange={(e) => setCode(e.target.value)} />
              <button className="btn primary">Join</button>
            </div>
          </form>
        </div>

        <form onSubmit={saveName} className="panel stack">
          <h2>Your profile</h2>
          <p className="muted small">{email}</p>
          <label className="field">
            <span>Display name</span>
            <div className="input-row">
              <input required maxLength={50} value={displayName} onChange={(e) => { setDisplayName(e.target.value); setSaved(false) }} />
              <button className="btn">Save</button>
            </div>
          </label>
          {saved && <span className="muted small" role="status">Saved</span>}
        </form>
      </main>
    </div>
  )
}
