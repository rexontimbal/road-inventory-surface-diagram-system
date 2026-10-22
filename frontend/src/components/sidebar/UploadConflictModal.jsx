import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useModalLayer } from '../common/useModalLayer'
import { getFullscreenPortalRoot } from '../../utils/fullscreenPortal'

function formatDate(iso) {
  if (!iso) return 'unknown date'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown date'
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * Shown when an upload contains Section IDs that already exist. Nothing is
 * saved until the user picks Replace/Keep per section (or bulk) and clicks
 * Continue -- Cancel discards the whole upload, including any brand-new
 * sections that had no conflict.
 *
 * `committing` is true for the whole span of the onContinue() call -- a
 * large file (the real DPWH template runs to ~11,200 rows) can take tens of
 * seconds against the live (Postgres/Neon) deployment, so every control is
 * disabled for that span and Escape/backdrop-click can't close the modal,
 * instead of leaving a single-use upload token re-clickable while its first
 * commit is still running server-side.
 */
export default function UploadConflictModal({ duplicates, newCount, sourceFile, committing, onCancel, onContinue }) {
  const [decisions, setDecisions] = useState(() =>
    Object.fromEntries(duplicates.map((d) => [d.section_id, 'keep']))
  )
  const cardRef = useRef(null)
  const { zIndex, isTop } = useModalLayer()

  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    function handleKeyDown(e) {
      if (!isTop() || committing) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = prevOverflow
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committing])

  function setDecision(sectionId, value) {
    setDecisions((prev) => ({ ...prev, [sectionId]: value }))
  }

  function setAll(value) {
    setDecisions(Object.fromEntries(duplicates.map((d) => [d.section_id, value])))
  }

  const title =
    duplicates.length === 1 ? 'Section ID already exists' : `${duplicates.length} Section IDs already exist`

  if (zIndex == null) return null

  return createPortal(
    <div
      className="modal-backdrop no-print"
      style={{ zIndex }}
      onMouseDown={(e) => {
        if (committing) return
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="modal-card conflict-modal-card" ref={cardRef} role="dialog" aria-modal="true" aria-labelledby="conflict-modal-title">
        <div className="modal-header">
          <div className="modal-icon modal-icon-warning" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 9v4m0 4h.01M10.3 3.9 2.6 17.5a1.5 1.5 0 0 0 1.3 2.3h16.2a1.5 1.5 0 0 0 1.3-2.3L13.7 3.9a1.5 1.5 0 0 0-2.6 0Z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h3 id="conflict-modal-title" className="modal-title">
            {title}
          </h3>
        </div>
        <p className="modal-message">
          {newCount > 0 && (
            <>
              {newCount} new road{newCount !== 1 ? 's' : ''} will be added automatically.{' '}
            </>
          )}
          Choose what to do with the road{duplicates.length !== 1 ? 's' : ''} below before continuing.
        </p>

        <fieldset className="restore-modal-fieldset" disabled={committing}>
          {duplicates.length > 1 && (
            <div className="conflict-bulk-actions">
              <button type="button" className="btn-link" onClick={() => setAll('replace')}>
                Replace all
              </button>
              <span className="conflict-bulk-sep">·</span>
              <button type="button" className="btn-link" onClick={() => setAll('keep')}>
                Keep all existing
              </button>
            </div>
          )}

          <div className="conflict-list thin-scroll">
            {duplicates.map((d) => (
              <div key={d.section_id} className="conflict-row">
                <div className="conflict-row-head">
                  <span className="mono conflict-road-id">{d.section_id}</span>
                  <span className="conflict-road-name">{d.new_road_name}</span>
                </div>
                {d.name_changed && (
                  <p className="conflict-name-changed">
                    Name changed: {d.existing_road_name} → {d.new_road_name}
                  </p>
                )}
                <div className="conflict-compare">
                  <div className="conflict-compare-col">
                    <span className="conflict-compare-label">Existing</span>
                    <span className="conflict-compare-stats">
                      {d.existing_segment_count} segment{d.existing_segment_count !== 1 ? 's' : ''} ·{' '}
                      {(d.existing_total_length_m / 1000).toFixed(1)} km
                    </span>
                    <span className="conflict-compare-muted">
                      Uploaded {formatDate(d.existing_updated_at)}
                      {d.existing_source_file ? ` · ${d.existing_source_file}` : ''}
                    </span>
                  </div>
                  <div className="conflict-compare-col">
                    <span className="conflict-compare-label">New</span>
                    <span className="conflict-compare-stats">
                      {d.new_segment_count} segment{d.new_segment_count !== 1 ? 's' : ''} ·{' '}
                      {(d.new_total_length_m / 1000).toFixed(1)} km
                    </span>
                    <span className="conflict-compare-muted">from {sourceFile}</span>
                  </div>
                </div>
                <div className="conflict-toggle" role="group" aria-label={`Choice for ${d.section_id}`}>
                  <button
                    type="button"
                    className={`conflict-toggle-btn${decisions[d.section_id] === 'replace' ? ' conflict-toggle-btn-active' : ''}`}
                    aria-pressed={decisions[d.section_id] === 'replace'}
                    onClick={() => setDecision(d.section_id, 'replace')}
                  >
                    Replace
                  </button>
                  <button
                    type="button"
                    className={`conflict-toggle-btn${decisions[d.section_id] === 'keep' ? ' conflict-toggle-btn-active' : ''}`}
                    aria-pressed={decisions[d.section_id] === 'keep'}
                    onClick={() => setDecision(d.section_id, 'keep')}
                  >
                    Keep existing
                  </button>
                </div>
              </div>
            ))}
          </div>
        </fieldset>

        {committing && (
          <p className="restore-progress-row">
            <span className="spinner spinner-dark" aria-hidden="true" />
            Uploading… this can take up to a minute on the online server.
          </p>
        )}

        <div className="modal-actions">
          <button type="button" className="modal-btn modal-btn-cancel" onClick={onCancel} disabled={committing}>
            Cancel upload
          </button>
          <button
            type="button"
            className="modal-btn modal-btn-confirm"
            onClick={() => onContinue(decisions)}
            disabled={committing}
          >
            {committing ? 'Uploading…' : 'Continue'}
          </button>
        </div>
      </div>
    </div>,
    getFullscreenPortalRoot()
  )
}
