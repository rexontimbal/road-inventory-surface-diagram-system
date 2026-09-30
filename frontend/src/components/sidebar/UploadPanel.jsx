import { useRef, useState } from 'react'
import { uploadExcel } from '../../api/roads'

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
        <div className="upload-result">
          {result.imported.length > 0 && (
            <div className="feedback-card feedback-good">
              <span className="feedback-icon" aria-hidden="true">✓</span>
              <div className="feedback-body">
                <strong>{result.imported.length} road{result.imported.length !== 1 ? 's' : ''} uploaded successfully</strong>
                <ul className="feedback-list">
                  {result.imported.map((r) => (
                    <li key={r.road_id} className="feedback-list-item">
                      <div className="feedback-list-row">
                        <span className="mono">{r.road_id}</span>
                        <span className="feedback-count">{r.segment_count} segment{r.segment_count !== 1 ? 's' : ''}</span>
                      </div>
                      <div className="feedback-road-name">{r.road_name}</div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {result.rejected.length > 0 && (
            <div className="feedback-card feedback-critical">
              <span className="feedback-icon" aria-hidden="true">✕</span>
              <div className="feedback-body">
                <strong>{result.rejected.length} road{result.rejected.length !== 1 ? 's' : ''} rejected — not uploaded</strong>
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
