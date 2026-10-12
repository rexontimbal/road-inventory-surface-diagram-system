import { useState } from 'react'
import { showConfirm } from '../common/DialogProvider'
import CustomSelect from '../common/CustomSelect'

export default function RoadSelectPanel({ roads, selectedRoadId, onSelect, roadName, onDelete, onExpand }) {
  const [deleting, setDeleting] = useState(false)

  async function handleDeleteClick() {
    if (!selectedRoadId) return
    const confirmed = await showConfirm({
      title: 'Delete road?',
      message: (
        <>
          <strong>{selectedRoadId} — {roadName}</strong> and all its segments will be removed. This cannot be
          undone.
        </>
      ),
      confirmText: 'Delete road',
      cancelText: 'Cancel',
      variant: 'danger',
    })
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
        <CustomSelect
          size="sm"
          value={selectedRoadId || ''}
          onChange={onSelect}
          disabled={roads.length === 0}
          placeholder={roads.length === 0 ? 'Upload Excel first' : 'Select a road'}
          ariaLabel="Road ID"
          searchable
          searchPlaceholder="Search road ID or name…"
          getSearchText={(o) => `${o.value} ${o.roadName}`}
          options={roads.map((r) => ({ value: r.road_id, label: r.road_id, roadName: r.road_name }))}
          renderOption={(o) => (
            <div className="custom-select-road-option">
              <span className="custom-select-road-id">{o.value}</span>
              <span className="custom-select-road-name">{o.roadName}</span>
            </div>
          )}
        />
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
