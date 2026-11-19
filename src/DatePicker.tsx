import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'

// Dates are 'YYYY-MM-DD' in the user's local time zone, matching the due_date column.
export const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const parse = (s: string) => new Date(`${s}T00:00`)
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']

export function DatePicker({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState(() => (value ? parse(value) : new Date()))
  const root = useRef<HTMLDivElement>(null)
  const today = isoDate(new Date())

  useEffect(() => {
    if (!open) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key !== 'Escape' : root.current?.contains(e.target as Node)) return
      if (e instanceof KeyboardEvent) e.preventDefault() // Escape closes only the calendar, not the surrounding <dialog>.
      setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])

  const pick = (v: string) => {
    onChange(v)
    setOpen(false)
  }

  // Six Monday-first weeks covering the shown month.
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const start = addDays(first, -((first.getDay() + 6) % 7))
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i))
  const now = new Date()

  return (
    <div className="date-picker" ref={root}>
      <button type="button" className="date-trigger" aria-label={label} aria-expanded={open}
        onClick={() => { setMonth(value ? parse(value) : new Date()); setOpen(!open) }}>
        <Icon name="calendar" />
        <span className={value ? '' : 'muted'}>
          {value ? parse(value).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : 'No due date'}
        </span>
      </button>
      {open && (
        <div className="date-pop" role="dialog" aria-label={label}>
          <div className="date-quick">
            <button type="button" className="btn ghost small" onClick={() => pick(today)}>Today</button>
            <button type="button" className="btn ghost small" onClick={() => pick(isoDate(addDays(now, 1)))}>Tomorrow</button>
            <button type="button" className="btn ghost small" onClick={() => pick(isoDate(addDays(now, 7)))}>Next week</button>
            {value && <button type="button" className="btn ghost small" onClick={() => pick('')}>Clear</button>}
          </div>
          <div className="date-head">
            <button type="button" className="btn ghost icon-btn small" aria-label="Previous month"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><Icon name="left" /></button>
            <strong aria-live="polite">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</strong>
            <button type="button" className="btn ghost icon-btn small" aria-label="Next month"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><Icon name="right" /></button>
          </div>
          <div className="date-grid">
            {WEEKDAYS.map((w) => <span key={w} className="date-dow">{w}</span>)}
            {days.map((d) => {
              const v = isoDate(d)
              return (
                <button key={v} type="button" onClick={() => pick(v)} aria-pressed={v === value}
                  aria-label={d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                  className={`date-day${d.getMonth() !== month.getMonth() ? ' outside' : ''}${v === today ? ' today' : ''}${v === value ? ' selected' : ''}`}>
                  {d.getDate()}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
