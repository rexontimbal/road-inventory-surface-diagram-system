import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useModalLayer } from './useModalLayer'
import { getFullscreenPortalRoot } from '../../utils/fullscreenPortal'

const ICONS = {
  danger: (
    <path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v6M14 11v6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  ),
  warning: (
    <path d="M12 9v4m0 4h.01M10.3 3.9 2.6 17.5a1.5 1.5 0 0 0 1.3 2.3h16.2a1.5 1.5 0 0 0 1.3-2.3L13.7 3.9a1.5 1.5 0 0 0-2.6 0Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  ),
  info: (
    <path d="M12 16v-4m0-4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  ),
  success: (
    <path d="m8 12 3 3 5-6M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  ),
}

/**
 * Shared presentational modal for both confirm dialogs (Cancel + Confirm) and
 * plain alerts (single OK button). Imperatively driven by DialogProvider --
 * this component only renders what it's told and reports back via
 * onConfirm/onCancel.
 */
export default function Modal({
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'info',
  alertOnly = false,
  onConfirm,
  onCancel,
}) {
  const cardRef = useRef(null)
  const confirmBtnRef = useRef(null)
  const cancelBtnRef = useRef(null)
  const triggerElRef = useRef(null)
  const { zIndex, isTop } = useModalLayer()

  useEffect(() => {
    triggerElRef.current = document.activeElement
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    // Danger actions default focus to the safe option (Cancel); everything
    // else defaults to Confirm/OK so a quick Enter press does the obvious thing.
    const initialFocusEl =
      !alertOnly && variant === 'danger' ? cancelBtnRef.current : confirmBtnRef.current
    initialFocusEl?.focus()

    function handleKeyDown(e) {
      // A modal opened on top of this one (e.g. a confirm triggered from
      // within an already-open modal) is still mounted underneath -- only
      // the top-most modal should react to Esc/Tab.
      if (!isTop()) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return
      }
      if (e.key === 'Tab') {
        const focusable = cardRef.current?.querySelectorAll('button')
        if (!focusable || focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = prevOverflow
      triggerElRef.current?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (zIndex == null) return null

  return createPortal(
    <div
      className="modal-backdrop no-print"
      style={{ zIndex }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        className="modal-card"
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <div className="modal-header">
          <div className={`modal-icon modal-icon-${variant}`} aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              {ICONS[variant] || ICONS.info}
            </svg>
          </div>
          <h3 id="modal-title" className="modal-title">
            {title}
          </h3>
        </div>
        <p className="modal-message">{message}</p>
        <div className="modal-actions">
          {!alertOnly && (
            <button ref={cancelBtnRef} type="button" className="modal-btn modal-btn-cancel" onClick={onCancel}>
              {cancelText}
            </button>
          )}
          <button
            ref={confirmBtnRef}
            type="button"
            className={`modal-btn ${variant === 'danger' ? 'modal-btn-danger' : 'modal-btn-confirm'}`}
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    getFullscreenPortalRoot()
  )
}
