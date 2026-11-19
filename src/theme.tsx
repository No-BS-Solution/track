import { useState } from 'react'
import { Icon } from './Icon'

type Theme = 'system' | 'light' | 'dark'
const KEY = 'track-theme'

function read(): Theme {
  try {
    const t = localStorage.getItem(KEY)
    return t === 'light' || t === 'dark' ? t : 'system'
  } catch {
    return 'system'
  }
}

function apply(theme: Theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
}

// Runs on import, before the first render, so the page doesn't flash the wrong theme.
apply(read())

const next: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' }
const labels: Record<Theme, string> = { system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' }

export function ThemeToggle() {
  const [theme, setTheme] = useState(read)
  const change = () => {
    const t = next[theme]
    setTheme(t)
    apply(t)
    try {
      if (t === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, t)
    } catch {
      // Storage blocked (private mode): the choice just lasts for this page view.
    }
  }
  return (
    <button className="btn ghost icon-btn" onClick={change} title={`${labels[theme]} (click to change)`}>
      <Icon name={theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'monitor'} />
      <span className="visually-hidden">{labels[theme]}</span>
    </button>
  )
}
