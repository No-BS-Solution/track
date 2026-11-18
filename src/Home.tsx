import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from './supabase'
import { useInstall } from './install'

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
    <main className="home stack">
      <header className="row spread">
        <h1>Track</h1>
        <span className="row">
          <span className="muted">{email}</span>
          {install && <button className="primary" onClick={install}>Install app</button>}
          <button onClick={onSignOut}>Sign out</button>
        </span>
      </header>
      {error && <p role="alert" className="notice">{error}</p>}

      <section className="stack">
        <h2>Your workspaces</h2>
        {rows === null ? (
          <p className="muted">Loading...</p>
        ) : rows.length === 0 ? (
          <p className="muted">No workspaces yet. Create one or join with an invite code.</p>
        ) : (
          <ul className="plain stack">
            {rows.map((r) => (
              <li key={r.workspace_id}>
                <a className="ws-link" href={`#/w/${r.workspace_id}`}>
                  {r.workspaces?.name}
                  {r.unread > 0 && <span className="badge" aria-label={`${r.unread} unread`}>{r.unread}</span>}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form onSubmit={join} className="stack">
        <h2>Join a workspace</h2>
        <div className="row">
          <input aria-label="Invite code" placeholder="Invite code" required pattern="[0-9a-fA-F]{12}" value={code} onChange={(e) => setCode(e.target.value)} />
          <button className="primary">Join</button>
        </div>
      </form>

      <form onSubmit={create} className="stack">
        <h2>Create a workspace</h2>
        <div className="row">
          <input aria-label="Workspace name" placeholder="Workspace name" required maxLength={100} value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button className="primary">Create</button>
        </div>
      </form>

      <form onSubmit={saveName} className="stack">
        <h2>Your display name</h2>
        <div className="row">
          <input aria-label="Display name" required maxLength={50} value={displayName} onChange={(e) => { setDisplayName(e.target.value); setSaved(false) }} />
          <button>Save</button>
          {saved && <span className="muted" role="status">Saved</span>}
        </div>
      </form>
    </main>
  )
}
