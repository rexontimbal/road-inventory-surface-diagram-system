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

/**
 * Shows a top-center toast card. variant: 'success' | 'danger' | 'warning' | 'info'.
 * `title` defaults from variant when omitted -- every existing call site that
 * only passes `message` keeps working unchanged, it just becomes the
 * secondary line under the (now-required-looking) title. `avatarUrl` swaps
 * the variant icon for a round avatar (used for share notifications).
 */
export function showToast(options) {
  if (_toastHandler) _toastHandler(options)
}

const DEFAULT_TITLES = {
  success: 'Success',
  danger: 'Error',
  warning: 'Warning',
  info: 'Notice',
}

const DEFAULT_DURATIONS = {
  success: 4000,
  info: 4000,
  warning: 8000,
  danger: 8000,
}

const MAX_VISIBLE_TOASTS = 3
const EXIT_DURATION_MS = 180

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
      const isDuplicate = toastsRef.current.some(
        (t) => !t.closing && t.variant === variant && t.message === opts.message && t.title === (opts.title ?? DEFAULT_TITLES[variant])
      )
      if (isDuplicate) return
      const id = `${Date.now()}-${Math.random()}`
      const duration = opts.duration ?? DEFAULT_DURATIONS[variant] ?? 4000
      const toast = {
        id,
        variant,
        title: opts.title ?? DEFAULT_TITLES[variant],
        message: opts.message,
        actionLabel: opts.actionLabel,
        onAction: opts.onAction,
        avatarUrl: opts.avatarUrl,
        duration,
        closing: false,
      }
      setToasts((t) => {
        const next = [...t, toast]
        // Max 3 visible at once -- the oldest beyond that limit is dropped
        // outright (its timer never scheduled) rather than kept around
        // invisibly, so the array itself never grows unbounded.
        if (next.length > MAX_VISIBLE_TOASTS) {
          const dropped = next.splice(0, next.length - MAX_VISIBLE_TOASTS)
          for (const d of dropped) clearToastTimer(d.id)
        }
        return next
      })
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

  function clearToastTimer(id) {
    const timer = toastTimers.current.get(id)
    if (timer?.timeoutId) clearTimeout(timer.timeoutId)
    toastTimers.current.delete(id)
  }

  // Two-phase removal: mark "closing" so the exit animation can play, then
  // actually drop it from the array once that animation has had time to finish.
  function startClose(id) {
    setToasts((t) => t.map((x) => (x.id === id ? { ...x, closing: true } : x)))
    clearToastTimer(id)
    setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id))
    }, EXIT_DURATION_MS)
  }

  function scheduleToastDismiss(id, duration) {
    const timeoutId = setTimeout(() => startClose(id), duration)
    toastTimers.current.set(id, { timeoutId, remaining: duration, startedAt: Date.now() })
  }

  function pauseToast(id) {
    const timer = toastTimers.current.get(id)
    if (!timer || !timer.timeoutId) return
    clearTimeout(timer.timeoutId)
    timer.remaining -= Date.now() - timer.startedAt
    timer.timeoutId = null
  }

  function resumeToast(id) {
    const timer = toastTimers.current.get(id)
    if (!timer || timer.timeoutId) return
    const remaining = Math.max(timer.remaining, 0)
    timer.timeoutId = setTimeout(() => startClose(id), remaining)
    timer.startedAt = Date.now()
  }

  // Newest first (top of the stack), capped to the visible window -- the
  // underlying array can briefly exceed MAX_VISIBLE_TOASTS while an older
  // one is still mid-exit-animation, so this is a render-time slice, not a
  // second cap.
  const visibleToasts = [...toasts].slice(-MAX_VISIBLE_TOASTS).reverse()

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
          {visibleToasts.map((t) => (
            <div
              key={t.id}
              className={`toast toast-${t.variant}${t.closing ? ' toast-closing' : ''}`}
              role={t.variant === 'warning' || t.variant === 'danger' ? 'alert' : 'status'}
              onMouseEnter={() => pauseToast(t.id)}
              onMouseLeave={() => resumeToast(t.id)}
              onFocus={() => pauseToast(t.id)}
              onBlur={() => resumeToast(t.id)}
            >
              <div className="toast-row">
                {t.avatarUrl ? (
                  <img src={t.avatarUrl} alt="" className="toast-avatar" referrerPolicy="no-referrer" />
                ) : (
                  <span className={`toast-icon toast-icon-${t.variant}`} aria-hidden="true">
                    {t.variant === 'success' && (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                        <path d="m5 13 4 4 10-10" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                    {t.variant === 'info' && (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
                        <path d="M12 11v5.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        <circle cx="12" cy="7.8" r="1.1" fill="currentColor" />
                      </svg>
                    )}
                    {t.variant === 'warning' && (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                        <path d="M12 9v4.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                        <circle cx="12" cy="16.3" r="1.1" fill="currentColor" />
                        <path
                          d="M10.3 3.9 2.6 17.2a2 2 0 0 0 1.73 3h15.34a2 2 0 0 0 1.73-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                    {t.variant === 'danger' && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                        <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
                      </svg>
                    )}
                  </span>
                )}
                <div className="toast-text">
                  {t.title && <div className="toast-title">{t.title}</div>}
                  {t.message && <div className="toast-message">{t.message}</div>}
                </div>
                <div className="toast-controls">
                  {t.actionLabel && (
                    <button
                      type="button"
                      className="toast-action"
                      onClick={() => {
                        t.onAction?.()
                        startClose(t.id)
                      }}
                    >
                      {t.actionLabel}
                    </button>
                  )}
                  <button type="button" className="toast-close" onClick={() => startClose(t.id)} aria-label="Dismiss">
                    ×
                  </button>
                </div>
              </div>
              <div className="toast-progress-track">
                <div
                  className={`toast-progress-bar toast-progress-${t.variant}`}
                  style={{ animationDuration: `${t.duration}ms` }}
                />
              </div>
            </div>
          ))}
        </div>,
        getFullscreenPortalRoot()
      )}
    </>
  )
}
