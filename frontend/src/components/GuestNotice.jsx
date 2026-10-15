import { useEffect, useState } from 'react'
import { fetchGuestStatus } from '../api/guest'

const POLL_MS = 60000

// Rendered in normal document flow (not fixed/sticky) right after the
// header's own spacer -- it must NEVER be position:fixed/sticky itself,
// since that's what would interact with Header's scroll-based shrink
// hysteresis and risk the same flicker bug fixed earlier in this project.
export default function GuestNotice({ isGuest, onSignInClick }) {
  const [status, setStatus] = useState(null)

  useEffect(() => {
    if (!isGuest) {
      setStatus(null)
      return
    }
    let cancelled = false
    function poll() {
      fetchGuestStatus()
        .then((res) => {
          if (!cancelled) setStatus(res)
        })
        .catch(() => {})
    }
    poll()
    // Guest activity (any API call) keeps pushing the expiry forward, so
    // this re-fetches the real expires_at periodically rather than just
    // counting down from one stale value fetched once.
    const id = setInterval(poll, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [isGuest])

  if (!status?.has_data || !status.expires_at) return null

  const minutesLeft = Math.max(0, Math.ceil((new Date(status.expires_at).getTime() - Date.now()) / 60000))
  if (minutesLeft <= 0) return null

  return (
    <div className="guest-notice no-print">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 9v4m0 4h.01M10.3 3.9 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>
        Guest mode: your data will be cleared in {minutesLeft} min{minutesLeft !== 1 ? 's' : ''}.
      </span>
      <button type="button" className="guest-notice-link" onClick={onSignInClick}>
        Sign in
      </button>
      <span>to keep it.</span>
    </div>
  )
}
