import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { cancelUpload, commitUpload, fetchUploadLog, previewUpload } from '../../api/roads'
import { commitRestore, exportBackup, previewRestore } from '../../api/backup'
import { showAlert, showToast } from '../common/DialogProvider'
import { readLastSeenLogId } from '../../utils/uploadLogSeen'
import UploadConflictModal from './UploadConflictModal'
import UploadHistoryModal from './UploadHistoryModal'
import RestoreBackupModal from './RestoreBackupModal'

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

const UploadPanel = forwardRef(function UploadPanel({ onUploaded, onRestored, roads, uploadMeta, onExpand }, ref) {
  const fileInputRef = useRef(null)
  const restoreInputRef = useRef(null)
  const [fileName, setFileName] = useState('')
  const [uploading, setUploading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [backingUp, setBackingUp] = useState(false)
  const [pendingRestore, setPendingRestore] = useState(null)
  const persistRequestedRef = useRef(false)
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

  // Exposes a couple of actions to App.jsx's global keyboard shortcuts (U,
  // H) without threading extra props down -- App.jsx can't otherwise reach
  // this panel's own file input / history-modal state.
  useImperativeHandle(ref, () => ({
    openFilePicker: () => fileInputRef.current?.click(),
    openHistory: () => setHistoryOpen(true),
  }))

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

  function requestPersistentStorageOnce() {
    if (persistRequestedRef.current) return
    persistRequestedRef.current = true
    if (navigator.storage?.persist) {
      navigator.storage
        .persisted()
        .then((already) => (already ? true : navigator.storage.persist()))
        .then((granted) => console.log(`Persistent storage: ${granted ? 'granted' : 'not granted'}`))
        .catch(() => {})
    }
  }

  async function handleBackup() {
    setBackingUp(true)
    try {
      const backup = await exportBackup()
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
      const now = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      const filename = `road-inventory-backup_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.json`
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      showToast({
        variant: 'success',
        message: `Backup saved (${backup.counts.roads} road${backup.counts.roads !== 1 ? 's' : ''}, ${backup.counts.segments.toLocaleString()} segments)`,
      })
    } catch (err) {
      showToast({ variant: 'danger', message: `Backup failed: ${err.message}` })
    } finally {
      setBackingUp(false)
    }
  }

  async function handleRestoreFileChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      let backup
      try {
        backup = JSON.parse(text)
      } catch {
        throw new Error('This file is not valid JSON.')
      }
      if (backup.app_name !== 'road-inventory-surface-diagram-system') {
        throw new Error('This file is not a Road Inventory & Surface Diagram backup.')
      }
      const preview = await previewRestore(backup)
      setPendingRestore({ preview })
    } catch (err) {
      await showAlert({ title: 'Could not read backup file', message: err.message, variant: 'danger' })
    } finally {
      if (restoreInputRef.current) restoreInputRef.current.value = ''
    }
  }

  function handleRestoreCancel() {
    setPendingRestore(null)
  }

  async function handleRestoreContinue(mode, decisions) {
    try {
      const res = await commitRestore(pendingRestore.preview.token, mode, decisions)
      setPendingRestore(null)
      onRestored()
      checkUnreadLog()
      const parts = [`${res.added} added`]
      if (res.replaced > 0) parts.push(`${res.replaced} replaced`)
      if (res.kept > 0) parts.push(`${res.kept} kept`)
      showToast({ variant: 'success', message: `Restore complete: ${parts.join(', ')}` })
    } catch (err) {
      showToast({ variant: 'danger', message: `Restore failed: ${err.message}` })
    }
  }

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
      requestPersistentStorageOnce()
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

      <div className="backup-actions">
        <button type="button" className="btn-compact" onClick={handleBackup} disabled={backingUp}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 16V4m0 12-4-4m4 4 4-4M4 18v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {backingUp ? 'Backing up…' : 'Backup data'}
        </button>
        <button type="button" className="btn-compact" onClick={() => restoreInputRef.current?.click()}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 4v12m0-12-4 4m4-4 4 4M4 18v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Restore backup
        </button>
        <input
          ref={restoreInputRef}
          type="file"
          accept=".json"
          style={{ display: 'none' }}
          onChange={handleRestoreFileChange}
        />
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

      {pendingRestore && (
        <RestoreBackupModal
          preview={pendingRestore.preview}
          onCancel={handleRestoreCancel}
          onContinue={handleRestoreContinue}
        />
      )}
    </div>
  )
})

export default UploadPanel
