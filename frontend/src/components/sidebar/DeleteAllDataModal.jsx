import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useModalLayer } from '../common/useModalLayer'
import { getFullscreenPortalRoot } from '../../utils/fullscreenPortal'
import CustomSelect from '../common/CustomSelect'
import { fetchDeletePreview } from '../../api/roads'

const CONFIRM_WORD = 'DELETE'

function formatStat(sections, segments, totalLengthM) {
  return `${sections.toLocaleString()} section${sections !== 1 ? 's' : ''} · ${segments.toLocaleString()} segment${
    segments !== 1 ? 's' : ''
  } · ${(totalLengthM / 1000).toFixed(1)} km`
}

/**
 * "Delete all data" (optionally scoped to one District) -- a separate,
 * much more guarded flow than single-section delete (SectionSelectPanel's
 * own trash icon), which is untouched by this. Fetches its own preview
 * (counts, per-district breakdown) on mount rather than requiring the
 * caller to have it ready, same self-contained pattern ShareModal uses.
 */
export default function DeleteAllDataModal({ onCancel, onConfirm, deleting }) {
  const [loading, setLoading] = useState(true)
  const [preview, setPreview] = useState(null)
  const [scope, setScope] = useState('all') // 'all' | 'district'
  const [district, setDistrict] = useState('')
  const [downloadBackupFirst, setDownloadBackupFirst] = useState(true)
  const [confirmText, setConfirmText] = useState('')
  const { zIndex, isTop } = useModalLayer()

  useEffect(() => {
    let cancelled = false
    fetchDeletePreview()
      .then((res) => {
        if (cancelled) return
        setPreview(res)
        if (res.districts.length > 0) setDistrict(res.districts[0].deo)
      })
      .catch(() => {
        if (!cancelled) setPreview(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    function handleKeyDown(e) {
      if (!isTop() || deleting) return
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
  }, [deleting])

  if (zIndex == null) return null

  const selectedDistrictStat = scope === 'district' ? preview?.districts.find((d) => d.deo === district) : null
  const canConfirm =
    !loading &&
    !deleting &&
    !!preview &&
    confirmText.trim() === CONFIRM_WORD &&
    (scope === 'all' || !!selectedDistrictStat)

  return createPortal(
    <div
      className="modal-backdrop no-print"
      style={{ zIndex }}
      onMouseDown={(e) => {
        if (deleting) return
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        className="modal-card delete-all-modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-all-modal-title"
      >
        <div className="modal-header">
          <div className="modal-icon modal-icon-danger" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v6M14 11v6"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h3 id="delete-all-modal-title" className="modal-title">
            Delete all road data?
          </h3>
        </div>

        {loading ? (
          <p className="modal-message">Loading…</p>
        ) : !preview || preview.total_sections === 0 ? (
          <p className="modal-message">There's no road data to delete.</p>
        ) : (
          <>
            <p className="delete-all-summary">
              {scope === 'district' && selectedDistrictStat
                ? formatStat(selectedDistrictStat.sections, selectedDistrictStat.segments, selectedDistrictStat.total_length_m)
                : formatStat(preview.total_sections, preview.total_segments, preview.total_length_m)}
            </p>

            <fieldset className="restore-modal-fieldset" disabled={deleting}>
              <div className="delete-all-scope-options" role="radiogroup" aria-label="What to delete">
                <label className="delete-all-scope-option">
                  <input
                    type="radio"
                    name="delete-all-scope"
                    checked={scope === 'all'}
                    onChange={() => setScope('all')}
                  />
                  All data
                </label>
                <label className="delete-all-scope-option">
                  <input
                    type="radio"
                    name="delete-all-scope"
                    checked={scope === 'district'}
                    onChange={() => setScope('district')}
                    disabled={preview.districts.length === 0}
                  />
                  Only one District
                </label>
              </div>

              {scope === 'district' && (
                <CustomSelect
                  size="md"
                  value={district}
                  onChange={setDistrict}
                  disabled={deleting}
                  ariaLabel="District to delete"
                  triggerClassName="delete-all-district-trigger"
                  // The trigger only ever shows the plain district name (full
                  // name truncates with an ellipsis if it's long, with the
                  // untruncated name in a native tooltip -- CustomSelect
                  // already sets title={selected.label}); counts live in the
                  // summary box above instead of being crammed in here too.
                  options={preview.districts.map((d) => ({
                    value: d.deo,
                    label: d.deo,
                    stat: formatStat(d.sections, d.segments, d.total_length_m),
                  }))}
                  getSearchText={(o) => `${o.label} ${o.stat}`}
                  // Wider than the 280px default -- a district name plus its
                  // stat line needs more room to stay readable, clamped to
                  // the viewport regardless (see CustomSelect's own panelWidth).
                  panelWidth={380}
                  renderOption={(o) => (
                    <div className="delete-all-district-option">
                      <span className="delete-all-district-option-name">{o.label}</span>
                      <span className="delete-all-district-option-stat">{o.stat}</span>
                    </div>
                  )}
                />
              )}

              <label className="delete-all-checkbox-row">
                <input
                  type="checkbox"
                  checked={downloadBackupFirst}
                  onChange={(e) => setDownloadBackupFirst(e.target.checked)}
                />
                {scope === 'district' ? 'Download a backup of this District first' : 'Download a backup first'}
              </label>

              <div className="delete-all-confirm-row">
                <label htmlFor="delete-all-confirm-input" className="delete-all-confirm-label">
                  Type <strong>{CONFIRM_WORD}</strong> to confirm
                </label>
                <input
                  id="delete-all-confirm-input"
                  type="text"
                  className="delete-all-confirm-input"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  placeholder={CONFIRM_WORD}
                />
              </div>
            </fieldset>

            {deleting && (
              <p className="restore-progress-row">
                <span className="spinner spinner-dark" aria-hidden="true" />
                Deleting… this can take a moment on the online server.
              </p>
            )}
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="modal-btn modal-btn-cancel" onClick={onCancel} disabled={deleting}>
            Cancel
          </button>
          <button
            type="button"
            className="modal-btn modal-btn-danger"
            disabled={!canConfirm}
            onClick={() => onConfirm({ district: scope === 'district' ? district : null, downloadBackupFirst })}
          >
            {deleting ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </div>,
    getFullscreenPortalRoot()
  )
}
