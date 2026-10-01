import { useState } from 'react'

export default function RoadSelectPanel({ roads, selectedRoadId, onSelect, roadName, onDelete, onExpand }) {
  const [deleting, setDeleting] = useState(false)

  async function handleDeleteClick() {
    if (!selectedRoadId) return
    const confirmed = window.confirm(
      `Delete road ${selectedRoadId} (${roadName})? This removes all its segments. This cannot be undone.`
    )
    if (!confirmed) return
    setDeleting(true)
    try {
      await onDelete(selectedRoadId)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="panel">
      <button type="button" className="panel-icon" title="Select Road" onClick={onExpand}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4 20 10 4h4l6 16M7 14h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div className="panel-body">
      <h2>2. Select Road</h2>
      <label>
        Road ID
        <select
          value={selectedRoadId || ''}
          onChange={(e) => onSelect(e.target.value)}
          disabled={roads.length === 0}
        >
          <option value="" disabled>
            {roads.length === 0 ? 'Upload Excel first' : 'Select a road'}
          </option>
          {roads.map((r) => (
            <option key={r.road_id} value={r.road_id}>
              {r.road_id}
            </option>
          ))}
        </select>
      </label>
      <label>
        Road Name
        <div className="readonly-display">
          {roadName || <span className="readonly-placeholder">Auto-filled after selecting a road</span>}
        </div>
      </label>
      {selectedRoadId && (
        <button type="button" className="delete-road-link" onClick={handleDeleteClick} disabled={deleting}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {deleting ? 'Deleting…' : 'Delete this road'}
        </button>
      )}
      </div>
    </div>
  )
}
