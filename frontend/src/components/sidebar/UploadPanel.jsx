import { useEffect, useRef, useState } from 'react'
import { uploadExcel } from '../../api/roads'

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

export default function UploadPanel({ onUploaded, onExpand }) {
  const fileInputRef = useRef(null)
  const [fileName, setFileName] = useState('')
  const [uploading, setUploading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [resultExpanded, setResultExpanded] = useState(true)
  const [progressKey, setProgressKey] = useState(0)

  const timerRef = useRef(null)
  const durationRef = useRef(AUTO_MINIMIZE_AFTER_UPLOAD_MS)

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
    setFileName(file.name)
    setError('')
    setResult(null)
    setUploading(true)
    try {
      const res = await uploadExcel(file)
      setResult(res)
      onUploaded()
    } catch (err) {
      setError(err.message)
    } finally {
      setUploading(false)
    }
  }

  const importedCount = result?.imported.length || 0
  const rejectedCount = result?.rejected.length || 0
  const headerIsError = importedCount === 0 && rejectedCount > 0
  let headerText = ''
  if (importedCount > 0 && rejectedCount > 0) {
    headerText = `${importedCount} road${importedCount !== 1 ? 's' : ''} uploaded · ${rejectedCount} rejected`
  } else if (importedCount > 0) {
    headerText = `${importedCount} road${importedCount !== 1 ? 's' : ''} uploaded`
  } else if (rejectedCount > 0) {
    headerText = `${rejectedCount} road${rejectedCount !== 1 ? 's' : ''} rejected`
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
      <button className="btn-primary btn-block" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
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
      <p className="file-name">{fileName || 'No file selected'}</p>

      {error && (
        <div className="feedback-card feedback-critical">
          <span className="feedback-icon" aria-hidden="true">✕</span>
          <div>
            <strong>Upload failed</strong>
            <p>{error}</p>
          </div>
        </div>
      )}

      {result && (
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
          </div>

          <div className={`upload-summary-body${resultExpanded ? ' upload-summary-body-open' : ''}`}>
            <div className="upload-summary-body-inner thin-scroll">
              {importedCount > 0 && (
                <ul className="upload-summary-list">
                  {result.imported.map((r) => (
                    <li key={r.road_id} className="upload-summary-row">
                      <div className="upload-summary-row-top">
                        <span className="mono">{r.road_id}</span>
                        <span className="upload-summary-count">
                          {r.segment_count} segment{r.segment_count !== 1 ? 's' : ''}
                        </span>
                      </div>
                      <div className="upload-summary-road-name">{r.road_name}</div>
                    </li>
                  ))}
                </ul>
              )}

              {rejectedCount > 0 && (
                <div
                  className="feedback-card feedback-critical"
                  style={importedCount > 0 ? { marginTop: 12 } : undefined}
                >
                  <span className="feedback-icon" aria-hidden="true">✕</span>
                  <div className="feedback-body">
                    <strong>{rejectedCount} road{rejectedCount !== 1 ? 's' : ''} rejected — not uploaded</strong>
                    {result.rejected.map((r) => (
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
    </div>
  )
}
