import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { cancelUpload, commitUpload, fetchUploadLog, previewUpload } from '../../api/roads'
import { commitRestore, exportBackup, previewRestore } from '../../api/backup'
import { showAlert, showToast } from '../common/DialogProvider'
import { readLastSeenLogId } from '../../utils/uploadLogSeen'
import UploadConflictModal from './UploadConflictModal'
import UploadHistoryModal from './UploadHistoryModal'
import RestoreBackupModal from './RestoreBackupModal'

const REQUIRED_COLUMNS_AUTO_HIDE_MS = 10000

const REQUIRED_COLUMNS = [
  'Section ID',
  'Classification',
  'DEO',
  'LD',
  'Road Name',
  'Start',
  'End',
  'Number of Lanes',
  'Surface type',
  'LEFT',
  'RIGHT',
]

// Builds the post-upload toast's variant + message from a commitUpload()
// result. A single outcome bucket (e.g. everything just "added") reads as
// the short "N roads uploaded"; a mix of added/replaced/up-to-date/kept
// gets the itemized "Upload complete: ..." form instead. Warnings (gaps,
// irregular km posts, blank shoulders -- imported anyway) are appended as
// one grouped-by-type summary, never one line per row -- full detail lives
// in Upload History's expanded view instead.
function buildUploadToast(res) {
  const addedCount = res.imported.filter((r) => r.action === 'added').length
  const replacedCount = res.imported.filter((r) => r.action === 'replaced').length
  const upToDateCount = res.imported.filter((r) => r.action === 'up_to_date').length
  const keptCount = res.skipped.length
  const rejectedCount = res.rejected.length
  const successCount = addedCount + replacedCount + upToDateCount + keptCount

  const warningSuffix =
    res.warning_groups?.length > 0 ? ` (${res.warning_groups.map((g) => `${g.count} ${g.label}`).join(' · ')})` : ''

  if (successCount === 0 && rejectedCount > 0) {
    return {
      variant: 'danger',
      message: `Upload failed: ${rejectedCount} section${rejectedCount !== 1 ? 's' : ''} rejected`,
    }
  }

  const parts = []
  if (addedCount > 0) parts.push(`${addedCount} added`)
  if (replacedCount > 0) parts.push(`${replacedCount} replaced`)
  if (upToDateCount > 0) parts.push(`${upToDateCount} up to date`)
  if (keptCount > 0) parts.push(`${keptCount} kept`)

  if (rejectedCount > 0) {
    return {
      variant: 'warning',
      message: `${successCount} section${successCount !== 1 ? 's' : ''} uploaded · ${rejectedCount} rejected${warningSuffix}`,
    }
  }
  if (parts.length <= 1) {
    return {
      variant: res.warning_groups?.length > 0 ? 'warning' : 'success',
      message: `${successCount} section${successCount !== 1 ? 's' : ''} uploaded${warningSuffix}`,
    }
  }
  return {
    variant: res.warning_groups?.length > 0 ? 'warning' : 'success',
    message: `Upload complete: ${parts.join(', ')}${warningSuffix}`,
  }
}

const UploadPanel = forwardRef(function UploadPanel({ onUploaded, onRestored, roads, uploadMeta, onExpand }, ref) {
  const fileInputRef = useRef(null)
  const restoreInputRef = useRef(null)
  const [fileName, setFileName] = useState('')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [backingUp, setBackingUp] = useState(false)
  const [pendingRestore, setPendingRestore] = useState(null)
  const persistRequestedRef = useRef(false)
  // Set only when the preview finds Road-ID conflicts -- holds the preview
  // response + file name until the user resolves the modal (or cancels).
  // Nothing is written to the backend while this is non-null.
  const [pendingConflict, setPendingConflict] = useState(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  // Set when a toast's "View details" link opens History -- auto-expands
  // that upload's log entry instead of landing on a flat list.
  const [historyInitialExpandedId, setHistoryInitialExpandedId] = useState(null)
  const [hasUnreadLog, setHasUnreadLog] = useState(false)
  // Intentionally not persisted -- always starts collapsed on page load,
  // even if the user had it open before refreshing.
  const [requiredColumnsOpen, setRequiredColumnsOpen] = useState(false)

  const historyBtnRef = useRef(null)
  const requiredColumnsTimerRef = useRef(null)

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

  function toggleRequiredColumns() {
    setRequiredColumnsOpen((prev) => !prev)
  }

  function clearRequiredColumnsTimer() {
    if (requiredColumnsTimerRef.current) {
      clearTimeout(requiredColumnsTimerRef.current)
      requiredColumnsTimerRef.current = null
    }
  }

  function startRequiredColumnsTimer() {
    clearRequiredColumnsTimer() // never stack two timers
    requiredColumnsTimerRef.current = setTimeout(() => setRequiredColumnsOpen(false), REQUIRED_COLUMNS_AUTO_HIDE_MS)
  }

  function handleRequiredColumnsPause() {
    clearRequiredColumnsTimer()
  }

  function handleRequiredColumnsResume() {
    if (requiredColumnsOpen) startRequiredColumnsTimer()
  }

  // Single place that starts/stops the auto-hide timer, driven purely by
  // the open/closed state -- covers manual toggle-open, auto-expand on a
  // rejected upload, and manual close (whether by the toggle or by the
  // timer itself) without duplicating start/stop calls at each call site.
  useEffect(() => {
    if (!requiredColumnsOpen) {
      clearRequiredColumnsTimer()
      return
    }
    startRequiredColumnsTimer()
    return clearRequiredColumnsTimer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requiredColumnsOpen])

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

  // Deleting every road resets the whole upload state -- fileName and the
  // file input itself -- so the same file can be re-uploaded right away
  // without a hard refresh.
  useEffect(() => {
    if (roads && roads.length === 0) {
      setFileName('')
      setError('')
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [roads])

  function openHistory(expandedId = null) {
    setHistoryInitialExpandedId(expandedId)
    setHistoryOpen(true)
  }

  async function handleFileChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setError('')
    setUploading(true)
    try {
      // Parses and validates only -- nothing is saved yet. Section IDs that
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
      // A missing/misnamed column is a file-level problem the user can only
      // fix by checking the reference list -- surface it automatically
      // instead of making them hunt for the (collapsed-by-default) toggle.
      if (/missing required column/i.test(err.message)) {
        setRequiredColumnsOpen(true)
      }
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function finishUpload(token, decisions, uploadedFileName) {
    setUploading(true)
    try {
      const res = await commitUpload(token, decisions)
      setFileName(uploadedFileName)
      onUploaded(res, uploadedFileName)
      requestPersistentStorageOnce()
      const { variant, message } = buildUploadToast(res)
      showToast({
        variant,
        message,
        duration: variant === 'success' ? 4000 : 8000,
        actionLabel: res.log_id != null ? 'View details' : undefined,
        onAction: res.log_id != null ? () => openHistory(res.log_id) : undefined,
      })
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
          <p className="file-name" title={fileName}>
            {fileName}
          </p>
        ) : uploadMeta ? (
          <p className="file-name file-name-restored" title={`Last file: ${uploadMeta.fileName}`}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M14 3v5h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="file-name-text">Last file: {uploadMeta.fileName}</span>
          </p>
        ) : (
          <p className="file-name">No file selected</p>
        )}
        <button
          type="button"
          ref={historyBtnRef}
          className="history-icon-btn"
          title="Upload history"
          aria-label="Upload history"
          onClick={() => openHistory()}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 8v4l3 2M4.6 9A8 8 0 1 1 4 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4 5v4h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {hasUnreadLog && <span className="history-icon-dot" aria-hidden="true" />}
        </button>
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

      <div
        className="required-columns"
        onMouseEnter={handleRequiredColumnsPause}
        onMouseLeave={handleRequiredColumnsResume}
        onFocus={handleRequiredColumnsPause}
        onBlur={handleRequiredColumnsResume}
      >
        <button
          type="button"
          className="required-columns-toggle"
          aria-expanded={requiredColumnsOpen}
          aria-controls="required-columns-list"
          onClick={toggleRequiredColumns}
        >
          <span className="required-columns-toggle-left">
            Required columns
            <span className="required-columns-count">{REQUIRED_COLUMNS.length}</span>
          </span>
          <span
            className={`required-columns-chevron${requiredColumnsOpen ? ' required-columns-chevron-open' : ''}`}
            aria-hidden="true"
          >
            ▾
          </span>
        </button>
        <div
          id="required-columns-list"
          className={`required-columns-collapse${requiredColumnsOpen ? ' required-columns-collapse-open' : ''}`}
        >
          <div className="required-columns-collapse-inner">
            <ul>
              {REQUIRED_COLUMNS.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <a className="required-columns-template-link" href="/api/roads/template" download>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 16V4m0 12-4-4m4 4 4-4M4 18v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Download blank template
            </a>
          </div>
        </div>
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
            setHistoryInitialExpandedId(null)
          }}
          triggerRef={historyBtnRef}
          initialExpandedId={historyInitialExpandedId}
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
