import { useEffect, useRef, useState, type FormEvent } from 'react'
import { draggable, dropTargetForElements, monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine'
import { announce } from '@atlaskit/pragmatic-drag-and-drop-live-region'
import { generateKeyBetween } from 'fractional-indexing'
import { formatTime, supabase, upsert, LABEL_COLORS, type Card, type ChecklistItem, type Comment, type Label, type List, type Member, type Message, type Workspace } from './supabase'
import { FILE_ACCEPT, FileChip, removeFilesIfUnused, uploadFile } from './Files'
import { MentionList, useMentions } from './mentions'
import { Modal } from './Modal'
import { ImagePicker, StoredImage, removeIfUnused, uploadImage } from './Images'
import { Avatar, Icon } from './Icon'
import { DatePicker, isoDate } from './DatePicker'

// Fractional index keys sort by plain code-unit order, not locale order. Id breaks ties from concurrent inserts.
export const byPosition = (a: { position: string; id: string }, b: { position: string; id: string }) =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1

function between(before: string | null, after: string | null): string {
  try {
    return generateKeyBetween(before, after)
  } catch {
    // shortcut: two clients wrote the same key at once; land right after `before`. Rare enough to not rebalance.
    return generateKeyBetween(before, null)
  }
}

const starterColumns = ['To do', 'In progress', 'QA', 'Release']

type Edge = 'before' | 'after' | null
const edgeOf = (el: Element, x: number, y: number, horizontal: boolean): Edge => {
  const r = el.getBoundingClientRect()
  return (horizontal ? x > r.left + r.width / 2 : y > r.top + r.height / 2) ? 'after' : 'before'
}

export function Board({ ws, me, members, openCard, onOpenCard }: {
  ws: Workspace
  me: string
  members: Member[]
  openCard: string | null
  onOpenCard: (id: string | null) => void
}) {
  const [lists, setLists] = useState<List[]>([])
  const [cards, setCards] = useState<Card[]>([])
  const [filter, setFilter] = useState<'all' | 'mine' | 'overdue'>('all')
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [labels, setLabels] = useState<Label[]>([])
  const [labelFilter, setLabelFilter] = useState('')
  const [manageLabels, setManageLabels] = useState(false)
  const [newList, setNewList] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    const [l, c, lb] = await Promise.all([
      supabase.from('lists').select('*').eq('workspace_id', ws.id),
      supabase.from('cards').select('*').eq('workspace_id', ws.id),
      supabase.from('labels').select('*').eq('workspace_id', ws.id).order('name'),
    ])
    if (l.error || c.error) return setError((l.error ?? c.error)!.message)
    setLabels((lb.data ?? []) as Label[])
    setLists(l.data as List[])
    setCards(c.data as Card[])
    setLoaded(true)
  }

  useEffect(() => {
    const filter = `workspace_id=eq.${ws.id}`
    const channel = supabase
      .channel(`board:${ws.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'lists', filter }, ({ new: r }) => setLists((p) => upsert(p, r as List)))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'lists', filter }, ({ new: r }) => setLists((p) => upsert(p, r as List)))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'lists' }, ({ old }) => {
        setLists((p) => p.filter((x) => x.id !== old.id))
        setCards((p) => p.filter((x) => x.list_id !== old.id))
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'cards', filter }, ({ new: r }) => setCards((p) => upsert(p, r as Card)))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'cards', filter }, ({ new: r }) => setCards((p) => upsert(p, r as Card)))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'cards' }, ({ old }) => setCards((p) => p.filter((x) => x.id !== old.id)))
      .subscribe()
    void load()
    return () => void supabase.removeChannel(channel)

  }, [ws.id])

  const sortedLists = [...lists].sort(byPosition)
  // Archived cards leave the columns entirely, so positions and keyboard moves only consider active cards.
  const cardsIn = (listId: string) => cards.filter((c) => c.list_id === listId && !c.archived_at).sort(byPosition)
  const today = isoDate(new Date())
  const term = search.trim().toLowerCase()
  const labelMap = new Map(labels.map((l) => [l.id, l]))
  const visible = (c: Card) =>
    (filter === 'all' || (filter === 'mine' ? c.assignee_id === me : !!c.due_date && c.due_date < today)) &&
    (!labelFilter || c.label_ids.includes(labelFilter)) &&
    (!term || c.title.toLowerCase().includes(term) || c.description.toLowerCase().includes(term))
  const archived = cards.filter((c) => c.archived_at).sort((a, b) => b.archived_at!.localeCompare(a.archived_at!))

  // reload: the change was applied optimistically, so resync on failure.
  const save = async (op: PromiseLike<{ error: { message: string } | null }>, reload = false) => {
    const { error } = await op
    if (error) {
      setError(error.message)
      if (reload) void load()
    }
  }

  const moveCard = (id: string, listId: string, toIndex: number) => {
    const others = cardsIn(listId).filter((c) => c.id !== id)
    const index = Math.min(toIndex, others.length)
    const position = between(others[index - 1]?.position ?? null, others[index]?.position ?? null)
    setCards((p) => p.map((c) => (c.id === id ? { ...c, list_id: listId, position } : c)))
    void save(supabase.from('cards').update({ list_id: listId, position }).eq('id', id), true)
    const list = lists.find((l) => l.id === listId)
    announce(`Card moved to ${list?.title}, position ${index + 1} of ${others.length + 1}`)
  }

  const moveList = (id: string, index: number) => {
    const others = sortedLists.filter((l) => l.id !== id)
    const position = between(others[index - 1]?.position ?? null, others[index]?.position ?? null)
    setLists((p) => p.map((l) => (l.id === id ? { ...l, position } : l)))
    void save(supabase.from('lists').update({ position }).eq('id', id), true)
    announce(`Column moved to position ${index + 1} of ${others.length + 1}`)
  }

  // Latest state for the drop handler, which is registered once.
  const latest = useRef({ moveCard, moveList, cardsIn, sortedLists })
  latest.current = { moveCard, moveList, cardsIn, sortedLists }

  useEffect(
    () =>
      monitorForElements({
        onDrop({ source, location }) {
          const { moveCard, moveList, cardsIn, sortedLists } = latest.current
          const { dropTargets, input } = location.current
          const sourceId = source.data.id as string
          const listTarget = dropTargets.find((t) => t.data.type === 'list')
          if (!listTarget) return
          if (source.data.type === 'card') {
            const listId = listTarget.data.id as string
            const others = cardsIn(listId).filter((c) => c.id !== sourceId)
            const cardTarget = dropTargets.find((t) => t.data.type === 'card')
            if (cardTarget?.data.id === sourceId) return
            const index = cardTarget
              ? others.findIndex((c) => c.id === cardTarget.data.id) +
                (edgeOf(cardTarget.element, input.clientX, input.clientY, false) === 'after' ? 1 : 0)
              : others.length
            moveCard(sourceId, listId, index)
          } else if (listTarget.data.id !== sourceId) {
            const others = sortedLists.filter((l) => l.id !== sourceId)
            const index =
              others.findIndex((l) => l.id === listTarget.data.id) +
              (edgeOf(listTarget.element, input.clientX, input.clientY, true) === 'after' ? 1 : 0)
            moveList(sourceId, index)
          }
        },
      }),
    [],
  )

  const addColumns = async (titles: string[]) => {
    let position = sortedLists.at(-1)?.position ?? null
    const rows = titles.map((title) => ({ workspace_id: ws.id, title, position: (position = between(position, null)) }))
    const { data, error } = await supabase.from('lists').insert(rows).select()
    if (error) return setError(error.message)
    setLists((p) => (data as List[]).reduce(upsert, p))
  }

  const addList = async (e: FormEvent) => {
    e.preventDefault()
    await addColumns([newList.trim()])
    setNewList('')
  }

  const addCard = async (listId: string, title: string) => {
    const position = between(cardsIn(listId).at(-1)?.position ?? null, null)
    const { data, error } = await supabase.from('cards').insert({ list_id: listId, workspace_id: ws.id, title, position, due_date: isoDate(new Date()) }).select().single()
    if (error) return setError(error.message)
    setCards((p) => upsert(p, data as Card))
  }

  const deleteColumn = (list: List) => {
    if (!confirm(`Delete column "${list.title}" and all its cards?`)) return
    const images = cards.filter((c) => c.list_id === list.id).flatMap((c) => c.image_paths)
    setLists((p) => p.filter((l) => l.id !== list.id))
    void save(supabase.from('lists').delete().eq('id', list.id), true).then(() => removeIfUnused(images))
  }

  const names = new Map(members.map((m) => [m.user_id, m.profiles?.display_name ?? 'Unknown']))
  const card = cards.find((c) => c.id === openCard)

  return (
    <section className="board" aria-label="Board">
      {error && <p role="alert" className="notice toast" onClick={() => setError('')}>{error}</p>}
      {loaded && sortedLists.length === 0 ? (
        <div className="empty board-empty">
          <Icon name="board" />
          <h2>Set up your board</h2>
          <p className="muted">Columns are the stages your work moves through.</p>
          <button className="btn primary" onClick={() => addColumns(starterColumns)}>
            Start with {starterColumns.join(', ')}
          </button>
          <form className="input-row" onSubmit={addList}>
            <input aria-label="New column name" placeholder="Or name your own column" required maxLength={100} value={newList} onChange={(e) => setNewList(e.target.value)} />
            <button className="btn">Add column</button>
          </form>
        </div>
      ) : (
        <>
        <div className="board-toolbar">
          <div className="segmented" role="group" aria-label="Filter cards">
            {(['all', 'mine', 'overdue'] as const).map((f) => (
              <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All' : f === 'mine' ? 'My cards' : 'Overdue'}
              </button>
            ))}
          </div>
          <label className="board-search">
            <Icon name="search" />
            <input type="search" aria-label="Search cards" placeholder="Search cards" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          {labels.length > 0 && (
            <select className="label-filter" aria-label="Filter by label" value={labelFilter} onChange={(e) => setLabelFilter(e.target.value)}>
              <option value="">All labels</option>
              {labels.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          )}
          <button className="btn ghost small" onClick={() => setManageLabels(true)}>
            <Icon name="tag" /> Labels
          </button>
          <button className="btn ghost small" aria-pressed={showArchived} onClick={() => setShowArchived(!showArchived)}>
            <Icon name="archive" /> Archived ({archived.length})
          </button>
        </div>
        {showArchived && (
          <div className="archived panel">
            {archived.length === 0 ? (
              <p className="muted small">No archived cards.</p>
            ) : (
              <ul className="plain archived-list">
                {archived.map((c) => (
                  <li key={c.id}>
                    <button className="link" onClick={() => onOpenCard(c.id)}>{c.title}</button>
                    <span className="muted small">{lists.find((l) => l.id === c.list_id)?.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="lists">
          {sortedLists.map((list, i) => (
            <ListColumn
              key={list.id}
              list={list}
              cards={cardsIn(list.id).filter(visible)}
              names={names}
              labels={labelMap}
              canLeft={i > 0}
              canRight={i < sortedLists.length - 1}
              onMove={(dir) => moveList(list.id, i + dir)}
              onRename={(title) => save(supabase.from('lists').update({ title }).eq('id', list.id))}
              onDelete={() => deleteColumn(list)}
              onAddCard={(title) => addCard(list.id, title)}
              onOpenCard={onOpenCard}
            />
          ))}
          <form className="add-list" onSubmit={addList}>
            <input aria-label="New column name" placeholder="New column, e.g. QA" required maxLength={100} value={newList} onChange={(e) => setNewList(e.target.value)} />
            <button className="btn primary"><Icon name="plus" /> Add column</button>
          </form>
        </div>
        </>
      )}
      {manageLabels && <LabelManager workspaceId={ws.id} labels={labels} setLabels={setLabels} onClose={() => setManageLabels(false)} />}
      {card && (
        <CardEditor
          key={card.id}
          card={card}
          lists={sortedLists}
          index={cardsIn(card.list_id).findIndex((c) => c.id === card.id)}
          count={cardsIn(card.list_id).length}
          members={members}
          names={names}
          labels={labels}
          onMove={moveCard}
          me={me}
          onClose={() => onOpenCard(null)}
          onSaved={(c) => setCards((p) => upsert(p, c))}
          onDeleted={() => {
            setCards((p) => p.filter((c) => c.id !== card.id))
            onOpenCard(null)
            void removeIfUnused(card.image_paths)
          }}
        />
      )}
    </section>
  )
}

function ListColumn({ list, cards, names, labels, canLeft, canRight, onMove, onRename, onDelete, onAddCard, onOpenCard }: {
  list: List
  cards: Card[]
  names: Map<string, string>
  labels: Map<string, Label>
  canLeft: boolean
  canRight: boolean
  onMove: (dir: -1 | 1) => void
  onRename: (title: string) => void
  onDelete: () => void
  onAddCard: (title: string) => void
  onOpenCard: (id: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const handle = useRef<HTMLSpanElement>(null)
  const titleInput = useRef<HTMLInputElement>(null)
  const [edge, setEdge] = useState<Edge>(null)
  const [cardOver, setCardOver] = useState(false)
  const [title, setTitle] = useState(list.title)
  const [newCard, setNewCard] = useState('')

  useEffect(() => setTitle(list.title), [list.title])

  useEffect(
    () =>
      combine(
        draggable({ element: ref.current!, dragHandle: handle.current!, getInitialData: () => ({ type: 'list', id: list.id }) }),
        dropTargetForElements({
          element: ref.current!,
          getData: () => ({ type: 'list', id: list.id }),
          onDrag: ({ source, location, self }) => {
            if (source.data.type === 'list') {
              setEdge(source.data.id === list.id ? null : edgeOf(self.element, location.current.input.clientX, 0, true))
            } else setCardOver(location.current.dropTargets[0]?.element === self.element)
          },
          onDragLeave: () => { setEdge(null); setCardOver(false) },
          onDrop: () => { setEdge(null); setCardOver(false) },
        }),
      ),
    [list.id],
  )

  const rename = () => {
    const t = title.trim()
    if (t && t !== list.title) onRename(t)
    else setTitle(list.title)
  }

  const add = (e: FormEvent) => {
    e.preventDefault()
    onAddCard(newCard.trim())
    setNewCard('')
  }

  return (
    <div ref={ref} className={`list ${edge ? `drop-${edge}` : ''} ${cardOver ? 'card-over' : ''}`}>
      <div className="list-head">
        <span ref={handle} className="grip" title="Drag to reorder"><Icon name="grip" /></span>
        <input ref={titleInput} className="list-title" aria-label="Column name" maxLength={100} value={title}
          onChange={(e) => setTitle(e.target.value)} onBlur={rename}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
        <span className="count">{cards.length}</span>
      </div>
      <div className="list-tools">
        <button className="btn ghost icon-btn small" title="Move left" disabled={!canLeft} onClick={() => onMove(-1)}>
          <Icon name="left" /><span className="visually-hidden">Move column {list.title} left</span>
        </button>
        <button className="btn ghost icon-btn small" title="Move right" disabled={!canRight} onClick={() => onMove(1)}>
          <Icon name="right" /><span className="visually-hidden">Move column {list.title} right</span>
        </button>
        <button className="btn ghost icon-btn small" title="Rename" onClick={() => titleInput.current?.select()}>
          <Icon name="edit" /><span className="visually-hidden">Rename column {list.title}</span>
        </button>
        <button className="btn ghost icon-btn small" title="Delete column" onClick={onDelete}>
          <Icon name="trash" /><span className="visually-hidden">Delete column {list.title}</span>
        </button>
      </div>
      <ul className="plain cards">
        {cards.map((c) => (
          <CardItem key={c.id} card={c} assignee={c.assignee_id ? names.get(c.assignee_id) : undefined}
            labels={c.label_ids.map((id) => labels.get(id)).filter((l): l is Label => !!l)} onOpen={() => onOpenCard(c.id)} />
        ))}
      </ul>
      <form className="add-card" onSubmit={add}>
        <input aria-label={`New card in ${list.title}`} placeholder="+ Add a card" required maxLength={200} value={newCard} onChange={(e) => setNewCard(e.target.value)} />
      </form>
    </div>
  )
}

function CardItem({ card, assignee, labels, onOpen }: { card: Card; assignee?: string; labels: Label[]; onOpen: () => void }) {
  const ref = useRef<HTMLLIElement>(null)
  const [dragging, setDragging] = useState(false)
  const [edge, setEdge] = useState<Edge>(null)

  useEffect(
    () =>
      combine(
        draggable({
          element: ref.current!,
          getInitialData: () => ({ type: 'card', id: card.id }),
          onDragStart: () => setDragging(true),
          onDrop: () => setDragging(false),
        }),
        dropTargetForElements({
          element: ref.current!,
          getData: () => ({ type: 'card', id: card.id }),
          canDrop: ({ source }) => source.data.type === 'card',
          onDrag: ({ source, location, self }) =>
            setEdge(source.data.id === card.id ? null : edgeOf(self.element, 0, location.current.input.clientY, false)),
          onDragLeave: () => setEdge(null),
          onDrop: () => setEdge(null),
        }),
      ),
    [card.id],
  )

  const overdue = card.due_date && card.due_date < isoDate(new Date())
  const done = card.checklist.filter((i) => i.done).length
  return (
    <li ref={ref} className={`card ${dragging ? 'dragging' : ''} ${edge ? `drop-${edge}` : ''}`}>
      <button className="card-btn" onClick={onOpen}>
        {card.image_paths[0] && <StoredImage path={card.image_paths[0]} alt="" link={false} />}
        {labels.length > 0 && (
          <span className="card-labels">
            {labels.map((l) => (
              <span key={l.id} className={`label label-${l.color}`}>{l.name}</span>
            ))}
          </span>
        )}
        <span className="card-title">{card.title}</span>
        <span className="card-meta">
          {card.due_date && <span className={`chip ${overdue ? 'overdue' : ''}`}><Icon name="calendar" />{card.due_date}</span>}
          {card.checklist.length > 0 && (
            <span className={`chip ${done === card.checklist.length ? 'complete' : ''}`}><Icon name="check" />{done}/{card.checklist.length}</span>
          )}
          {card.image_paths.length > 1 && <span className="chip"><Icon name="image" />{card.image_paths.length}</span>}
          {card.attachments.length > 0 && <span className="chip"><Icon name="paperclip" />{card.attachments.length}</span>}
          {card.source_message_id && <span className="chip"><Icon name="chat" />chat</span>}
          {assignee && <span className="card-assignee" title={`Assigned to ${assignee}`}><Avatar name={assignee} id={card.assignee_id!} size={22} /></span>}
        </span>
      </button>
    </li>
  )
}

function CardEditor({ card, me, lists, index, count, members, names, labels, onMove, onClose, onSaved, onDeleted }: {
  card: Card
  me: string
  lists: List[]
  index: number
  count: number
  members: Member[]
  names: Map<string, string>
  labels: Label[]
  onMove: (id: string, listId: string, index: number) => void
  onClose: () => void
  onSaved: (c: Card) => void
  onDeleted: () => void
}) {
  const [title, setTitle] = useState(card.title)
  const [description, setDescription] = useState(card.description)
  const [assignee, setAssignee] = useState(card.assignee_id ?? '')
  const [due, setDue] = useState(card.due_date ?? '')
  const [source, setSource] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [newItem, setNewItem] = useState('')
  const [comments, setComments] = useState<Comment[]>([])
  const [comment, setComment] = useState('')
  const [shared, setShared] = useState<Pick<Message, 'id' | 'user_id' | 'created_at'>[]>([])

  useEffect(() => {
    if (card.source_message_id)
      supabase.from('messages').select('body').eq('id', card.source_message_id).maybeSingle().then(({ data }) => setSource(data?.body ?? null))
  }, [card.source_message_id])

  useEffect(() => {
    supabase.from('card_comments').select('*').eq('card_id', card.id).order('created_at').then(({ data }) => setComments((data ?? []) as Comment[]))
    loadShared()
  }, [card.id])

  function loadShared() {
    supabase.from('messages').select('id, user_id, created_at').eq('card_id', card.id).order('created_at', { ascending: false }).limit(5)
      .then(({ data }) => setShared((data ?? []) as Pick<Message, 'id' | 'user_id' | 'created_at'>[]))
  }

  const shareToChat = async () => {
    const { error } = await supabase.from('messages').insert({ workspace_id: card.workspace_id, body: '', card_id: card.id })
    if (error) return setError(error.message)
    setError('Shared to chat.')
    loadShared()
  }

  // Images, checklist and comments save immediately; the form's Save button covers the text fields.
  const patch = async (fields: Partial<Pick<Card, 'image_paths' | 'checklist' | 'archived_at' | 'attachments' | 'label_ids'>>) => {
    const { data, error } = await supabase.from('cards').update(fields).eq('id', card.id).select().single()
    if (error) return setError(error.message)
    onSaved(data as Card)
  }

  const addImage = async (file: File) => {
    setUploading(true)
    try {
      await patch({ image_paths: [...card.image_paths, await uploadImage(card.workspace_id, file)] })
    } catch (err) {
      setError((err as Error).message)
    }
    setUploading(false)
  }

  const removeImage = async (path: string) => {
    await patch({ image_paths: card.image_paths.filter((x) => x !== path) })
    void removeIfUnused([path])
  }

  const addFile = async (file: File) => {
    setUploading(true)
    try {
      await patch({ attachments: [...card.attachments, await uploadFile(card.workspace_id, file)] })
    } catch (err) {
      setError((err as Error).message)
    }
    setUploading(false)
  }

  const removeFile = async (path: string) => {
    await patch({ attachments: card.attachments.filter((a) => a.path !== path) })
    void removeFilesIfUnused([path])
  }

  const toggleLabel = (id: string) =>
    void patch({ label_ids: card.label_ids.includes(id) ? card.label_ids.filter((x) => x !== id) : [...card.label_ids, id] })

  const commentMentions = useMentions(comment, setComment, names.values())

  const setChecklist = (checklist: ChecklistItem[]) => void patch({ checklist })

  const addItem = (e: FormEvent) => {
    e.preventDefault()
    if (newItem.trim()) setChecklist([...card.checklist, { text: newItem.trim().slice(0, 200), done: false }])
    setNewItem('')
  }

  const addComment = async (e: FormEvent) => {
    e.preventDefault()
    const { data, error } = await supabase
      .from('card_comments')
      .insert({ card_id: card.id, workspace_id: card.workspace_id, body: comment.trim() })
      .select()
      .single()
    if (error) return setError(error.message)
    setComments((p) => [...p, data as Comment])
    setComment('')
  }

  const deleteComment = async (id: string) => {
    const { error } = await supabase.from('card_comments').delete().eq('id', id)
    if (error) return setError(error.message)
    setComments((p) => p.filter((c) => c.id !== id))
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const { data, error } = await supabase
      .from('cards')
      .update({ title: title.trim(), description, assignee_id: assignee || null, due_date: due || null })
      .eq('id', card.id)
      .select()
      .single()
    if (error) return setError(error.message)
    onSaved(data as Card)
    onClose()
  }

  const remove = async () => {
    if (!confirm('Delete this card?')) return
    const { error } = await supabase.from('cards').delete().eq('id', card.id)
    if (error) setError(error.message)
    else onDeleted()
  }

  const done = card.checklist.filter((i) => i.done).length

  return (
    <Modal title="Card" onClose={onClose}>
      <div className="stack">
        {error && <p role="alert" className="notice" onClick={() => setError('')}>{error}</p>}
        <form id="card-form" className="stack" onSubmit={submit}>
          <label className="field">
            <span>Title</span>
            <input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field">
            <span>Description</span>
            <textarea rows={4} maxLength={10000} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <div className="two-col tight">
            <label className="field">
              <span>Assignee</span>
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">Nobody</option>
                {members.map((m) => (
                  <option key={m.user_id} value={m.user_id}>{m.profiles?.display_name ?? 'Unknown'}</option>
                ))}
              </select>
            </label>
            {/* Not a <label>: clicks inside the calendar would re-trigger its button. */}
            <div className="field">
              <span>Due date</span>
              <DatePicker label="Due date" value={due} onChange={setDue} />
            </div>
          </div>
          {source !== null && <blockquote className="muted">From chat: {source}</blockquote>}
        </form>

        <section className="stack section">
          <h3>Labels</h3>
          {labels.length === 0 ? (
            <p className="muted small">No labels yet. Add them from Labels in the board toolbar.</p>
          ) : (
            <div className="label-picker">
              {labels.map((l) => (
                <button key={l.id} type="button" className={`label label-${l.color} ${card.label_ids.includes(l.id) ? 'on' : 'off'}`}
                  aria-pressed={card.label_ids.includes(l.id)} onClick={() => toggleLabel(l.id)}>
                  {l.name}
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="stack section">
          <h3>Checklist {card.checklist.length > 0 && <span className="muted small">{done}/{card.checklist.length}</span>}</h3>
          {card.checklist.length > 0 && (
            <ul className="plain checklist">
              {card.checklist.map((item, i) => (
                <li key={i}>
                  <label className="check">
                    <input type="checkbox" checked={item.done}
                      onChange={() => setChecklist(card.checklist.map((x, j) => (j === i ? { ...x, done: !x.done } : x)))} />
                    <span className={item.done ? 'done' : ''}>{item.text}</span>
                  </label>
                  <button className="btn ghost icon-btn small" title="Remove item" onClick={() => setChecklist(card.checklist.filter((_, j) => j !== i))}>
                    <Icon name="x" /><span className="visually-hidden">Remove {item.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form className="input-row" onSubmit={addItem}>
            <input aria-label="New checklist item" placeholder="Add an item" maxLength={200} value={newItem} onChange={(e) => setNewItem(e.target.value)} />
            <button className="btn" disabled={card.checklist.length >= 100}>Add</button>
          </form>
        </section>

        <section className="stack section">
          <h3>Images</h3>
          {card.image_paths.length > 0 && (
            <div className="image-grid">
              {card.image_paths.map((p, i) => (
                <div key={p} className="image-tile">
                  <StoredImage path={p} alt={`Card image ${i + 1}`} />
                  <button className="btn ghost small" onClick={() => removeImage(p)}>Remove</button>
                </div>
              ))}
            </div>
          )}
          <ImagePicker label={uploading ? 'Uploading...' : 'Add image'} disabled={uploading || card.image_paths.length >= 20} onPick={addImage} />
        </section>

        <section className="stack section">
          <h3>Files</h3>
          {card.attachments.map((a) => (
            <FileChip key={a.path} file={a} onRemove={() => removeFile(a.path)} />
          ))}
          <label className={`btn ${uploading || card.attachments.length >= 20 ? 'disabled' : ''}`}>
            <Icon name="paperclip" /> {uploading ? 'Uploading...' : 'Attach file'}
            <input type="file" accept={FILE_ACCEPT} className="visually-hidden" disabled={uploading || card.attachments.length >= 20}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void addFile(f) }} />
          </label>
          <p className="muted small">PDF, Office, OpenDocument, text, CSV, Markdown, JSON or ZIP, up to 10 MB.</p>
        </section>

        <section className="stack section">
          <h3>Comments</h3>
          {comments.map((c) => {
            const name = names.get(c.user_id) ?? 'Former member'
            return (
              <div key={c.id} className="comment">
                <Avatar name={name} id={c.user_id} size={26} />
                <div className="grow">
                  <div className="message-head">
                    <strong>{name}</strong>
                    <time className="muted small" dateTime={c.created_at}>{formatTime(c.created_at)}</time>
                    {c.user_id === me && <button className="link small" onClick={() => deleteComment(c.id)}>Delete</button>}
                  </div>
                  <p className="body">{c.body}</p>
                </div>
              </div>
            )
          })}
          <form className="input-row comment-form" onSubmit={addComment}>
            <MentionList {...commentMentions} />
            <input aria-label="New comment" placeholder="Write a comment, @ to mention" required maxLength={4000} value={comment} onChange={(e) => setComment(e.target.value)} />
            <button className="btn">Post</button>
          </form>
        </section>

        {shared.length > 0 && (
          <section className="stack section">
            <h3>Shared in chat</h3>
            <ul className="plain stack small">
              {shared.map((s) => (
                <li key={s.id} className="muted">{names.get(s.user_id) ?? 'Former member'} shared it {formatTime(s.created_at)}</li>
              ))}
            </ul>
          </section>
        )}

        {!card.archived_at && <section className="stack section">
          <h3>Move</h3>
          <div className="input-row">
            <select aria-label="Column" value={card.list_id} onChange={(e) => onMove(card.id, e.target.value, Number.MAX_SAFE_INTEGER)}>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>{l.title}</option>
              ))}
            </select>
            <button className="btn ghost icon-btn" title="Move up" disabled={index <= 0} onClick={() => onMove(card.id, card.list_id, index - 1)}>
              <Icon name="up" /><span className="visually-hidden">Move up</span>
            </button>
            <button className="btn ghost icon-btn" title="Move down" disabled={index >= count - 1} onClick={() => onMove(card.id, card.list_id, index + 1)}>
              <Icon name="down" /><span className="visually-hidden">Move down</span>
            </button>
          </div>
        </section>}

        <div className="dialog-foot">
          <button type="button" className="btn danger ghost" onClick={remove}><Icon name="trash" /> <span className="hide-sm">Delete</span></button>
          <span className="row">
            <button type="button" className="btn ghost" onClick={() => patch({ archived_at: card.archived_at ? null : new Date().toISOString() })}>
              <Icon name="archive" /> {card.archived_at ? 'Restore' : 'Archive'}
            </button>
            <button type="button" className="btn ghost" onClick={shareToChat}><Icon name="share" /> <span className="hide-sm">Share to chat</span></button>
            <button className="btn primary" form="card-form">Save</button>
          </span>
        </div>
      </div>
    </Modal>
  )
}

function LabelManager({ workspaceId, labels, setLabels, onClose }: {
  workspaceId: string
  labels: Label[]
  setLabels: (fn: (prev: Label[]) => Label[]) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [color, setColor] = useState<Label['color']>('blue')
  const [error, setError] = useState('')

  const add = async (rows: { name: string; color: Label['color'] }[]) => {
    const { data, error } = await supabase.from('labels').insert(rows.map((r) => ({ ...r, workspace_id: workspaceId }))).select()
    if (error) return setError(error.message)
    setLabels((p) => [...p, ...(data as Label[])].sort((a, b) => a.name.localeCompare(b.name)))
  }

  const update = async (l: Label, fields: Partial<Pick<Label, 'name' | 'color'>>) => {
    setLabels((p) => p.map((x) => (x.id === l.id ? { ...x, ...fields } : x)))
    const { error } = await supabase.from('labels').update(fields).eq('id', l.id)
    if (error) setError(error.message)
  }

  const remove = async (l: Label) => {
    if (!confirm(`Delete the label "${l.name}"? It disappears from all cards.`)) return
    setLabels((p) => p.filter((x) => x.id !== l.id))
    const { error } = await supabase.from('labels').delete().eq('id', l.id)
    if (error) setError(error.message)
  }

  return (
    <Modal title="Labels" onClose={onClose}>
      <div className="stack">
        {error && <p role="alert" className="notice" onClick={() => setError('')}>{error}</p>}
        {labels.length === 0 && (
          <button className="btn" onClick={() => add([{ name: 'Bug', color: 'red' }, { name: 'Design', color: 'purple' }, { name: 'Urgent', color: 'orange' }])}>
            Add Bug, Design and Urgent
          </button>
        )}
        <ul className="plain stack">
          {labels.map((l) => (
            <li key={l.id} className="input-row">
              <span className={`label label-${l.color}`}>{l.name}</span>
              <input aria-label="Label name" maxLength={30} defaultValue={l.name}
                onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== l.name && update(l, { name: e.target.value.trim() })} />
              <select aria-label="Label colour" value={l.color} onChange={(e) => update(l, { color: e.target.value as Label['color'] })}>
                {LABEL_COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <button className="btn ghost icon-btn small" title="Delete label" onClick={() => remove(l)}>
                <Icon name="trash" /><span className="visually-hidden">Delete {l.name}</span>
              </button>
            </li>
          ))}
        </ul>
        <form className="input-row section" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void add([{ name: name.trim(), color }]); setName('') }}>
          <input aria-label="New label name" placeholder="New label, e.g. Backend" maxLength={30} value={name} onChange={(e) => setName(e.target.value)} />
          <select aria-label="New label colour" value={color} onChange={(e) => setColor(e.target.value as Label['color'])}>
            {LABEL_COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <button className="btn primary">Add</button>
        </form>
      </div>
    </Modal>
  )
}