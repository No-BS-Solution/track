import { useEffect, useRef, type ReactNode } from 'react'
import { Icon } from './Icon'

// Native <dialog> gives focus trapping, Escape to close and inert background for free.
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => ref.current?.showModal(), [])
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="modal-title">
      <div className="dialog-head">
        <h2 id="modal-title">{title}</h2>
        <button className="btn ghost icon-btn" onClick={() => ref.current?.close()}>
          <Icon name="x" />
          <span className="visually-hidden">Close</span>
        </button>
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  )
}
