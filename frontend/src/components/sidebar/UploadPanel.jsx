import { useEffect, useRef, useState } from 'react'
import { cancelUpload, commitUpload, fetchUploadLog, previewUpload } from '../../api/roads'
import { showToast } from '../common/DialogProvider'
import { readLastSeenLogId } from '../../utils/uploadLogSeen'
import UploadConflictModal from './UploadConflictModal'
import UploadHistoryModal from './UploadHistoryModal'

const AUTO_MINIMIZE_AFTER_UPLOAD_MS = 3000
const AUTO_MINIMIZE_AFTER_VIEW_MS = 5000

const REQUIRED_COLUMNS = [
  'ROAD ID',
  'Road Name',
  'Start Station',
  'End Station',
  'Number of Lanes',
  'Surface type',
  'Shoulder Surface type Left',
  'Shoulder Surface type Right',
]

export default function UploadPanel({ onUploaded, roads, uploadMeta, onExpand }) {
  const fileInputRef = useRef(null)
  const [fileName, setFileName] = useState('')
  const [uploading, setUploading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  // Set only when the preview finds Road-ID conflicts -- holds the preview
  // response + file name until the user resolves the modal (or cancels).
  // Nothing is written to the backend while this is non-null.
  const [pendingConflict, setPendingConflict] = useState(null)
  // Starts collapsed: a fresh in-session upload explicitly expands itself
  // (see the `result`-keyed effect below), but data restored from a page
  // reload must NOT auto-expand or start the auto-minimize timer.
  const [resultExpanded, setResultExpanded] = useState(false)
  const [progressKey, setProgressKey] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [hasUnreadLog, setHasUnreadLog] = useState(false)

  const timerRef = useRef(null)
  const durationRef = useRef(AUTO_MINIMIZE_AFTER_UPLOAD_MS)
  const historyBtnRef = useRef(null)

  function checkUnreadLog() {
    fetchUploadLog({}, 1, 1)
      .then((res) => {
        const latest = res.entries[0]
        setHasUnreadLog(!!latest && String(latest.id) !== readLastSeenLogId())
      })
      .catch(() => {})
  }

  useEffect(() => {
    checkUnreadLog()
  }, [])

  function clearAutoMinimizeTimer() {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  function startAutoMinimizeTimer(duration) {
    clearAutoMinimizeTimer() // never stack two timers
    durationRef.current = duration
    setProgressKey((k) => k + 1) // restarts the CSS progress-bar animation
    timerRef.current = setTimeout(() => setResultExpanded(false), duration)
  }

  useEffect(() => {
    if (!result) return
    setResultExpanded(true)
    startAutoMinimizeTimer(AUTO_MINIMIZE_AFTER_UPLOAD_MS)
    return clearAutoMinimizeTimer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result])

  useEffect(() => clearAutoMinimizeTimer, [])

  // Deleting every road resets the whole upload state -- fileName, result,
  // and the file input itself -- so the same file can be re-uploaded right
  // away without a hard refresh.
  useEffect(() => {
    if (roads && roads.length === 0) {
      setFileName('')
      setResult(null)
      setError('')
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [roads])

  function handleViewDetails() {
    setResultExpanded(true)
    startAutoMinimizeTimer(AUTO_MINIMIZE_AFTER_VIEW_MS)
  }

  function handleMinimize() {
    clearAutoMinimizeTimer()
    setResultExpanded(false)
  }

  function handlePause() {
    clearAutoMinimizeTimer()
  }

  function handleResume() {
    if (resultExpanded) startAutoMinimizeTimer(durationRef.current)
  }

  async function handleFileChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setError('')
    setResult(null)
    setUploading(true)
    try {
      // Parses and validates only -- nothing is saved yet. Road IDs that
      // collide with an existing road come back as `duplicates`; everything
      // else is a clean `new_roads` entry that will just go straight in.
      const preview = await previewUpload(file)
      if (preview.duplicates.length > 0) {
        setPendingConflict({ preview, fileName: file.name })
        setUploading(false)
        return
      }
      await finishUpload(preview.token, {}, file.name)
    } catch (err) {
      setError(err.message)
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function finishUpload(token, decisions, uploadedFileName) {
    setUploading(true)
    try {
      const res = await commitUpload(token, decisions)
      setFileName(uploadedFileName)
      setResult(res)
      onUploaded(res, uploadedFileName)
      const addedCount = res.imported.filter((r) => r.action === 'added').length
      const replacedCount = res.imported.filter((r) => r.action === 'replaced').length
      const skippedCount = res.skipped.length
      const parts = [`${addedCount} added`]
      if (replacedCount > 0) parts.push(`${replacedCount} replaced`)
      if (skippedCount > 0) parts.push(`${skippedCount} skipped`)
      showToast({ variant: 'success', message: `Upload complete: ${parts.join(', ')}` })
      checkUnreadLog()
    } catch (err) {
      setError(err.message)
    } finally {
      setUploading(false)
      setPendingConflict(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  function handleConflictCancel() {
    // Nothing is saved -- the backend only logs that it happened and drops
    // the pending token.
    cancelUpload(pendingConflict.preview.token)
      .then(checkUnreadLog)
      .catch(() => {})
    setPendingConflict(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function handleConflictContinue(decisions) {
    finishUpload(pendingConflict.preview.token, decisions, pendingConflict.fileName)
  }

  // Imported/rejected source: a live in-session upload response has full
  // detail (segment counts, row-level errors). After a reload there's no
  // response to read anymore -- only the lightweight uploadMeta persisted
  // alongside it (fileName/uploadedAt/rejected) -- so the imported list is
  // rebuilt straight from the live `roads` data (segment_count isn't known
  // in that case and is simply omitted from the row).
  const importedSource = result
    ? result.imported
    : uploadMeta
    ? roads.map((r) => ({ road_id: r.road_id, road_name: r.road_name, segment_count: null }))
    : []
  const rejectedSource = result ? result.rejected : uploadMeta?.rejected || []
  const skippedSource = result?.skipped || []

  // Derived from the LIVE roads list, not a stored snapshot -- a road
  // deleted after upload disappears from here immediately, no refresh
  // needed. Rejected roads were never imported, so they're unaffected by
  // deletions and are shown exactly as the upload reported them.
  const visibleImported = importedSource.filter((r) => roads?.some((x) => x.road_id === r.road_id))
  const importedCount = visibleImported.length
  const rejectedCount = rejectedSource.length
  const skippedCount = skippedSource.length
  const hasAnyResultData = importedCount > 0 || rejectedCount > 0 || skippedCount > 0

  // The card can disappear without the user clicking Minimize (e.g. every
  // road from this upload got deleted) -- make sure no timer keeps running
  // in the background pointing at a card that's no longer rendered.
  useEffect(() => {
    if (!hasAnyResultData) clearAutoMinimizeTimer()
  }, [hasAnyResultData])

  const headerIsError = importedCount === 0 && rejectedCount > 0
  let headerText = ''
  if (importedCount > 0 && rejectedCount > 0) {
    headerText = `${importedCount} road${importedCount !== 1 ? 's' : ''} uploaded · ${rejectedCount} rejected`
  } else if (importedCount > 0) {
    headerText = `${importedCount} road${importedCount !== 1 ? 's' : ''} uploaded`
  } else if (rejectedCount > 0) {
    headerText = `${rejectedCount} road${rejectedCount !== 1 ? 's' : ''} rejected`
  } else if (skippedCount > 0) {
    headerText = `${skippedCount} road${skippedCount !== 1 ? 's' : ''} skipped`
  }

  return (
    <div className="panel">
      <button type="button" className="panel-icon" title="Upload Excel File" onClick={onExpand}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 4v10m0-10 4 4m-4-4-4 4M5 18h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div className="panel-body">
      <h2>1. Upload Excel File</h2>
      <button
        className="btn-primary btn-block"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading || !!pendingConflict}
      >
        {uploading ? (
          <>
            <span className="spinner" /> Uploading…
          </>
        ) : (
          <>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 4v10m0-10 4 4m-4-4-4 4M5 18h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Choose Excel File
          </>
        )}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
      <div className="file-name-row">
        {fileName ? (
          <p className="file-name">{fileName}</p>
        ) : uploadMeta ? (
          <p className="file-name file-name-restored">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M14 3v5h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Last file: {uploadMeta.fileName}
          </p>
        ) : (
          <p className="file-name">No file selected</p>
        )}
        {!hasAnyResultData && (
          <button
            type="button"
            ref={historyBtnRef}
            className="history-icon-btn"
            title="Upload history"
            aria-label="Upload history"
            onClick={() => setHistoryOpen(true)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 8v4l3 2M4.6 9A8 8 0 1 1 4 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M4 5v4h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {hasUnreadLog && <span className="history-icon-dot" aria-hidden="true" />}
          </button>
        )}
      </div>

      {error && (
        <div className="feedback-card feedback-critical">
          <span className="feedback-icon" aria-hidden="true">✕</span>
          <div>
            <strong>Upload failed</strong>
            <p>{error}</p>
          </div>
        </div>
      )}

      {hasAnyResultData && (
        <div
          className="upload-summary-card"
          onMouseEnter={handlePause}
          onMouseLeave={handleResume}
          onFocus={handlePause}
          onBlur={handleResume}
        >
          <div className="upload-summary-header">
            <div className="upload-summary-header-left">
              <span
                className={`upload-summary-icon ${headerIsError ? 'upload-summary-icon-critical' : 'upload-summary-icon-good'}`}
                aria-hidden="true"
              >
                {headerIsError ? '✕' : '✓'}
              </span>
              <span className="upload-summary-title">{headerText}</span>
            </div>
            <button
              type="button"
              className="upload-summary-toggle"
              onClick={resultExpanded ? handleMinimize : handleViewDetails}
            >
              {resultExpanded ? 'Minimize ▴' : 'View details ▾'}
            </button>
            <button
              type="button"
              ref={historyBtnRef}
              className="history-icon-btn"
              title="Upload history"
              aria-label="Upload history"
              onClick={() => setHistoryOpen(true)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 8v4l3 2M4.6 9A8 8 0 1 1 4 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 5v4h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {hasUnreadLog && <span className="history-icon-dot" aria-hidden="true" />}
            </button>
          </div>

          <div className={`upload-summary-body${resultExpanded ? ' upload-summary-body-open' : ''}`}>
            <div className="upload-summary-body-inner thin-scroll">
              {importedCount > 0 && (
                <ul className="upload-summary-list">
                  {visibleImported.map((r) => (
                    <li key={r.road_id} className="upload-summary-row">
                      <div className="upload-summary-row-top">
                        <span className="mono">{r.road_id}</span>
                        <span className="upload-summary-row-right">
                          {r.action && (
                            <span className={`upload-summary-badge upload-summary-badge-${r.action}`}>
                              {r.action === 'replaced' ? 'Replaced' : r.action === 'up_to_date' ? 'Up to date' : 'Added'}
                            </span>
                          )}
                          {r.segment_count != null && (
                            <span className="upload-summary-count">
                              {r.segment_count} segment{r.segment_count !== 1 ? 's' : ''}
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="upload-summary-road-name">{r.road_name}</div>
                    </li>
                  ))}
                </ul>
              )}

              {skippedCount > 0 && (
                <ul className="upload-summary-list" style={importedCount > 0 ? { marginTop: 12 } : undefined}>
                  {skippedSource.map((r) => (
                    <li key={r.road_id} className="upload-summary-row">
                      <div className="upload-summary-row-top">
                        <span className="mono">{r.road_id}</span>
                        <span className="upload-summary-badge upload-summary-badge-skipped">Skipped</span>
                      </div>
                      <div className="upload-summary-road-name">{r.road_name} &middot; kept existing data</div>
                    </li>
                  ))}
                </ul>
              )}

              {rejectedCount > 0 && (
                <div
                  className="feedback-card feedback-critical"
                  style={importedCount > 0 || skippedCount > 0 ? { marginTop: 12 } : undefined}
                >
                  <span className="feedback-icon" aria-hidden="true">✕</span>
                  <div className="feedback-body">
                    <strong>{rejectedCount} road{rejectedCount !== 1 ? 's' : ''} rejected — not uploaded</strong>
                    {rejectedSource.map((r) => (
                      <details key={r.road_id} className="rejected-detail">
                        <summary>
                          <span className="mono">{r.road_id}</span> — {r.errors.length} error{r.errors.length !== 1 ? 's' : ''}
                        </summary>
                        <ul>
                          {r.errors.map((e, i) => (
                            <li key={i}>Row {e.row} ({e.field}): {e.message}</li>
                          ))}
                        </ul>
                      </details>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {resultExpanded && (
            <div className="upload-summary-progress-track">
              <div
                key={progressKey}
                className="upload-summary-progress-bar"
                style={{ animationDuration: `${durationRef.current}ms` }}
              />
            </div>
          )}
        </div>
      )}

      <div className="required-columns">
        <p>Required columns:</p>
        <ul>
          {REQUIRED_COLUMNS.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </div>
      </div>

      {pendingConflict && (
        <UploadConflictModal
          duplicates={pendingConflict.preview.duplicates}
          newCount={pendingConflict.preview.new_roads.length}
          sourceFile={pendingConflict.fileName}
          onCancel={handleConflictCancel}
          onContinue={handleConflictContinue}
        />
      )}

      {historyOpen && (
        <UploadHistoryModal
          onClose={() => {
            setHistoryOpen(false)
            setHasUnreadLog(false)
          }}
          triggerRef={historyBtnRef}
        />
      )}
    </div>
  )
}
