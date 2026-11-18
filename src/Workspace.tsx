import { useCallback, useEffect, useState } from 'react'
import { appUrl, supabase, type Member, type Workspace } from './supabase'
import { Modal } from './Modal'
import { Chat } from './Chat'
import { Board } from './Board'
import { useInstall } from './install'

export function WorkspaceView({ workspaceId, me }: { workspaceId: string; me: string }) {
  const [ws, setWs] = useState<Workspace | null | undefined>(undefined)
  const [members, setMembers] = useState<Member[]>([])
  const [tab, setTab] = useState<'chat' | 'board'>('chat')
  const [settings, setSettings] = useState(false)
  const [notify, setNotify] = useState(typeof Notification === 'undefined' ? 'denied' : Notification.permission)
  const install = useInstall()

  const load = useCallback(async () => {
    const [w, m] = await Promise.all([
      supabase.from('workspaces').select('id, name, invite_code, created_at').eq('id', workspaceId).maybeSingle(),
      supabase.from('workspace_members').select('user_id, role, last_read_at, profiles(display_name)').eq('workspace_id', workspaceId),
    ])
    setWs(w.data as Workspace | null)
    setMembers((m.data ?? []) as unknown as Member[])
  }, [workspaceId])

  useEffect(() => void load(), [load])

  if (ws === undefined) return <p className="center muted">Loading...</p>
  if (ws === null)
    return (
      <main className="center stack">
        <p>This workspace does not exist or you are no longer a member.</p>
        <a href="#/">Back to workspaces</a>
      </main>
    )

  const names = new Map(members.map((m) => [m.user_id, m.profiles?.display_name ?? 'Unknown']))
  const isOwner = members.some((m) => m.user_id === me && m.role === 'owner')

  return (
    <div className="workspace">
      <header className="topbar row spread">
        <span className="row">
          <a href="#/" aria-label="All workspaces">Track</a>
          <h1>{ws.name}</h1>
        </span>
        <span className="row">
          {install && <button onClick={install}>Install app</button>}
          {notify === 'default' && (
            <button onClick={() => Notification.requestPermission().then(setNotify)}>Enable notifications</button>
          )}
          <button onClick={() => setSettings(true)}>Settings</button>
        </span>
      </header>
      <nav className="tabs row" aria-label="View">
        <button aria-pressed={tab === 'chat'} onClick={() => setTab('chat')}>Chat</button>
        <button aria-pressed={tab === 'board'} onClick={() => setTab('board')}>Board</button>
      </nav>
      <div className={`panes show-${tab}`}>
        <Chat ws={ws} me={me} names={names} />
        <Board ws={ws} members={members} />
      </div>
      {settings && <Settings ws={ws} me={me} isOwner={isOwner} members={members} onClose={() => setSettings(false)} onChange={load} />}
    </div>
  )
}

function Settings({ ws, me, isOwner, members, onClose, onChange }: {
  ws: Workspace
  me: string
  isOwner: boolean
  members: Member[]
  onClose: () => void
  onChange: () => void
}) {
  const [name, setName] = useState(ws.name)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const link = `${appUrl}#/join/${ws.invite_code}`

  const run = async (op: PromiseLike<{ error: { message: string } | null }>, after?: () => void) => {
    const { error } = await op
    if (error) return setError(error.message)
    after ? after() : onChange()
  }
  const leaveTo = () => (location.hash = '#/')

  return (
    <Modal title="Workspace settings" onClose={onClose}>
      <div className="stack">
        {error && <p role="alert" className="notice">{error}</p>}
        <label>
          Invite link (anyone with it can join)
          <span className="row">
            <input readOnly value={link} onFocus={(e) => e.target.select()} />
            <button onClick={() => navigator.clipboard.writeText(link).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy'}</button>
          </span>
        </label>
        <p className="muted">Invite code: {ws.invite_code}</p>

        <h3>Members</h3>
        <ul className="plain stack">
          {members.map((m) => (
            <li key={m.user_id} className="row spread">
              <span>
                {m.profiles?.display_name ?? 'Unknown'}
                {m.role === 'owner' && <span className="muted"> (owner)</span>}
                {m.user_id === me && <span className="muted"> (you)</span>}
              </span>
              {isOwner && m.role === 'member' && (
                <button onClick={() => confirm('Remove this member?') && run(supabase.from('workspace_members').delete().eq('workspace_id', ws.id).eq('user_id', m.user_id))}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>

        {isOwner ? (
          <>
            <h3>Rename</h3>
            <form className="row" onSubmit={(e) => { e.preventDefault(); void run(supabase.from('workspaces').update({ name: name.trim() }).eq('id', ws.id)) }}>
              <input aria-label="Workspace name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
              <button>Save</button>
            </form>
            <button className="danger" onClick={() => confirm(`Delete "${ws.name}" with all messages and cards? This cannot be undone.`) && run(supabase.from('workspaces').delete().eq('id', ws.id), leaveTo)}>
              Delete workspace
            </button>
          </>
        ) : (
          <button className="danger" onClick={() => confirm('Leave this workspace?') && run(supabase.from('workspace_members').delete().eq('workspace_id', ws.id).eq('user_id', me), leaveTo)}>
            Leave workspace
          </button>
        )}
      </div>
    </Modal>
  )
}
