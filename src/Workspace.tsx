import { useCallback, useEffect, useState } from 'react'
import { appUrl, LIMITS, supabase, type Member, type Workspace } from './supabase'
import { Modal } from './Modal'
import { Chat } from './Chat'
import { Board } from './Board'
import { useInstall } from './install'
import { enableNotifications } from './push'
import { removeAllUnused, removeFolder } from './Images'
import { Avatar, Icon, Logo } from './Icon'

type Usage = { db_bytes: number; file_bytes: number }
const percent = (u: Usage) => ({
  db: Math.round((u.db_bytes / LIMITS.dbBytes) * 100),
  files: Math.round((u.file_bytes / LIMITS.fileBytes) * 100),
})
const mb = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`

export function WorkspaceView({ workspaceId, me }: { workspaceId: string; me: string }) {
  const [ws, setWs] = useState<Workspace | null | undefined>(undefined)
  const [members, setMembers] = useState<Member[]>([])
  const [usage, setUsage] = useState<Usage | null>(null)
  const [tab, setTab] = useState<'chat' | 'board'>('chat')
  const [settings, setSettings] = useState(false)
  const [notify, setNotify] = useState(typeof Notification === 'undefined' ? 'denied' : Notification.permission)
  const install = useInstall()

  const load = useCallback(async () => {
    const [w, m, u] = await Promise.all([
      supabase.from('workspaces').select('id, name, invite_code, created_at').eq('id', workspaceId).maybeSingle(),
      supabase.from('workspace_members').select('user_id, role, last_read_at, profiles(display_name)').eq('workspace_id', workspaceId),
      supabase.rpc('storage_usage'),
    ])
    setWs(w.data as Workspace | null)
    setMembers((m.data ?? []) as unknown as Member[])
    setUsage(u.data as Usage | null)
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
  const full = usage && Math.max(percent(usage).db, percent(usage).files) >= 90

  return (
    <div className="workspace">
      <header className="topbar">
        <span className="topbar-title">
          <a href="#/" className="brand compact" title="All workspaces">
            <Logo />
            <span className="visually-hidden">All workspaces</span>
          </a>
          <span className="divider" aria-hidden="true" />
          <Avatar name={ws.name} id={ws.id} size={28} />
          <h1>{ws.name}</h1>
        </span>
        <span className="topbar-actions">
          {install && (
            <button className="btn primary" onClick={install}>
              <Icon name="download" /> <span className="hide-sm">Install app</span>
            </button>
          )}
          {notify === 'default' && (
            <button className="btn" onClick={() => enableNotifications().then(setNotify)} title="Enable notifications">
              <Icon name="bell" /> <span className="hide-sm">Notifications</span>
            </button>
          )}
          <button className="btn ghost icon-btn" onClick={() => setSettings(true)} title="Workspace settings">
            <Icon name="settings" />
            <span className="visually-hidden">Workspace settings</span>
          </button>
        </span>
      </header>
      {full && (
        <p className="banner" role="status">
          Storage is over 90% full.{' '}
          {isOwner ? (
            <button className="link" onClick={() => setSettings(true)}>Free up space in Settings</button>
          ) : (
            'The workspace owner can free up space in Settings.'
          )}
        </p>
      )}
      <nav className="tabs" aria-label="View">
        <button aria-pressed={tab === 'chat'} onClick={() => setTab('chat')}><Icon name="chat" /> Chat</button>
        <button aria-pressed={tab === 'board'} onClick={() => setTab('board')}><Icon name="board" /> Board</button>
      </nav>
      <div className={`panes show-${tab}`}>
        <Chat ws={ws} me={me} names={names} />
        <Board ws={ws} members={members} />
      </div>
      {settings && (
        <Settings ws={ws} me={me} isOwner={isOwner} members={members} usage={usage} onClose={() => setSettings(false)} onChange={load} />
      )}
    </div>
  )
}

function Settings({ ws, me, isOwner, members, usage, onClose, onChange }: {
  ws: Workspace
  me: string
  isOwner: boolean
  members: Member[]
  usage: Usage | null
  onClose: () => void
  onChange: () => Promise<void>
}) {
  const [name, setName] = useState(ws.name)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [copied, setCopied] = useState(false)
  const [days, setDays] = useState(180)
  const [busy, setBusy] = useState(false)
  const link = `${appUrl}#/join/${ws.invite_code}`

  const run = async (op: PromiseLike<{ error: { message: string } | null }>, after?: () => void) => {
    const { error } = await op
    if (error) return setError(error.message)
    after ? after() : void onChange()
  }
  const leaveTo = () => (location.hash = '#/')

  const newCode = async () => {
    if (!confirm('Make a new invite code? The current link and code will stop working.')) return
    await run(supabase.rpc('regenerate_invite_code', { ws: ws.id }))
    setCopied(false)
  }

  const deleteHistory = async () => {
    if (!confirm(`Delete all messages and images older than ${days} days in "${ws.name}"? This cannot be undone.`)) return
    setBusy(true)
    setStatus('')
    const before = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    const { data, error } = await supabase.rpc('delete_history_before', { ws: ws.id, before })
    if (error) setError(error.message)
    else {
      const files = await removeAllUnused(ws.id).catch(() => 0)
      setStatus(`Deleted ${data} messages and ${files} image files.`)
      await onChange()
    }
    setBusy(false)
  }

  const cleanUnused = async () => {
    setBusy(true)
    setStatus('')
    try {
      setStatus(`Deleted ${await removeAllUnused(ws.id)} unused image files.`)
      await onChange()
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }

  return (
    <Modal title="Workspace settings" onClose={onClose}>
      <div className="stack">
        {error && <p role="alert" className="notice" onClick={() => setError('')}>{error}</p>}

        <section className="stack">
          <h3>Invite people</h3>
          <p className="muted small">Anyone with this link can join.</p>
          <div className="input-row">
            <input readOnly aria-label="Invite link" value={link} onFocus={(e) => e.target.select()} />
            <button className="btn primary" onClick={() => navigator.clipboard.writeText(link).then(() => setCopied(true))}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="muted small row spread">
            <span>Code: <code>{ws.invite_code}</code></span>
            {isOwner && <button className="link" onClick={newCode}>Make a new code</button>}
          </p>
        </section>

        <section className="stack">
          <h3>Members ({members.length})</h3>
          <ul className="plain member-list">
            {members.map((m) => (
              <li key={m.user_id}>
                <Avatar name={m.profiles?.display_name ?? '?'} id={m.user_id} />
                <span className="grow">
                  {m.profiles?.display_name ?? 'Unknown'}
                  {m.user_id === me && <span className="muted"> (you)</span>}
                </span>
                {m.role === 'owner' && <span className="pill">Owner</span>}
                {isOwner && m.role === 'member' && (
                  <button className="btn ghost small" onClick={() => confirm('Remove this member?') && run(supabase.from('workspace_members').delete().eq('workspace_id', ws.id).eq('user_id', m.user_id))}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>

        {isOwner && (
          <section className="stack">
            <h3>Rename</h3>
            <form className="input-row" onSubmit={(e) => { e.preventDefault(); void run(supabase.from('workspaces').update({ name: name.trim() }).eq('id', ws.id)) }}>
              <input aria-label="Workspace name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
              <button className="btn">Save</button>
            </form>
          </section>
        )}

        {usage && (
          <section className="stack">
            <h3>Storage</h3>
            <p className="muted small">Shared by all workspaces on this server. Chat history is kept until you delete it.</p>
            <Meter label="Database" used={usage.db_bytes} limit={LIMITS.dbBytes} />
            <Meter label="Images" used={usage.file_bytes} limit={LIMITS.fileBytes} />
            {isOwner && (
              <>
                <div className="input-row">
                  <label className="grow">
                    <span className="visually-hidden">Age</span>
                    <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                      {[30, 90, 180, 365].map((d) => (
                        <option key={d} value={d}>Older than {d} days</option>
                      ))}
                    </select>
                  </label>
                  <button className="btn danger" disabled={busy} onClick={deleteHistory}>Delete messages and images</button>
                </div>
                <button className="btn ghost" disabled={busy} onClick={cleanUnused}>Remove unused image files</button>
              </>
            )}
            {status && <p className="muted small" role="status">{status}</p>}
          </section>
        )}

        <section className="stack danger-zone">
          {isOwner ? (
            <button className="btn danger" onClick={async () => {
              if (!confirm(`Delete "${ws.name}" with all messages, cards and images? This cannot be undone.`)) return
              await removeFolder(ws.id).catch(() => {})
              await run(supabase.from('workspaces').delete().eq('id', ws.id), leaveTo)
            }}>
              <Icon name="trash" /> Delete workspace
            </button>
          ) : (
            <button className="btn danger" onClick={() => confirm('Leave this workspace?') && run(supabase.from('workspace_members').delete().eq('workspace_id', ws.id).eq('user_id', me), leaveTo)}>
              <Icon name="logout" /> Leave workspace
            </button>
          )}
        </section>
      </div>
    </Modal>
  )
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = Math.min(100, Math.round((used / limit) * 100))
  return (
    <div className="meter">
      <div className="row spread small">
        <span>{label}</span>
        <span className="muted">{mb(used)} of {mb(limit)} ({pct}%)</span>
      </div>
      <progress max={100} value={pct} className={pct >= 90 ? 'full' : ''} aria-label={`${label} ${pct}% used`} />
    </div>
  )
}
