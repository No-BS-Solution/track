import { createClient } from '@supabase/supabase-js'

// The anon key is public by design. Row Level Security in supabase/migrations is the security boundary.
export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, {
  // PKCE puts the email-link result in ?code= instead of the #fragment, which hash routing needs.
  auth: { flowType: 'pkce' },
})

// Registered right after createClient so it sees the event fired while the reset link's code is exchanged.
export let passwordRecovery = false
supabase.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') passwordRecovery = true
})
export const endPasswordRecovery = () => (passwordRecovery = false)

export const appUrl = location.origin + import.meta.env.BASE_URL

// Supabase free plan limits, used for the "almost full" warning. Raise these after upgrading.
export const LIMITS = { dbBytes: 500 * 1024 ** 2, fileBytes: 1024 ** 3 }

export type Workspace = { id: string; name: string; invite_code: string; created_at: string }
export type Member = {
  user_id: string
  role: 'owner' | 'member'
  last_read_at: string
  notify: 'all' | 'mentions' | 'none'
  profiles: { display_name: string } | null
}
export type Message = {
  id: string
  workspace_id: string
  user_id: string
  body: string
  created_at: string
  edited_at: string | null
  image_path: string | null
  reply_to: string | null
  card_id: string | null
  pinned_at: string | null
  file_path: string | null
  file_name: string | null
  file_size: number | null
}
// Must match the check constraint on message_reactions.emoji.
export const EMOJIS = ['👍', '❤️', '😂', '🎉', '👀', '✅'] as const
export type Reaction = { message_id: string; user_id: string; emoji: string }
export type List = { id: string; workspace_id: string; title: string; position: string }
export type ChecklistItem = { text: string; done: boolean }
export type Attachment = { path: string; name: string; size: number }
// Must match the check constraint on labels.color.
export const LABEL_COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'gray'] as const
export type Label = { id: string; workspace_id: string; name: string; color: (typeof LABEL_COLORS)[number] }
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
  image_paths: string[]
  checklist: ChecklistItem[]
  archived_at: string | null
  label_ids: string[]
  attachments: Attachment[]
  updated_at: string
}
export type Comment = { id: string; card_id: string; user_id: string; body: string; created_at: string }

export function upsert<T extends { id: string }>(rows: T[], row: T): T[] {
  return rows.some((r) => r.id === row.id) ? rows.map((r) => (r.id === row.id ? row : r)) : [...rows, row]
}

export const formatTime = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
