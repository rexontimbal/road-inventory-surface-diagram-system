import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Modal from './Modal'
import { getFullscreenPortalRoot } from '../../utils/fullscreenPortal'
import { subscribeHeaderToastSlot } from '../../utils/headerToastSlot'

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
 * Shows a toast. variant: 'success' | 'danger' | 'warning' | 'info'. `title`
 * defaults from variant when omitted -- every existing call site that only
 * passes `message` keeps working unchanged, it just becomes the secondary
 * line under the (now-required-looking) title. `avatarUrl` swaps the
 * variant icon for a round avatar (used for share notifications).
 *
 * Renders docked inside the header's own free space (between the title and
 * the right-side buttons) when there's room for it and the diagram isn't
 * fullscreen; otherwise falls back to the centered stack below the header
 * (also always used inside fullscreen, which has no header at all). That
 * choice is made once, when the toast is created.
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

const MAX_VISIBLE_STACK_TOASTS = 3
const EXIT_DURATION_MS = 180
// Below this, the header's free space is too cramped for even the compact
// one-line card -- falls back to the normal centered stack instead.
const HEADER_SLOT_MIN_PX = 280

function ToastVariantIcon({ variant }) {
  if (variant === 'success') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
        <path d="m5 13 4 4 10-10" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (variant === 'warning') {
    return (
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
    )
  }
  if (variant === 'danger') {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
        <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 11v5.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="7.8" r="1.1" fill="currentColor" />
    </svg>
  )
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

  // The header's toast slot (see utils/headerToastSlot.js) -- both a ref
  // (so _toastHandler's one-time closure can read the CURRENT value when
  // deciding where a new toast should go) and state (so the portal target
  // in the JSX below actually re-renders when it changes).
  const [headerSlotEl, setHeaderSlotEl] = useState(null)
  const headerSlotElRef = useRef(null)
  const [headerSlotWidth, setHeaderSlotWidth] = useState(0)
  const headerSlotWidthRef = useRef(0)

  useEffect(() => subscribeHeaderToastSlot((el) => {
    headerSlotElRef.current = el
    setHeaderSlotEl(el)
  }), [])

  useEffect(() => {
    if (!headerSlotEl) {
      headerSlotWidthRef.current = 0
      setHeaderSlotWidth(0)
      return
    }
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width ?? 0
      headerSlotWidthRef.current = w
      setHeaderSlotWidth(w)
    })
    ro.observe(headerSlotEl)
    return () => ro.disconnect()
  }, [headerSlotEl])

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
      const isFullscreenNow = !!(document.fullscreenElement || document.webkitFullscreenElement)
      const lane =
        !isFullscreenNow && headerSlotElRef.current && headerSlotWidthRef.current >= HEADER_SLOT_MIN_PX ? 'dock' : 'stack'

      // Dedupe against whatever's already pending IN THE SAME LANE -- a
      // caller that fires the same failure 2-3 times in a row (a double-
      // click, a retry, the same error surfacing from more than one place)
      // shows ONE toast, not a stack/queue of identical ones.
      const title = opts.title ?? DEFAULT_TITLES[variant]
      const isDuplicate = toastsRef.current.some(
        (t) => t.lane === lane && !t.closing && t.variant === variant && t.message === opts.message && t.title === title
      )
      if (isDuplicate) return

      const id = `${Date.now()}-${Math.random()}`
      const duration = opts.duration ?? DEFAULT_DURATIONS[variant] ?? 4000
      const toast = {
        id,
        lane,
        variant,
        title,
        message: opts.message,
        actionLabel: opts.actionLabel,
        onAction: opts.onAction,
        avatarUrl: opts.avatarUrl,
        duration,
        closing: false,
      }

      setToasts((t) => {
        let next = [...t, toast]
        // The stack lane keeps its existing "max 3 visible, oldest dropped"
        // cap. The dock lane is a true queue instead (only one toast is
        // ever shown there at a time -- see the effect below -- so nothing
        // needs to be evicted; it just waits its turn).
        if (lane === 'stack') {
          const stackItems = next.filter((x) => x.lane === 'stack' && !x.closing)
          if (stackItems.length > MAX_VISIBLE_STACK_TOASTS) {
            const evictIds = new Set(stackItems.slice(0, stackItems.length - MAX_VISIBLE_STACK_TOASTS).map((x) => x.id))
            for (const evictId of evictIds) clearToastTimer(evictId)
            next = next.filter((x) => !evictIds.has(x.id))
          }
        }
        return next
      })

      // Stack-lane toasts start their countdown immediately, same as
      // before. Dock-lane toasts only start once they actually become the
      // visible one -- see the queue-advance effect below -- so a toast
      // waiting behind another doesn't silently burn through its own
      // duration before anyone's seen it.
      if (lane === 'stack') scheduleToastDismiss(id, duration)
    }
    return () => {
      _confirmHandler = null
      _alertHandler = null
      _toastHandler = null
    }
  }, [])

  // Advances the dock queue: whenever the front dock-lane toast changes
  // (a new one arrives with nothing ahead of it, or the previous front one
  // finishes closing and is removed), start its timer if that hasn't
  // happened yet. toastTimers already having an entry for it is the signal
  // "already started" -- covers both cases without tracking a separate flag.
  useEffect(() => {
    const frontDock = toasts.find((t) => t.lane === 'dock' && !t.closing)
    if (frontDock && !toastTimers.current.has(frontDock.id)) {
      scheduleToastDismiss(frontDock.id, frontDock.duration)
    }
  }, [toasts])

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
  // underlying array can briefly exceed MAX_VISIBLE_STACK_TOASTS while an
  // older one is still mid-exit-animation, so this is a render-time slice,
  // not a second cap.
  const stackToasts = toasts.filter((t) => t.lane === 'stack').slice(-MAX_VISIBLE_STACK_TOASTS).reverse()
  // Only the front of the dock queue renders -- including while it's
  // "closing" (mid exit-animation), so the fade-out actually plays instead
  // of the next one popping in underneath it instantly.
  const dockToast = toasts.find((t) => t.lane === 'dock')

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

      {dockToast &&
        headerSlotEl &&
        createPortal(
          <div
            className={`header-toast toast-${dockToast.variant}${dockToast.closing ? ' header-toast-closing' : ''}`}
            role={dockToast.variant === 'warning' || dockToast.variant === 'danger' ? 'alert' : 'status'}
            onMouseEnter={() => pauseToast(dockToast.id)}
            onMouseLeave={() => resumeToast(dockToast.id)}
            onFocus={() => pauseToast(dockToast.id)}
            onBlur={() => resumeToast(dockToast.id)}
          >
            <div className="header-toast-row">
              {dockToast.avatarUrl ? (
                <img src={dockToast.avatarUrl} alt="" className="header-toast-avatar" referrerPolicy="no-referrer" />
              ) : (
                <span className={`header-toast-icon toast-icon-${dockToast.variant}`} aria-hidden="true">
                  <ToastVariantIcon variant={dockToast.variant} />
                </span>
              )}
              <span className="header-toast-text">
                {dockToast.title && <strong>{dockToast.title}</strong>}
                {dockToast.title && dockToast.message && <span className="header-toast-text-sep"> &middot; </span>}
                {dockToast.message && <span className="header-toast-message">{dockToast.message}</span>}
              </span>
              <div className="header-toast-controls">
                {dockToast.actionLabel && (
                  <button
                    type="button"
                    className="toast-action"
                    onClick={() => {
                      dockToast.onAction?.()
                      startClose(dockToast.id)
                    }}
                  >
                    {dockToast.actionLabel}
                  </button>
                )}
                <button type="button" className="toast-close" onClick={() => startClose(dockToast.id)} aria-label="Dismiss">
                  ×
                </button>
              </div>
            </div>
            <div className="toast-progress-track">
              <div
                className={`toast-progress-bar toast-progress-${dockToast.variant}`}
                style={{ animationDuration: `${dockToast.duration}ms` }}
              />
            </div>
          </div>,
          headerSlotEl
        )}

      {createPortal(
        <div className="toast-stack no-print">
          {stackToasts.map((t) => (
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
                    <ToastVariantIcon variant={t.variant} />
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
