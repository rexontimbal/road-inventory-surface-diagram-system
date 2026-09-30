export default function RoadSelectPanel({ roads, selectedRoadId, onSelect, roadName }) {
  return (
    <div className="panel">
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
    </div>
  )
}
