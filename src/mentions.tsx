/** @mention suggestions for the name being typed at the end of `text`, shared by chat and card comments. */
export function useMentions(text: string, setText: (t: string) => void, names: Iterable<string>) {
  const match = text.match(/(?:^|\s)@([^@\n]{0,30})$/)
  const typed = match?.[1] ?? ''
  const suggestions = match
    ? [...new Set(names)].filter((n) => n.toLowerCase().startsWith(typed.toLowerCase()) && n !== typed).slice(0, 5)
    : []
  const pick = (name: string) => setText(text.slice(0, text.length - typed.length) + name + ' ')
  return { suggestions, pick }
}

export function MentionList({ suggestions, pick }: { suggestions: string[]; pick: (name: string) => void }) {
  if (suggestions.length === 0) return null
  return (
    <div className="mentions" aria-label="Mention someone">
      {suggestions.map((n) => (
        <button type="button" key={n} onClick={() => pick(n)}>@{n}</button>
      ))}
    </div>
  )
}
