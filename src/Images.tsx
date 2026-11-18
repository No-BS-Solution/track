import { useEffect, useState } from 'react'
import { supabase } from './supabase'

const MAX_BYTES = 5 * 1024 * 1024
const TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** Uploads to images/<workspace>/<random>. Storage policies enforce membership; this only gives friendly errors. */
export async function uploadImage(workspaceId: string, file: File): Promise<string> {
  if (!TYPES.includes(file.type)) throw new Error('Only PNG, JPEG, GIF and WebP images are supported.')
  if (file.size > MAX_BYTES) throw new Error('Images can be at most 5 MB.')
  const path = `${workspaceId}/${crypto.randomUUID()}.${file.type.split('/')[1]}`
  const { error } = await supabase.storage.from('images').upload(path, file, { contentType: file.type })
  if (error) throw error
  return path
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

export function StoredImage({ path, alt }: { path: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void signedUrl(path).then((u) => live && setUrl(u))
    return () => {
      live = false
    }
  }, [path])
  if (!url) return <span className="image-placeholder muted">Image</span>
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="image-link">
      <img src={url} alt={alt} loading="lazy" />
    </a>
  )
}

export function ImagePicker({ label, onPick, disabled }: { label: string; onPick: (file: File) => void; disabled?: boolean }) {
  return (
    <label className={`button ${disabled ? 'disabled' : ''}`}>
      {label}
      <input
        type="file"
        accept={TYPES.join(',')}
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
