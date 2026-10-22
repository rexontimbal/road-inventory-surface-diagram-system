import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useModalLayer } from '../common/useModalLayer'
import { getFullscreenPortalRoot } from '../../utils/fullscreenPortal'

function formatDateTime(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

function n(count) {
  return count.toLocaleString()
}

// backup.roads carries each section's own total_length_m -- the preview
// response itself only has counts (roads/segments/logs), so the km figure
// shown in this modal is derived client-side from the full parsed backup
// file already sitting in memory, not from a backend field.
function backupTotalKm(backup) {
  if (!backup?.roads) return null
  const totalM = backup.roads.reduce((sum, r) => sum + (r.total_length_m || 0), 0)
  return (totalM / 1000).toFixed(1)
}

/**
 * Shown after a backup .json file has been picked and previewed against
 * the backend. Nothing is applied until Continue -- the user first picks
 * Replace all vs Merge, then (for Merge, if there are Section-ID conflicts)
 * the same per-section Replace/Keep choice as a normal upload conflict.
 *
 * When the active workspace is already empty there's nothing to merge or
 * replace -- conflicts are impossible -- so a single "Restore backup?"
 * confirmation replaces the Merge/Replace-all choice and goes straight to
 * a full restore (mode 'merge' with no decisions behaves identically to
 * 'replace_all' when nothing existing can conflict).
 */
export default function RestoreBackupModal({ preview, backup, onCancel, onContinue }) {
  const isEmptyWorkspace = preview.current_counts.roads === 0
  const [mode, setMode] = useState('merge')
  const [decisions, setDecisions] = useState(() =>
    Object.fromEntries(preview.duplicates.map((d) => [d.section_id, 'keep']))
  )
  const cardRef = useRef(null)
  const { zIndex, isTop } = useModalLayer()

  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    function handleKeyDown(e) {
      if (!isTop()) return
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
  }, [])

  function setDecision(sectionId, value) {
    setDecisions((prev) => ({ ...prev, [sectionId]: value }))
  }

  function setAll(value) {
    setDecisions(Object.fromEntries(preview.duplicates.map((d) => [d.section_id, value])))
  }

  const showDuplicates = !isEmptyWorkspace && mode === 'merge' && preview.duplicates.length > 0
  const km = backupTotalKm(backup)

  if (zIndex == null) return null

  if (isEmptyWorkspace) {
    const sections = preview.backup_counts.roads
    const segments = preview.backup_counts.segments
    return createPortal(
      <div
        className="modal-backdrop no-print"
        style={{ zIndex }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onCancel()
        }}
      >
        <div
          className="modal-card restore-modal-card"
          ref={cardRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="restore-modal-title"
        >
          <div className="modal-header">
            <div className="modal-icon modal-icon-info" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 8v4l3 2M4.6 9A8 8 0 1 1 4 13"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path d="M4 5v4h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <h3 id="restore-modal-title" className="modal-title">
              Restore backup?
            </h3>
          </div>
          <p className="modal-message">
            Backup from {formatDateTime(preview.backup_exported_at)} · {n(sections)} section{sections !== 1 ? 's' : ''} ·{' '}
            {n(segments)} segment{segments !== 1 ? 's' : ''}
            {km != null ? ` · ${km} km` : ''}. Your workspace is currently empty.
          </p>
          <div className="modal-actions">
            <button type="button" className="modal-btn modal-btn-cancel" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="modal-btn modal-btn-confirm" onClick={() => onContinue('merge', {})}>
              Restore
            </button>
          </div>
        </div>
      </div>,
      getFullscreenPortalRoot()
    )
  }

  return createPortal(
    <div
      className="modal-backdrop no-print"
      style={{ zIndex }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        className="modal-card conflict-modal-card restore-modal-card"
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="restore-modal-title"
      >
        <div className="modal-header">
          <div className="modal-icon modal-icon-info" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 8v4l3 2M4.6 9A8 8 0 1 1 4 13"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path d="M4 5v4h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <h3 id="restore-modal-title" className="modal-title">
            Restore from backup
          </h3>
        </div>
        <p className="modal-message">
          Backup from {formatDateTime(preview.backup_exported_at)} · {n(preview.backup_counts.roads)} section
          {preview.backup_counts.roads !== 1 ? 's' : ''} · {n(preview.backup_counts.segments)} segments
          {km != null ? ` · ${km} km` : ''}. Currently in the workspace: {n(preview.current_counts.roads)} section
          {preview.current_counts.roads !== 1 ? 's' : ''} · {n(preview.current_counts.segments)} segments.
        </p>

        <div className="restore-mode-row">
          <button
            type="button"
            className={`restore-mode-card${mode === 'merge' ? ' restore-mode-card-active' : ''}`}
            onClick={() => setMode('merge')}
          >
            <strong>Merge</strong>
            <span>Add backup sections; choose what to do with Section IDs that already exist.</span>
          </button>
          <button
            type="button"
            className={`restore-mode-card restore-mode-card-danger${mode === 'replace_all' ? ' restore-mode-card-active' : ''}`}
            onClick={() => setMode('replace_all')}
          >
            <strong>Replace all data</strong>
            <span>Current data is fully replaced by the backup. Cannot be undone.</span>
          </button>
        </div>

        {showDuplicates && (
          <>
            {preview.duplicates.length > 1 && (
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
              {preview.duplicates.map((d) => (
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
                    </div>
                    <div className="conflict-compare-col">
                      <span className="conflict-compare-label">In backup</span>
                      <span className="conflict-compare-stats">
                        {d.new_segment_count} segment{d.new_segment_count !== 1 ? 's' : ''} ·{' '}
                        {(d.new_total_length_m / 1000).toFixed(1)} km
                      </span>
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
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="modal-btn modal-btn-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`modal-btn ${mode === 'replace_all' ? 'modal-btn-danger' : 'modal-btn-confirm'}`}
            onClick={() => onContinue(mode, decisions)}
          >
            {mode === 'replace_all' ? 'Replace all data' : 'Continue'}
          </button>
        </div>
      </div>
    </div>,
    getFullscreenPortalRoot()
  )
}
