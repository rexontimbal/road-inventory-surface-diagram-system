export default function NetworkSummaryBar({ summary }) {
  if (!summary || summary.roads.length === 0) return null

  const sortedRoads = [...summary.roads].sort((a, b) => a.pct - b.pct)

  return (
    <div className="panel network-summary no-print">
      <div className="completion-summary">
        <div className="completion-bar">
          <div className="completion-bar-fill" style={{ width: `${summary.pct}%` }} />
        </div>
        <span className="completion-label">
          Network: {summary.pct}% Asphalted ({(summary.asphalt_length_m / 1000).toFixed(1)} km of{' '}
          {(summary.total_length_m / 1000).toFixed(1)} km)
        </span>
      </div>
      <div className="road-chip-row">
        {sortedRoads.map((r) => (
          <span
            key={r.road_id}
            className={`road-chip ${r.pct < 50 ? 'road-chip-low' : 'road-chip-ok'}`}
            title={r.road_name}
          >
            {r.road_id} &middot; {r.pct}%
          </span>
        ))}
      </div>
    </div>
  )
}
