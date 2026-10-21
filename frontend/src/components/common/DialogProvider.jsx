import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Modal from './Modal'
import { getFullscreenPortalRoot } from '../../utils/fullscreenPortal'

let _confirmHandler = null
let _alertHandler = null
let _toastHandler = null

/** Shows a Cancel/Confirm modal. Resolves true on confirm, false on cancel/dismiss. */
export function showConfirm(options) {
  return new Promise((resolve) => {
    if (_confirmHandler) _confirmHandler({ ...options, resolve })
    else resolve(window.confirm(options.message)) // eslint-disable-line no-alert -- fallback if provider isn't mounted
  })
}

/** Shows a single-button acknowledgement modal. Resolves once dismissed. */
export function showAlert(options) {
  return new Promise((resolve) => {
    if (_alertHandler) _alertHandler({ ...options, resolve })
    else {
      window.alert(options.message) // eslint-disable-line no-alert -- fallback if provider isn't mounted
      resolve(true)
    }
  })
}

/** Shows a short-lived top-right toast. variant: 'success' | 'danger' | 'warning' | 'info'. */
export function showToast(options) {
  if (_toastHandler) _toastHandler(options)
}

const TOAST_ICONS = {
  success: '✓',
  danger: '✕',
  warning: '!',
  info: 'i',
}

export default function DialogProvider({ children }) {
  const [confirmState, setConfirmState] = useState(null)
  const [alertState, setAlertState] = useState(null)
  const [toasts, setToasts] = useState([])
  // Per-toast countdown state, keyed by toast id -- lets hover pause/resume
  // the auto-dismiss timer without re-rendering the toast list on every tick.
  const toastTimers = useRef(new Map())
  // Mirrors `toasts` for _toastHandler to read synchronously -- that handler
  // is assigned once in a []-deps effect below, so closing over `toasts`
  // directly would always see the initial empty array, never a later one.
  const toastsRef = useRef([])
  useEffect(() => {
    toastsRef.current = toasts
  }, [toasts])
  // Re-renders on every fullscreen enter/exit so the toast portal below
  // (which otherwise might not re-render around that exact moment) always
  // targets the current getFullscreenPortalRoot() -- a toast fired while
  // the diagram is truly fullscreen must land inside it to be seen at all.
  const [, forceUpdate] = useState(0)

  useEffect(() => {
    function handleFullscreenChange() {
      forceUpdate((n) => n + 1)
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange)
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange)
    }
  }, [])

  useEffect(() => {
    _confirmHandler = (opts) => setConfirmState(opts)
    _alertHandler = (opts) => setAlertState(opts)
    _toastHandler = (opts) => {
      const variant = opts.variant ?? 'info'
      // Dedupe against whatever's already on screen -- a caller that fires
      // the same failure 2-3 times in a row (a double-click, a retry, the
      // same error surfacing from more than one place) shows ONE toast, not
      // a stack of identical ones. Scoped to currently-visible toasts, which
      // already bounds this to "the last few seconds" since toasts
      // auto-dismiss on their own.
      const isDuplicate = toastsRef.current.some((t) => t.variant === variant && t.message === opts.message)
      if (isDuplicate) return
      const id = `${Date.now()}-${Math.random()}`
      const duration = opts.duration ?? 3000
      setToasts((t) => [...t, { id, variant: 'info', ...opts }])
      scheduleToastDismiss(id, duration)
    }
    return () => {
      _confirmHandler = null
      _alertHandler = null
      _toastHandler = null
    }
  }, [])

  function closeConfirm(result) {
    confirmState?.resolve(result)
    setConfirmState(null)
  }

  function closeAlert() {
    alertState?.resolve(true)
    setAlertState(null)
  }

  function dismissToast(id) {
    const timer = toastTimers.current.get(id)
    if (timer) {
      clearTimeout(timer.timeoutId)
      toastTimers.current.delete(id)
    }
    setToasts((t) => t.filter((x) => x.id !== id))
  }

  function scheduleToastDismiss(id, duration) {
    const timeoutId = setTimeout(() => {
      toastTimers.current.delete(id)
      setToasts((t) => t.filter((x) => x.id !== id))
    }, duration)
    toastTimers.current.set(id, { timeoutId, remaining: duration, startedAt: Date.now() })
  }

  function pauseToast(id) {
    const timer = toastTimers.current.get(id)
    if (!timer) return
    clearTimeout(timer.timeoutId)
    timer.remaining -= Date.now() - timer.startedAt
    timer.timeoutId = null
  }

  function resumeToast(id) {
    const timer = toastTimers.current.get(id)
    if (!timer || timer.timeoutId) return
    const remaining = Math.max(timer.remaining, 0)
    timer.timeoutId = setTimeout(() => {
      toastTimers.current.delete(id)
      setToasts((t) => t.filter((x) => x.id !== id))
    }, remaining)
    timer.startedAt = Date.now()
  }

  return (
    <>
      {children}

      {confirmState && (
        <Modal
          title={confirmState.title}
          message={confirmState.message}
          confirmText={confirmState.confirmText || 'Confirm'}
          cancelText={confirmState.cancelText || 'Cancel'}
          variant={confirmState.variant || 'info'}
          onConfirm={() => closeConfirm(true)}
          onCancel={() => closeConfirm(false)}
        />
      )}

      {alertState && (
        <Modal
          title={alertState.title}
          message={alertState.message}
          confirmText={alertState.confirmText || 'OK'}
          variant={alertState.variant || 'info'}
          alertOnly
          onConfirm={closeAlert}
          onCancel={closeAlert}
        />
      )}

      {createPortal(
        <div className="toast-stack no-print">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`toast toast-${t.variant}`}
              role="status"
              onMouseEnter={() => pauseToast(t.id)}
              onMouseLeave={() => resumeToast(t.id)}
            >
              <span className="toast-icon" aria-hidden="true">
                {TOAST_ICONS[t.variant] || TOAST_ICONS.info}
              </span>
              <span className="toast-message">{t.message}</span>
              {t.actionLabel && (
                <button
                  type="button"
                  className="toast-action"
                  onClick={() => {
                    t.onAction?.()
                    dismissToast(t.id)
                  }}
                >
                  {t.actionLabel}
                </button>
              )}
              <button type="button" className="toast-close" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
                ×
              </button>
            </div>
          ))}
        </div>,
        getFullscreenPortalRoot()
      )}
    </>
  )
}
