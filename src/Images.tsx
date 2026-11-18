import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { Icon } from './Icon'

const MAX_BYTES = 5 * 1024 * 1024
const MAX_SIDE = 1600
const TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

const toBlob = (canvas: HTMLCanvasElement, type: string) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.82))

/** Scales photos down to 1600px and re-encodes them, which usually turns a 4 MB photo into ~250 KB. */
async function shrink(file: File): Promise<Blob> {
  if (file.type === 'image/gif') return file // re-encoding would drop the animation
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    if (TYPES.includes(file.type)) return file
    throw new Error('This image format is not supported. Use PNG, JPEG, GIF or WebP.')
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  // Safari can't encode WebP and silently returns PNG, so fall back to JPEG there.
  let blob = await toBlob(canvas, 'image/webp')
  if (blob?.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg')
  return blob && (blob.size < file.size || !TYPES.includes(file.type)) ? blob : file
}

/** Uploads to images/<workspace>/<random>. Storage policies enforce membership; this only gives friendly errors. */
export async function uploadImage(workspaceId: string, file: File): Promise<string> {
  const blob = await shrink(file)
  if (!TYPES.includes(blob.type)) throw new Error('Only PNG, JPEG, GIF and WebP images are supported.')
  if (blob.size > MAX_BYTES) throw new Error('That image is too large, even after shrinking (max 5 MB).')
  const path = `${workspaceId}/${crypto.randomUUID()}.${blob.type.split('/')[1]}`
  const { error } = await supabase.storage.from('images').upload(path, blob, { contentType: blob.type })
  if (error) throw error
  return path
}

/** Deletes image files that no message or card points to any more. Returns how many were deleted. */
export async function removeIfUnused(paths: string[]): Promise<number> {
  if (paths.length === 0) return 0
  const [m, c] = await Promise.all([
    supabase.from('messages').select('image_path').in('image_path', paths),
    supabase.from('cards').select('image_paths').overlaps('image_paths', paths),
  ])
  if (m.error || c.error) return 0
  const used = new Set<string>([
    ...(m.data as { image_path: string }[]).map((r) => r.image_path),
    ...(c.data as { image_paths: string[] }[]).flatMap((r) => r.image_paths),
  ])
  const unused = paths.filter((p) => !used.has(p))
  if (unused.length === 0) return 0
  // Files the user may not delete (only the uploader or workspace owner can) are skipped by storage policy.
  const { data } = await supabase.storage.from('images').remove(unused)
  return data?.length ?? 0
}

/** Owner cleanup: every file in the workspace folder that nothing references. Returns how many were removed. */
export async function removeAllUnused(workspaceId: string): Promise<number> {
  const files: { name: string; created_at: string | null }[] = []
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.storage.from('images').list(workspaceId, { limit: 1000, offset })
    if (error) throw error
    files.push(...data)
    if (data.length < 1000) break
  }
  // Skip fresh uploads: an image may be uploaded a moment before its message is saved.
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const candidates = files.filter((f) => f.created_at && f.created_at < hourAgo).map((f) => `${workspaceId}/${f.name}`)
  let removed = 0
  for (let i = 0; i < candidates.length; i += 100) removed += await removeIfUnused(candidates.slice(i, i + 100))
  return removed
}

/** Deletes every file in the workspace folder. Run before deleting a workspace, while its owner still has access. */
export async function removeFolder(workspaceId: string): Promise<void> {
  for (;;) {
    const { data, error } = await supabase.storage.from('images').list(workspaceId, { limit: 1000 })
    if (error) throw error
    if (data.length === 0) return
    const { data: removed } = await supabase.storage.from('images').remove(data.map((f) => `${workspaceId}/${f.name}`))
    if (!removed?.length) return
  }
}

// Signed URLs last an hour; reuse them so re-renders don't re-sign.
const urls = new Map<string, Promise<string | null>>()
const signedUrl = (path: string) => {
  if (!urls.has(path)) {
    urls.set(path, supabase.storage.from('images').createSignedUrl(path, 3600).then(({ data }) => data?.signedUrl ?? null))
    setTimeout(() => urls.delete(path), 50 * 60 * 1000)
  }
  return urls.get(path)!
}

/** `link={false}` renders just the image, for use inside another clickable element. */
export function StoredImage({ path, alt, link = true }: { path: string; alt: string; link?: boolean }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void signedUrl(path).then((u) => live && setUrl(u))
    return () => {
      live = false
    }
  }, [path])
  if (!url) return <span className="image-placeholder" aria-label="Loading image" />
  if (!link) return <img className="thumb" src={url} alt={alt} loading="lazy" />
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="image-link">
      <img src={url} alt={alt} loading="lazy" />
    </a>
  )
}

export function ImagePicker({ label, onPick, disabled, iconOnly }: {
  label: string
  onPick: (file: File) => void
  disabled?: boolean
  iconOnly?: boolean
}) {
  return (
    <label className={`btn ${iconOnly ? 'icon-btn' : ''} ${disabled ? 'disabled' : ''}`} title={label}>
      <Icon name="image" />
      {iconOnly ? <span className="visually-hidden">{label}</span> : label}
      <input
        type="file"
        accept="image/*"
        className="visually-hidden"
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) onPick(file)
        }}
      />
    </label>
  )
}
