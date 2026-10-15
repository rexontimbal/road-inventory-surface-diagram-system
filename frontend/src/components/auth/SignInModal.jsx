import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useModalLayer } from '../common/useModalLayer'
import { getFullscreenPortalRoot } from '../../utils/fullscreenPortal'
import GoogleSignInButton from './GoogleSignInButton'

const NOT_ALLOWED_MESSAGE = "This account isn't allowed yet. Please contact the administrator."

/**
 * The real Google button lives INSIDE this modal (Google's branding
 * guidelines require using their rendered button as-is), not directly in
 * the header -- the header only shows a restyled trigger that opens this.
 */
export default function SignInModal({ onClose, onCredential }) {
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState(null)
  const cardRef = useRef(null)
  const firstFocusableRef = useRef(null)
  const { zIndex, isTop } = useModalLayer()

  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    firstFocusableRef.current?.focus()

    function handleKeyDown(e) {
      if (!isTop()) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = prevOverflow
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleCredential(idToken) {
    setVerifying(true)
    setError(null)
    try {
      await onCredential(idToken)
      onClose()
    } catch (err) {
      // The one real-world case this hits most is Google's OAuth consent
      // screen still being in "Testing" mode, where only explicitly added
      // test users can complete sign-in -- but our backend can't actually
      // tell that apart from other verification failures, so the same
      // friendly message covers both rather than showing a raw error to a
      // non-technical office user.
      console.error('Google sign-in rejected:', err)
      setError(NOT_ALLOWED_MESSAGE)
      setVerifying(false)
    }
  }

  function handleGoogleError(message) {
    setError(message)
    setVerifying(false)
  }

  if (zIndex == null) return null

  return createPortal(
    <div
      className="modal-backdrop no-print"
      style={{ zIndex }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !verifying) onClose()
      }}
    >
      <div
        className="modal-card signin-modal-card"
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="signin-modal-title"
      >
        <div className="modal-header">
          <div className="modal-icon modal-icon-info" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4Z"
                fill="currentColor"
              />
            </svg>
          </div>
          <h3 id="signin-modal-title" className="modal-title">
            Sign in to save your work
          </h3>
          <button
            type="button"
            ref={firstFocusableRef}
            className="history-modal-close"
            onClick={onClose}
            aria-label="Close"
            title="Close"
            disabled={verifying}
          >
            ×
          </button>
        </div>

        <p className="modal-message">
          Guest data is deleted after 15 minutes. Sign in with Google to keep your roads and track your changes.
        </p>

        {error && <p className="signin-modal-error">{error}</p>}

        <div className="signin-modal-google-wrap">
          {verifying ? (
            <div className="signin-modal-verifying">
              <span className="signin-modal-spinner" /> Signing in…
            </div>
          ) : (
            <GoogleSignInButton onCredential={handleCredential} onError={handleGoogleError} />
          )}
        </div>

        <p className="signin-modal-note">We only use your name, email, and profile photo.</p>
      </div>
    </div>,
    getFullscreenPortalRoot()
  )
}
