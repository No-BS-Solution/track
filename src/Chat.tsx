import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { generateKeyBetween } from 'fractional-indexing'
import { formatTime, supabase, upsert, type Card, type List, type Message, type Workspace } from './supabase'
import { byPosition } from './Board'
import { ImagePicker, StoredImage, removeIfUnused, uploadImage } from './Images'
import { pushAvailable } from './push'
import { Avatar, Icon } from './Icon'

const PAGE = 100

export function Chat({ ws, me, names }: { ws: Workspace; me: string; names: Map<string, string> }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Message[] | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const namesRef = useRef(names)
  namesRef.current = names

  useEffect(() => {
    const channel = supabase
      .channel(`messages:${ws.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `workspace_id=eq.${ws.id}` }, ({ new: m }) => {
        const msg = m as Message
        setMessages((prev) => upsert(prev, msg))
        // With push set up the service worker notifies; this covers deployments without it.
        if (!pushAvailable && msg.user_id !== me && document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          const title = `${namesRef.current.get(msg.user_id) ?? 'Someone'} in ${ws.name}`
          const options = { body: msg.body.slice(0, 200) || 'Sent an image', tag: ws.id }
          // Android Chrome only allows notifications through the service worker; `new Notification` throws there.
          void navigator.serviceWorker?.getRegistration().then((r) => {
            if (r) return r.showNotification(title, options)
            new Notification(title, options)
          })
        }
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `workspace_id=eq.${ws.id}` }, ({ new: m }) =>
        setMessages((prev) => upsert(prev, m as Message)),
      )
      // DELETE events can't be filtered and only carry the id; ids from other workspaces simply don't match.
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, ({ old }) =>
        setMessages((prev) => prev.filter((x) => x.id !== old.id)),
      )
      .subscribe()
    supabase
      .from('messages')
      .select('*')
      .eq('workspace_id', ws.id)
      .order('created_at', { ascending: false })
      .limit(PAGE)
      .then(({ data, error }) => {
        if (error) return setError(error.message)
        setHasMore(data.length === PAGE)
        setMessages((prev) => (data as Message[]).reduce(upsert, prev).sort((a, b) => a.created_at.localeCompare(b.created_at)))
      })
    return () => void supabase.removeChannel(channel)
  }, [ws.id, ws.name, me])

  // Mark read while the chat is visible.
  useEffect(() => {
    const markRead = () => {
      if (!document.hidden)
        void supabase.from('workspace_members').update({ last_read_at: new Date().toISOString() }).eq('workspace_id', ws.id).eq('user_id', me)
    }
    markRead()
    document.addEventListener('visibilitychange', markRead)
    return () => document.removeEventListener('visibilitychange', markRead)
  }, [ws.id, me, messages.length])

  useEffect(() => {
    if (atBottom.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [messages])

  const loadOlder = async () => {
    const el = scroller.current
    const prevHeight = el?.scrollHeight ?? 0
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('workspace_id', ws.id)
      .lt('created_at', messages[0].created_at)
      .order('created_at', { ascending: false })
      .limit(PAGE)
    if (error) return setError(error.message)
    setHasMore(data.length === PAGE)
    setMessages((prev) => [...(data as Message[]).reverse(), ...prev])
    // Keep the view on the message the user was reading.
    requestAnimationFrame(() => el && (el.scrollTop = el.scrollHeight - prevHeight))
  }

  const search = async (e: FormEvent) => {
    e.preventDefault()
    const q = query.trim()
    if (!q) return setResults(null)
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('workspace_id', ws.id)
      .ilike('body', `%${q.replace(/[\\%_]/g, '\\$&')}%`)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) return setError(error.message)
    setResults(data as Message[])
  }

  const post = async (imagePath: string | null) => {
    const body = draft.trim()
    if (!body && !imagePath) return
    const { data, error } = await supabase.from('messages').insert({ workspace_id: ws.id, body, image_path: imagePath }).select().single()
    if (error) return setError(error.message)
    atBottom.current = true
    setDraft('')
    setMessages((prev) => upsert(prev, data as Message))
  }

  const send = (e?: FormEvent) => {
    e?.preventDefault()
    void post(null)
  }

  // The current draft goes along as the image caption.
  const sendImage = async (file: File) => {
    setUploading(true)
    try {
      await post(await uploadImage(ws.id, file))
    } catch (err) {
      setError((err as Error).message)
    }
    setUploading(false)
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  const saveEdit = async () => {
    if (!editing) return
    const { error } = await supabase.from('messages').update({ body: editing.body.trim() }).eq('id', editing.id)
    if (error) return setError(error.message)
    setEditing(null)
  }

  const remove = async (m: Message) => {
    if (!confirm('Delete this message?')) return
    const { error } = await supabase.from('messages').delete().eq('id', m.id)
    if (error) return setError(error.message)
    setMessages((prev) => prev.filter((x) => x.id !== m.id))
    if (m.image_path) void removeIfUnused([m.image_path])
  }

  const makeCard = async (m: Message) => {
    const { data: lists } = await supabase.from('lists').select('*').eq('workspace_id', ws.id)
    const first = (lists as List[] | null)?.sort(byPosition)[0]
    if (!first) return setError('Add a column to the board first.')
    const { data: cards } = await supabase.from('cards').select('position').eq('list_id', first.id)
    const last = (cards as Pick<Card, 'position'>[] | null)?.map((c) => c.position).sort().pop() ?? null
    const { error } = await supabase.from('cards').insert({
      list_id: first.id,
      workspace_id: ws.id,
      title: m.body.slice(0, 200) || 'Image',
      image_paths: m.image_path ? [m.image_path] : [],
      position: generateKeyBetween(last, null),
      source_message_id: m.id,
    })
    setError(error ? error.message : `Card added to "${first.title}".`)
  }

  // @mention suggestions for the word being typed at the end of the draft.
  const myName = names.get(me)
  const mention = draft.match(/(?:^|\s)@([^@\n]{0,30})$/)
  const suggestions = mention
    ? [...new Set(names.values())].filter((n) => n.toLowerCase().startsWith(mention[1].toLowerCase()) && n !== mention[1]).slice(0, 5)
    : []
  const insertMention = (name: string) => setDraft(draft.slice(0, draft.length - mention![1].length) + name + ' ')

  const renderMessage = (m: Message, prev: Message | undefined, actions: boolean) => {
    const name = names.get(m.user_id) ?? 'Former member'
    const grouped = prev?.user_id === m.user_id && Date.parse(m.created_at) - Date.parse(prev.created_at) < 5 * 60 * 1000
    const mentionsMe = !!myName && m.user_id !== me && m.body.includes(`@${myName}`)
    return (
      <article key={m.id} className={`message ${grouped ? 'grouped' : ''} ${mentionsMe ? 'mentioned' : ''}`}>
        <div className="message-gutter">{!grouped && <Avatar name={name} id={m.user_id} />}</div>
        <div className="message-main">
          {!grouped && (
            <header className="message-head">
              <strong>{name}</strong>
              <time className="muted small" dateTime={m.created_at}>{formatTime(m.created_at)}</time>
            </header>
          )}
          {editing?.id === m.id ? (
            <div className="stack">
              <textarea aria-label="Edit message" maxLength={4000} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
              <span className="row">
                <button className="btn primary small" onClick={saveEdit} disabled={!editing.body.trim() && !m.image_path}>Save</button>
                <button className="btn ghost small" onClick={() => setEditing(null)}>Cancel</button>
              </span>
            </div>
          ) : (
            m.body && (
              <p className="body">
                {m.body}
                {m.edited_at && <span className="muted small"> (edited)</span>}
              </p>
            )
          )}
          {m.image_path && <StoredImage path={m.image_path} alt={`Image from ${name}`} />}
        </div>
        {actions && editing?.id !== m.id && (
          <span className="message-actions">
            <button className="btn ghost icon-btn small" title="Make card" onClick={() => makeCard(m)}>
              <Icon name="card" /><span className="visually-hidden">Make card</span>
            </button>
            {m.user_id === me && (
              <>
                <button className="btn ghost icon-btn small" title="Edit" onClick={() => setEditing({ id: m.id, body: m.body })}>
                  <Icon name="edit" /><span className="visually-hidden">Edit</span>
                </button>
                <button className="btn ghost icon-btn small" title="Delete" onClick={() => remove(m)}>
                  <Icon name="trash" /><span className="visually-hidden">Delete</span>
                </button>
              </>
            )}
          </span>
        )}
      </article>
    )
  }

  return (
    <section className="chat" aria-label="Chat">
      <form className="chat-search" role="search" onSubmit={search}>
        <Icon name="search" />
        <input type="search" aria-label="Search messages" placeholder="Search messages" value={query}
          onChange={(e) => { setQuery(e.target.value); if (!e.target.value) setResults(null) }} />
      </form>
      {results ? (
        <div className="messages">
          <p className="row spread small muted">
            {results.length === 0 ? 'No matches.' : `${results.length}${results.length === 50 ? '+' : ''} matches`}
            <button className="link" onClick={() => { setResults(null); setQuery('') }}>Back to chat</button>
          </p>
          {results.map((m) => renderMessage(m, undefined, false))}
        </div>
      ) : (
        <div
          className="messages"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
        >
          {hasMore && (
            <button className="btn ghost small load-older" onClick={loadOlder}>Load older messages</button>
          )}
          {messages.length === 0 && (
            <div className="empty">
              <Icon name="chat" />
              <p>No messages yet. Say hi.</p>
            </div>
          )}
          {messages.map((m, i) => renderMessage(m, messages[i - 1], true))}
        </div>
      )}
      {error && <p role="status" className="notice toast" onClick={() => setError('')}>{error}</p>}
      <form className="composer" onSubmit={send}>
        {suggestions.length > 0 && (
          <div className="mentions" aria-label="Mention someone">
            {suggestions.map((n) => (
              <button type="button" key={n} onClick={() => insertMention(n)}>@{n}</button>
            ))}
          </div>
        )}
        <ImagePicker iconOnly label={uploading ? 'Uploading...' : 'Send an image'} disabled={uploading} onPick={sendImage} />
        <textarea
          aria-label="Message"
          placeholder="Message, @ to mention"
          rows={1}
          maxLength={4000}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
        />
        <button className="btn primary icon-btn" disabled={!draft.trim()} title="Send">
          <Icon name="send" /><span className="visually-hidden">Send</span>
        </button>
      </form>
    </section>
  )
}
