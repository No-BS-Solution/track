import { useEffect, useRef, useState, type FormEvent } from 'react'
import { draggable, dropTargetForElements, monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine'
import { announce } from '@atlaskit/pragmatic-drag-and-drop-live-region'
import { generateKeyBetween } from 'fractional-indexing'
import { supabase, upsert, type Card, type List, type Member, type Workspace } from './supabase'
import { Modal } from './Modal'

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

export function Board({ ws, members }: { ws: Workspace; members: Member[] }) {
  const [lists, setLists] = useState<List[]>([])
  const [cards, setCards] = useState<Card[]>([])
  const [openCard, setOpenCard] = useState<string | null>(null)
  const [newList, setNewList] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    const [l, c] = await Promise.all([
      supabase.from('lists').select('*').eq('workspace_id', ws.id),
      supabase.from('cards').select('*').eq('workspace_id', ws.id),
    ])
    if (l.error || c.error) return setError((l.error ?? c.error)!.message)
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
  const cardsIn = (listId: string) => cards.filter((c) => c.list_id === listId).sort(byPosition)

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
    const { data, error } = await supabase.from('cards').insert({ list_id: listId, workspace_id: ws.id, title, position }).select().single()
    if (error) return setError(error.message)
    setCards((p) => upsert(p, data as Card))
  }

  const names = new Map(members.map((m) => [m.user_id, m.profiles?.display_name ?? 'Unknown']))
  const card = cards.find((c) => c.id === openCard)

  return (
    <section className="board" aria-label="Board">
      {error && <p role="alert" className="notice" onClick={() => setError('')}>{error}</p>}
      <div className="lists">
        {sortedLists.map((list, i) => (
          <ListColumn
            key={list.id}
            list={list}
            cards={cardsIn(list.id)}
            names={names}
            canLeft={i > 0}
            canRight={i < sortedLists.length - 1}
            onMove={(dir) => moveList(list.id, i + dir)}
            onRename={(title) => save(supabase.from('lists').update({ title }).eq('id', list.id))}
            onDelete={() => {
              if (!confirm(`Delete column "${list.title}" and all its cards?`)) return
              setLists((p) => p.filter((l) => l.id !== list.id))
              void save(supabase.from('lists').delete().eq('id', list.id), true)
            }}
            onAddCard={(title) => addCard(list.id, title)}
            onOpenCard={setOpenCard}
          />
        ))}
        <form className="add-list stack" onSubmit={addList}>
          <input aria-label="New column name" placeholder="New column, e.g. QA" required maxLength={100} value={newList} onChange={(e) => setNewList(e.target.value)} />
          <button className="primary">Add column</button>
          {loaded && sortedLists.length === 0 && (
            <button type="button" onClick={() => addColumns(starterColumns)}>Start with {starterColumns.join(', ')}</button>
          )}
        </form>
      </div>
      {card && (
        <CardEditor
          key={card.id}
          card={card}
          lists={sortedLists}
          index={cardsIn(card.list_id).findIndex((c) => c.id === card.id)}
          count={cardsIn(card.list_id).length}
          members={members}
          onMove={moveCard}
          onClose={() => setOpenCard(null)}
          onSaved={(c) => setCards((p) => upsert(p, c))}
          onDeleted={() => {
            setCards((p) => p.filter((c) => c.id !== card.id))
            setOpenCard(null)
          }}
        />
      )}
    </section>
  )
}

function ListColumn({ list, cards, names, canLeft, canRight, onMove, onRename, onDelete, onAddCard, onOpenCard }: {
  list: List
  cards: Card[]
  names: Map<string, string>
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
      <h3 className="list-head row">
        <span ref={handle} className="grip" title="Drag to reorder" aria-hidden="true">::</span>
        <input ref={titleInput} aria-label="Column name" maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} onBlur={rename}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
      </h3>
      <div className="row list-tools">
        <button aria-label={`Move column ${list.title} left`} disabled={!canLeft} onClick={() => onMove(-1)}>&lt;</button>
        <button aria-label={`Move column ${list.title} right`} disabled={!canRight} onClick={() => onMove(1)}>&gt;</button>
        <button aria-label={`Rename column ${list.title}`} onClick={() => titleInput.current?.select()}>Rename</button>
        <button aria-label={`Delete column ${list.title}`} onClick={onDelete}>Delete</button>
      </div>
      <ul className="plain cards">
        {cards.map((c) => (
          <CardItem key={c.id} card={c} assignee={c.assignee_id ? names.get(c.assignee_id) : undefined} onOpen={() => onOpenCard(c.id)} />
        ))}
      </ul>
      <form className="row" onSubmit={add}>
        <input aria-label={`New card in ${list.title}`} placeholder="Add a card" required maxLength={200} value={newCard} onChange={(e) => setNewCard(e.target.value)} />
        <button>Add</button>
      </form>
    </div>
  )
}

function CardItem({ card, assignee, onOpen }: { card: Card; assignee?: string; onOpen: () => void }) {
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

  const overdue = card.due_date && card.due_date < new Date().toISOString().slice(0, 10)
  return (
    <li ref={ref} className={`card ${dragging ? 'dragging' : ''} ${edge ? `drop-${edge}` : ''}`}>
      <button className="card-btn" onClick={onOpen}>
        <span className="card-title">{card.title}</span>
        {(card.due_date || assignee || card.source_message_id) && (
          <span className="card-meta row">
            {card.due_date && <span className={overdue ? 'overdue' : ''}>Due {card.due_date}</span>}
            {assignee && <span>{assignee}</span>}
            {card.source_message_id && <span>From chat</span>}
          </span>
        )}
      </button>
    </li>
  )
}

function CardEditor({ card, lists, index, count, members, onMove, onClose, onSaved, onDeleted }: {
  card: Card
  lists: List[]
  index: number
  count: number
  members: Member[]
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

  useEffect(() => {
    if (card.source_message_id)
      supabase.from('messages').select('body').eq('id', card.source_message_id).maybeSingle().then(({ data }) => setSource(data?.body ?? null))
  }, [card.source_message_id])

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

  return (
    <Modal title="Card" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {error && <p role="alert" className="notice">{error}</p>}
        <label>
          Title
          <input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          Description
          <textarea rows={6} maxLength={10000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          Assignee
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Nobody</option>
            {members.map((m) => (
              <option key={m.user_id} value={m.user_id}>{m.profiles?.display_name ?? 'Unknown'}</option>
            ))}
          </select>
        </label>
        <label>
          Due date
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
        {source !== null && (
          <blockquote className="muted">From chat: {source}</blockquote>
        )}
        <fieldset className="row">
          <legend>Move (saved immediately)</legend>
          <select aria-label="Column" value={card.list_id} onChange={(e) => onMove(card.id, e.target.value, Number.MAX_SAFE_INTEGER)}>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>{l.title}</option>
            ))}
          </select>
          <button type="button" disabled={index <= 0} onClick={() => onMove(card.id, card.list_id, index - 1)}>Up</button>
          <button type="button" disabled={index >= count - 1} onClick={() => onMove(card.id, card.list_id, index + 1)}>Down</button>
        </fieldset>
        <div className="row spread">
          <button type="button" className="danger" onClick={remove}>Delete card</button>
          <button className="primary">Save</button>
        </div>
      </form>
    </Modal>
  )
}
