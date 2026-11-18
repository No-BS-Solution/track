import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { generateKeyBetween } from 'fractional-indexing'
import { supabase, upsert, type Card, type List, type Message, type Workspace } from './supabase'
import { byPosition } from './Board'
import { ImagePicker, StoredImage, uploadImage } from './Images'

export function Chat({ ws, me, names }: { ws: Workspace; me: string; names: Map<string, string> }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
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
        if (msg.user_id !== me && document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          const title = `${namesRef.current.get(msg.user_id) ?? 'Someone'} in ${ws.name}`
          const options = { body: msg.body.slice(0, 200) || 'Sent an image', tag: ws.id }
          // Android Chrome only allows notifications through the service worker; `new Notification` throws there.
          void navigator.serviceWorker
            ?.getRegistration()
            .then((r) => {
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
    // shortcut: only the latest 200 messages are loaded, add "load older" if history matters.
    supabase
      .from('messages')
      .select('*')
      .eq('workspace_id', ws.id)
      .order('created_at', { ascending: false })
      .limit(200)
      .then(({ data, error }) => {
        if (error) return setError(error.message)
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
      void send()
    }
  }

  const saveEdit = async () => {
    if (!editing) return
    const { error } = await supabase.from('messages').update({ body: editing.body.trim() }).eq('id', editing.id)
    if (error) return setError(error.message)
    setEditing(null)
  }

  const remove = async (id: string) => {
    if (!confirm('Delete this message?')) return
    const { error } = await supabase.from('messages').delete().eq('id', id)
    if (error) setError(error.message)
    else setMessages((prev) => prev.filter((m) => m.id !== id))
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

  return (
    <section className="chat" aria-label="Chat">
      <div
        className="messages"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {messages.length === 0 && <p className="muted center">No messages yet. Say hi.</p>}
        {messages.map((m) => (
          <article key={m.id} className="message">
            <header className="row">
              <strong>{names.get(m.user_id) ?? 'Former member'}</strong>
              <time className="muted" dateTime={m.created_at}>
                {new Date(m.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
              </time>
              {m.edited_at && <span className="muted">(edited)</span>}
              <span className="actions">
                <button className="link" onClick={() => makeCard(m)}>Make card</button>
                {m.user_id === me && (
                  <>
                    <button className="link" onClick={() => setEditing({ id: m.id, body: m.body })}>Edit</button>
                    <button className="link" onClick={() => remove(m.id)}>Delete</button>
                  </>
                )}
              </span>
            </header>
            {editing?.id === m.id ? (
              <div className="stack">
                <textarea aria-label="Edit message" maxLength={4000} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
                <span className="row">
                  <button className="primary" onClick={saveEdit} disabled={!editing.body.trim() && !m.image_path}>Save</button>
                  <button onClick={() => setEditing(null)}>Cancel</button>
                </span>
              </div>
            ) : (
              m.body && <p className="body">{m.body}</p>
            )}
            {m.image_path && <StoredImage path={m.image_path} alt={`Image from ${names.get(m.user_id) ?? 'a former member'}`} />}
          </article>
        ))}
      </div>
      {error && <p role="status" className="notice" onClick={() => setError('')}>{error}</p>}
      <form className="composer row" onSubmit={send}>
        <textarea
          aria-label="Message"
          placeholder="Message (Enter to send, Shift+Enter for a new line)"
          rows={2}
          maxLength={4000}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
        />
        <ImagePicker label={uploading ? 'Uploading...' : 'Image'} disabled={uploading} onPick={sendImage} />
        <button className="primary" disabled={!draft.trim()}>Send</button>
      </form>
    </section>
  )
}
