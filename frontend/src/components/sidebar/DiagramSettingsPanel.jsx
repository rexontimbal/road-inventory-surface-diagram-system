import { parseDpwhStation } from '../../utils/chainage'
import CustomSelect from '../common/CustomSelect'

const INTERVAL_OPTIONS = [
  { label: '100 meters', value: 100 },
  { label: '500 meters', value: 500 },
  { label: '1 kilometer', value: 1000 },
  { label: '2 kilometers', value: 2000 },
  { label: '5 kilometers', value: 5000 },
]

const STATIONS_PER_LINE_OPTIONS = [5, 10, 15, 20]

export default function DiagramSettingsPanel({
  road,
  range,
  onRangeChange,
  settings,
  onChange,
  onGenerate,
  canGenerate,
  onExpand,
}) {
  const hasRoad = !!(road && road.segments.length)
  const firstSeg = hasRoad ? road.segments[0] : null
  const lastSeg = hasRoad ? road.segments[road.segments.length - 1] : null
  const roadMinM = hasRoad ? firstSeg.start_m : null
  const roadMaxM = hasRoad ? lastSeg.end_m : null
  // The section's natural extremes, shown verbatim -- this is the actual
  // original DPWH text (e.g. "K1259 + (-166)"), not a synthesized value, so
  // it's always exact regardless of station notation style.
  const sectionRangeText = hasRoad ? `${firstSeg.start_station} – ${lastSeg.end_station}` : ''

  const startM = parseDpwhStation(range.startRaw)
  const endM = parseDpwhStation(range.endRaw)

  let rangeError = ''
  if (hasRoad) {
    if (range.startRaw.trim() && startM === null) {
      rangeError = 'Use format like K1260 + 500'
    } else if (range.endRaw.trim() && endM === null) {
      rangeError = 'Use format like K1260 + 500'
    } else if (startM !== null && endM !== null && startM >= endM) {
      rangeError = 'Start must be before End'
    } else if (startM !== null && (startM < roadMinM || startM > roadMaxM)) {
      rangeError = `Start must be within the section range (${sectionRangeText})`
    } else if (endM !== null && (endM < roadMinM || endM > roadMaxM)) {
      rangeError = `End must be within the section range (${sectionRangeText})`
    }
  }

  const rangeValid = hasRoad && startM !== null && endM !== null && !rangeError

  function handleReset() {
    onRangeChange({ startRaw: firstSeg.start_station, endRaw: lastSeg.end_station })
  }

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
          Start Station
          <input
            type="text"
            className={rangeError ? 'field-invalid' : ''}
            value={range.startRaw}
            disabled={!hasRoad}
            placeholder="K1260 + 500"
            onChange={(e) => onRangeChange({ ...range, startRaw: e.target.value })}
          />
        </label>
        <label>
          End Station
          <input
            type="text"
            className={rangeError ? 'field-invalid' : ''}
            value={range.endRaw}
            disabled={!hasRoad}
            placeholder="K1270 + 000"
            onChange={(e) => onRangeChange({ ...range, endRaw: e.target.value })}
          />
        </label>
      </div>
      {hasRoad && (
        <div className="range-helper-row">
          <span className="range-helper-text">Section range: {sectionRangeText}</span>
          <button type="button" className="range-reset-link" onClick={handleReset}>
            Reset to full section
          </button>
        </div>
      )}
      {rangeError && <p className="range-error">{rangeError}</p>}

      <div className="settings-row">
        <label>
          Station Interval
          <CustomSelect
            size="sm"
            ariaLabel="Station Interval"
            value={settings.stationIntervalM}
            onChange={(v) => onChange({ ...settings, stationIntervalM: Number(v) })}
            options={INTERVAL_OPTIONS}
          />
        </label>
        <label>
          Stations per Line
          <CustomSelect
            size="sm"
            ariaLabel="Stations per Line"
            value={settings.stationsPerLine}
            onChange={(v) => onChange({ ...settings, stationsPerLine: Number(v) })}
            options={STATIONS_PER_LINE_OPTIONS.map((n) => ({ value: n, label: `${n} intervals` }))}
          />
        </label>
      </div>
      <button className="primary-button" onClick={onGenerate} disabled={!canGenerate || !rangeValid}>
        Generate Road Surface Diagram
      </button>
      </div>
    </div>
  )
}
