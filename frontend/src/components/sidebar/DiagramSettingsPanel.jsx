const INTERVAL_OPTIONS = [
  { label: '500 meters', value: 500 },
  { label: '1 kilometer', value: 1000 },
  { label: '2 kilometers', value: 2000 },
]

const STATIONS_PER_LINE_OPTIONS = [5, 10, 15, 20]

export default function DiagramSettingsPanel({ settings, onChange, onGenerate, canGenerate, onExpand }) {
  return (
    <div className="panel">
      <button type="button" className="panel-icon" title="Diagram Settings" onClick={onExpand}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h13M21 18h-1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <circle cx="16" cy="6" r="2" fill="currentColor" />
          <circle cx="9" cy="12" r="2" fill="currentColor" />
          <circle cx="19" cy="18" r="2" fill="currentColor" />
        </svg>
      </button>
      <div className="panel-body">
      <h2>3. Diagram Settings</h2>
      <div className="settings-row">
        <label>
          Station Interval
          <select
            value={settings.stationIntervalM}
            onChange={(e) => onChange({ ...settings, stationIntervalM: Number(e.target.value) })}
          >
            {INTERVAL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Stations per Line
          <select
            value={settings.stationsPerLine}
            onChange={(e) => onChange({ ...settings, stationsPerLine: Number(e.target.value) })}
          >
            {STATIONS_PER_LINE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n} intervals
              </option>
            ))}
          </select>
        </label>
      </div>
      <button className="primary-button" onClick={onGenerate} disabled={!canGenerate}>
        Generate Road Surface Diagram
      </button>
      </div>
    </div>
  )
}
