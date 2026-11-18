import { createClient } from '@supabase/supabase-js'

// The anon key is public by design. Row Level Security in supabase/migrations is the security boundary.
export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, {
  // PKCE puts the email-link result in ?code= instead of the #fragment, which hash routing needs.
  auth: { flowType: 'pkce' },
})

export const appUrl = location.origin + import.meta.env.BASE_URL

export type Workspace = { id: string; name: string; invite_code: string; created_at: string }
export type Member = {
  user_id: string
  role: 'owner' | 'member'
  last_read_at: string
  profiles: { display_name: string } | null
}
export type Message = {
  id: string
  workspace_id: string
  user_id: string
  body: string
  created_at: string
  edited_at: string | null
}
export type List = { id: string; workspace_id: string; title: string; position: string }
export type Card = {
  id: string
  list_id: string
  workspace_id: string
  title: string
  description: string
  assignee_id: string | null
  due_date: string | null
  position: string
  source_message_id: string | null
  updated_at: string
}

export function upsert<T extends { id: string }>(rows: T[], row: T): T[] {
  return rows.some((r) => r.id === row.id) ? rows.map((r) => (r.id === row.id ? row : r)) : [...rows, row]
}
