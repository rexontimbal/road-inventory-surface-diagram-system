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
 * Renders docked inside the header (centered on the viewport, overlapping
 * the title/chips if it must) whenever the diagram isn't fullscreen; the
 * centered top stack is used only inside fullscreen, which has no header
 * at all. That choice is made once, when the toast is created.
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
// The countdown ring fades (opacity 1 -> 0.5) over exactly this long, ending
// right as the ring itself finishes -- a fixed-length fade timed via
// animation-delay rather than a keyframe percentage, so it reads as "last
// 1 second" regardless of whether the toast's own duration is 4s or 8s.
const FADE_WARN_MS = 1000

const prefersReducedMotion =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false

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

// r=12 circle in a 28x28 viewBox -- see .toast-pill-ring in App.css, which
// hardcodes the same circumference in its keyframe's "to" value. Change one,
// change both.
const RING_RADIUS = 12
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/**
 * The countdown ring IS the auto-dismiss timer -- `onComplete` (startClose)
 * fires off the ring's own `animationend`, not a parallel setTimeout, so
 * pausing on hover (plain CSS `animation-play-state`, no JS involved) and
 * resuming exactly where it left off are both free: there's no separate
 * clock to keep in sync with the visual. prefers-reduced-motion is the one
 * exception -- animation is suppressed (ring just hidden) so animationend
 * would never fire, and a plain setTimeout stands in for it instead.
 */
function ToastProgressRing({ id, variant, duration, onComplete }) {
  useEffect(() => {
    if (!prefersReducedMotion) return undefined
    const timeoutId = setTimeout(onComplete, duration)
    return () => clearTimeout(timeoutId)
    // onComplete (startClose) is stable in identity terms that matter here --
    // it's keyed by `id`, not a closure over this render's other state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, duration])

  if (prefersReducedMotion) {
    return (
      <svg className="toast-pill-ring" viewBox="0 0 28 28" aria-hidden="true">
        <circle className={`toast-pill-ring-track toast-pill-ring-track-${variant}`} cx="14" cy="14" r={RING_RADIUS} />
      </svg>
    )
  }

  const fadeDelay = Math.max(duration - FADE_WARN_MS, 0)
  return (
    <svg className="toast-pill-ring" viewBox="0 0 28 28" aria-hidden="true">
      <circle className={`toast-pill-ring-track toast-pill-ring-track-${variant}`} cx="14" cy="14" r={RING_RADIUS} />
      <circle
        className={`toast-pill-ring-bar toast-pill-ring-${variant}`}
        cx="14"
        cy="14"
        r={RING_RADIUS}
        strokeDasharray={RING_CIRCUMFERENCE}
        // Longhand properties, NOT the `animation` shorthand -- the
        // shorthand implicitly sets animation-play-state too (default
        // "running"), and an inline style always beats a class selector's
        // animation-play-state regardless of its specificity, which is
        // exactly what made :hover/:focus-within unable to pause this.
        // Leaving animation-play-state out of the inline style entirely
        // lets the CSS hover/focus rule control it normally.
        style={{
          animationName: 'toast-ring-countdown, toast-ring-countdown-fade',
          animationDuration: `${duration}ms, ${FADE_WARN_MS}ms`,
          animationTimingFunction: 'linear, linear',
          animationDelay: `0ms, ${fadeDelay}ms`,
          animationFillMode: 'forwards, forwards',
        }}
        onAnimationEnd={(e) => {
          if (e.animationName === 'toast-ring-countdown') onComplete()
        }}
      />
    </svg>
  )
}

/**
 * The one toast card design, rendered both docked in the header and in the
 * fullscreen top-center stack (see the two createPortal calls below) -- same
 * markup and classes either way, only the portal target differs.
 */
function ToastPill({ toast, onClose }) {
  return (
    <div
      className={`toast-pill toast-pill-${toast.variant}${toast.closing ? ' toast-pill-closing' : ''}`}
      role={toast.variant === 'warning' || toast.variant === 'danger' ? 'alert' : 'status'}
    >
      <div className="toast-pill-icon-wrap">
        {toast.avatarUrl ? (
          <img
            src={toast.avatarUrl}
            alt=""
            className={`toast-pill-avatar toast-pill-avatar-${toast.variant}`}
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className={`toast-pill-icon toast-pill-icon-${toast.variant}`} aria-hidden="true">
            <ToastVariantIcon variant={toast.variant} />
          </span>
        )}
        <ToastProgressRing
          id={toast.id}
          variant={toast.variant}
          duration={toast.duration}
          onComplete={() => onClose(toast.id)}
        />
      </div>
      <span className="toast-pill-text" title={[toast.title, toast.message].filter(Boolean).join(' · ')}>
        {toast.title && <strong>{toast.title}</strong>}
        {toast.title && toast.message && <span className="toast-pill-sep">&middot;</span>}
        {toast.message && <span className="toast-pill-message">{toast.message}</span>}
      </span>
      {toast.actionLabel && (
        <button
          type="button"
          className={`toast-pill-action toast-pill-action-${toast.variant}`}
          onClick={() => {
            toast.onAction?.()
            onClose(toast.id)
          }}
        >
          {toast.actionLabel}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      <button type="button" className="toast-pill-close" onClick={() => onClose(toast.id)} aria-label="Dismiss">
        ×
      </button>
    </div>
  )
}

export default function DialogProvider({ children }) {
  const [confirmState, setConfirmState] = useState(null)
  const [alertState, setAlertState] = useState(null)
  const [toasts, setToasts] = useState([])
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

  useEffect(() => subscribeHeaderToastSlot((el) => {
    headerSlotElRef.current = el
    setHeaderSlotEl(el)
  }), [])

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
      // Always docked in the header outside of fullscreen, at every screen
      // width -- the header-not-mounted-yet fallback to 'stack' is a defensive
      // edge case (toasts fired before Header's registerHeaderToastSlot has
      // run), not a width-based decision anymore.
      const lane = !isFullscreenNow && headerSlotElRef.current ? 'dock' : 'stack'

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
        // cap. The dock lane is a true queue instead -- only the front ever
        // renders (see dockToast below), so the rest just wait their turn,
        // nothing to evict.
        if (lane === 'stack') {
          const stackItems = next.filter((x) => x.lane === 'stack' && !x.closing)
          if (stackItems.length > MAX_VISIBLE_STACK_TOASTS) {
            const evictIds = new Set(stackItems.slice(0, stackItems.length - MAX_VISIBLE_STACK_TOASTS).map((x) => x.id))
            next = next.filter((x) => !evictIds.has(x.id))
          }
        }
        return next
      })
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

  // Two-phase removal: mark "closing" so the exit animation can play, then
  // actually drop it from the array once that animation has had time to
  // finish. Idempotent -- the countdown bar's own animationend can still
  // fire after a manual close (the bar doesn't stop just because React
  // state changed), so a second call for an id that's already gone (or
  // already closing) is a deliberate no-op rather than restarting the
  // removal timer.
  function startClose(id) {
    setToasts((t) => {
      const target = t.find((x) => x.id === id)
      if (!target || target.closing) return t
      return t.map((x) => (x.id === id ? { ...x, closing: true } : x))
    })
    setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id))
    }, EXIT_DURATION_MS)
  }

  // Newest first (top of the stack), capped to the visible window -- the
  // underlying array can briefly exceed MAX_VISIBLE_STACK_TOASTS while an
  // older one is still mid-exit-animation, so this is a render-time slice,
  // not a second cap.
  const stackToasts = toasts.filter((t) => t.lane === 'stack').slice(-MAX_VISIBLE_STACK_TOASTS).reverse()
  // Only the front of the dock queue renders -- including while it's
  // "closing" (mid exit-animation), so the fade-out actually plays instead
  // of the next one popping in underneath it instantly. Mounting IS
  // starting, for the queue: the next toast's countdown bar (and therefore
  // its timer) only begins once it actually becomes this front item.
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

      {dockToast && headerSlotEl && createPortal(<ToastPill toast={dockToast} onClose={startClose} />, headerSlotEl)}

      {createPortal(
        <div className="toast-stack no-print">
          {stackToasts.map((t) => (
            <ToastPill key={t.id} toast={t} onClose={startClose} />
          ))}
        </div>,
        getFullscreenPortalRoot()
      )}
    </>
  )
}
