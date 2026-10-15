import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useModalLayer } from '../common/useModalLayer'
import { getFullscreenPortalRoot } from '../../utils/fullscreenPortal'
import { showToast } from '../common/DialogProvider'
import UploadConflictModal from '../sidebar/UploadConflictModal'
import { commitGuestMerge, discardGuestData, previewGuestMerge } from '../../api/guest'

/**
 * Shown right after a guest with existing data signs in. "Move to my
 * account" reuses UploadConflictModal for the per-road Replace/Keep choice
 * when a guest road_id already exists in the shared workspace -- same
 * component, same decisions shape, as a normal upload conflict.
 */
export default function GuestMergeModal({ onDone }) {
  const [step, setStep] = useState('choice') // 'choice' | 'duplicates' | 'working'
  const [preview, setPreview] = useState(null)
  const cardRef = useRef(null)
  const { zIndex, isTop } = useModalLayer()

  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    function handleKeyDown(e) {
      if (!isTop()) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onDone()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = prevOverflow
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleMoveClick() {
    setStep('working')
    try {
      const res = await previewGuestMerge()
      if (res.duplicates.length > 0) {
        setPreview(res)
        setStep('duplicates')
        return
      }
      await commitGuestMerge({})
      showToast({ variant: 'success', message: 'Guest data moved into your account' })
      onDone()
    } catch (err) {
      showToast({ variant: 'danger', message: `Could not move guest data: ${err.message}` })
      onDone()
    }
  }

  async function handleDiscard() {
    setStep('working')
    try {
      await discardGuestData()
      showToast({ variant: 'info', message: 'Guest data discarded' })
    } catch (err) {
      showToast({ variant: 'danger', message: `Could not discard guest data: ${err.message}` })
    }
    onDone()
  }

  async function handleConflictContinue(decisions) {
    try {
      await commitGuestMerge(decisions)
      showToast({ variant: 'success', message: 'Guest data moved into your account' })
    } catch (err) {
      showToast({ variant: 'danger', message: `Could not move guest data: ${err.message}` })
    }
    onDone()
  }

  if (step === 'duplicates' && preview) {
    return (
      <UploadConflictModal
        duplicates={preview.duplicates}
        newCount={preview.new_roads.length}
        sourceFile="your guest session"
        onCancel={() => setStep('choice')}
        onContinue={handleConflictContinue}
      />
    )
  }

  if (zIndex == null) return null

  return createPortal(
    <div
      className="modal-backdrop no-print"
      style={{ zIndex }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && step !== 'working') onDone()
      }}
    >
      <div
        className="modal-card"
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="guest-merge-title"
      >
        <div className="modal-header">
          <div className="modal-icon modal-icon-warning" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 9v4m0 4h.01M10.3 3.9 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h3 id="guest-merge-title" className="modal-title">
            Keep your guest data?
          </h3>
        </div>
        <p className="modal-message">
          Move the roads you uploaded as a guest into your account, or discard them.
        </p>
        <div className="modal-actions">
          <button
            type="button"
            className="modal-btn modal-btn-cancel"
            onClick={handleDiscard}
            disabled={step === 'working'}
          >
            Discard
          </button>
          <button
            type="button"
            className="modal-btn modal-btn-confirm"
            onClick={handleMoveClick}
            disabled={step === 'working'}
          >
            {step === 'working' ? 'Working…' : 'Move to my account'}
          </button>
        </div>
      </div>
    </div>,
    getFullscreenPortalRoot()
  )
}
