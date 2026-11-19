import { supabase, type Member, type Workspace } from './supabase'

// PostgREST returns at most 1000 rows per request, so page through bigger tables.
async function all(table: string, workspaceId: string, order: string) {
  const rows: unknown[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select('*').eq('workspace_id', workspaceId).order(order).range(from, from + 999)
    if (error) throw error
    rows.push(...data)
    if (data.length < 1000) return rows
  }
}

/** Downloads everything readable in the workspace as one JSON file. Images and files are referenced by path, not embedded. */
export async function exportWorkspace(ws: Workspace, members: Member[]): Promise<void> {
  const [messages, lists, cards, comments, labels, reactions] = await Promise.all([
    all('messages', ws.id, 'created_at'),
    all('lists', ws.id, 'position'),
    all('cards', ws.id, 'position'),
    all('card_comments', ws.id, 'created_at'),
    all('labels', ws.id, 'name'),
    all('message_reactions', ws.id, 'message_id'),
  ])
  const data = {
    exported_at: new Date().toISOString(),
    workspace: { id: ws.id, name: ws.name, created_at: ws.created_at },
    members: members.map((m) => ({ user_id: m.user_id, name: m.profiles?.display_name, role: m.role })),
    labels,
    lists,
    cards,
    card_comments: comments,
    messages,
    message_reactions: reactions,
  }
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${ws.name.replace(/[^\w-]+/g, '-').toLowerCase() || 'workspace'}-${data.exported_at.slice(0, 10)}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
