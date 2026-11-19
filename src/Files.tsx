import { supabase, type Attachment } from './supabase'
import { Icon } from './Icon'

const MAX_BYTES = 10 * 1024 * 1024

// Must match allowed_mime_types on the `files` bucket. Browsers often report '' for these, so fall back to the extension.
const TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  json: 'application/json',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
}
export const FILE_ACCEPT = Object.keys(TYPES).map((e) => `.${e}`).join(',')

export const formatSize = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** Uploads to files/<workspace>/<random>.<ext>. Storage policies enforce membership and allowed types. */
export async function uploadFile(workspaceId: string, file: File): Promise<Attachment> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  const type = TYPES[ext]
  if (!type) throw new Error('That file type is not supported. Use PDF, Office, OpenDocument, text, CSV, Markdown, JSON or ZIP.')
  if (file.size > MAX_BYTES) throw new Error('Files can be at most 10 MB.')
  const path = `${workspaceId}/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from('files').upload(path, file, { contentType: type })
  if (error) throw error
  return { path, name: file.name.slice(0, 200), size: file.size }
}

/** Deletes files that no message or card points to any more. Returns how many were deleted. */
export async function removeFilesIfUnused(paths: string[]): Promise<number> {
  if (paths.length === 0) return 0
  const workspaceId = paths[0].split('/')[0]
  const [m, c] = await Promise.all([
    supabase.from('messages').select('file_path').in('file_path', paths),
    supabase.from('cards').select('attachments').eq('workspace_id', workspaceId).neq('attachments', '[]'),
  ])
  if (m.error || c.error) return 0
  const used = new Set<string>([
    ...(m.data as { file_path: string }[]).map((r) => r.file_path),
    ...(c.data as { attachments: Attachment[] }[]).flatMap((r) => r.attachments.map((a) => a.path)),
  ])
  const unused = paths.filter((p) => !used.has(p))
  if (unused.length === 0) return 0
  const { data } = await supabase.storage.from('files').remove(unused)
  return data?.length ?? 0
}

export async function removeAllUnusedFiles(workspaceId: string): Promise<number> {
  const { data, error } = await supabase.storage.from('files').list(workspaceId, { limit: 1000 })
  if (error) throw error
  // Skip fresh uploads: a file may be uploaded a moment before its message is saved.
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const candidates = data.filter((f) => f.created_at && f.created_at < hourAgo).map((f) => `${workspaceId}/${f.name}`)
  let removed = 0
  for (let i = 0; i < candidates.length; i += 100) removed += await removeFilesIfUnused(candidates.slice(i, i + 100))
  return removed
}

/** Opens a short-lived download link; the name is passed so the browser saves it as an attachment. */
async function download(a: Attachment) {
  const { data, error } = await supabase.storage.from('files').createSignedUrl(a.path, 60, { download: a.name })
  if (error || !data) return alert('Could not download the file. It may have been deleted.')
  location.href = data.signedUrl
}

export function FileChip({ file, onRemove }: { file: Attachment; onRemove?: () => void }) {
  return (
    <span className="file-chip">
      <button className="file-open" onClick={() => void download(file)} title={`Download ${file.name}`}>
        <Icon name="file" />
        <span className="file-name">{file.name}</span>
        <span className="muted small">{formatSize(file.size)}</span>
      </button>
      {onRemove && (
        <button className="btn ghost icon-btn small" onClick={onRemove} title="Remove file">
          <Icon name="x" /><span className="visually-hidden">Remove {file.name}</span>
        </button>
      )}
    </span>
  )
}
