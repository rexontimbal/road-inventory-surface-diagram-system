import { useEffect } from 'react'

// Groups the flat per-section summary list into one bucket per District
// (DEO), each with its own asphalted % across all its sections, sorted
// worst-first same as the flat chip row used to be -- then sections within
// each district are also sorted worst-first.
function groupByDistrict(roads) {
  const map = new Map()
  for (const r of roads) {
    const key = r.deo || '(No District)'
    if (!map.has(key)) map.set(key, { deo: key, total: 0, asphalt: 0, roads: [] })
    const entry = map.get(key)
    entry.total += r.total_length_m
    entry.asphalt += r.asphalt_length_m
    entry.roads.push(r)
  }
  return [...map.values()]
    .map((e) => ({
      ...e,
      pct: e.total > 0 ? Math.round((e.asphalt / e.total) * 100) : 0,
      roads: [...e.roads].sort((a, b) => a.pct - b.pct),
    }))
    .sort((a, b) => a.pct - b.pct)
}

export default function NetworkSummaryBar({ summary, open, onClose, onSelectSection }) {
  useEffect(() => {
    if (!open) return
    function handleKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!summary || summary.roads.length === 0) return null

  const districts = groupByDistrict(summary.roads)

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
          <div className="network-summary-districts thin-scroll">
            {districts.map((d) => (
              <div key={d.deo} className="network-summary-district">
                <div className="network-summary-district-head">
                  <span className="network-summary-district-name" title={d.deo}>
                    {d.deo}
                  </span>
                  <span className={`district-pct-chip ${d.pct < 50 ? 'district-pct-chip-low' : 'district-pct-chip-ok'}`}>
                    {d.pct}% · {(d.total / 1000).toFixed(1)} km
                  </span>
                </div>
                <div className="road-chip-row thin-scroll">
                  {d.roads.map((r) => (
                    <button
                      type="button"
                      key={r.section_id}
                      className={`road-chip ${r.pct < 50 ? 'road-chip-low' : 'road-chip-ok'}`}
                      title={`${r.road_name} — select this section`}
                      onClick={() => onSelectSection(r.section_id)}
                    >
                      {r.section_id} &middot; {r.pct}%
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
