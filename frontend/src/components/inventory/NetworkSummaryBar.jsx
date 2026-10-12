import { useEffect } from 'react'

export default function NetworkSummaryBar({ summary, open, onClose, onSelectRoad }) {
  useEffect(() => {
    if (!open) return
    function handleKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!summary || summary.roads.length === 0) return null

  const sortedRoads = [...summary.roads].sort((a, b) => a.pct - b.pct)

  return (
    <div
      id="network-summary-panel"
      className={`network-summary-wrap${open ? ' network-summary-wrap-open' : ''}`}
    >
      <div className="network-summary-inner">
        <div className="panel network-summary no-print">
          <button
            type="button"
            className="network-summary-close"
            onClick={onClose}
            aria-label="Hide network breakdown"
            title="Hide network breakdown"
          >
            ×
          </button>
          <div className="completion-summary">
            <div className="completion-bar">
              <div
                className="completion-bar-fill"
                style={{ width: open ? `${summary.pct}%` : '0%' }}
              />
            </div>
            <span className="completion-label">
              Network: {summary.pct}% Asphalted ({(summary.asphalt_length_m / 1000).toFixed(1)} km of{' '}
              {(summary.total_length_m / 1000).toFixed(1)} km)
            </span>
          </div>
          <div className="road-chip-row thin-scroll">
            {sortedRoads.map((r) => (
              <button
                type="button"
                key={r.road_id}
                className={`road-chip ${r.pct < 50 ? 'road-chip-low' : 'road-chip-ok'}`}
                title={`${r.road_name} — select this road`}
                onClick={() => onSelectRoad(r.road_id)}
              >
                {r.road_id} &middot; {r.pct}%
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
