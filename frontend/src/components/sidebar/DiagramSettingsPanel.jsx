const INTERVAL_OPTIONS = [
  { label: '500 meters', value: 500 },
  { label: '1 kilometer', value: 1000 },
  { label: '2 kilometers', value: 2000 },
]

const STATIONS_PER_LINE_OPTIONS = [5, 10, 15, 20]

export default function DiagramSettingsPanel({ settings, onChange, onGenerate, canGenerate }) {
  return (
    <div className="panel">
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
  )
}
