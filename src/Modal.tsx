import { useEffect, useRef, type ReactNode } from 'react'

// Native <dialog> gives focus trapping, Escape to close and inert background for free.
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => ref.current?.showModal(), [])
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="modal-title">
      <div className="row spread">
        <h2 id="modal-title">{title}</h2>
        <button onClick={() => ref.current?.close()} aria-label="Close">x</button>
      </div>
      {children}
    </dialog>
  )
}
