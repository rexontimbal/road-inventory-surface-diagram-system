import { formatStation, parseStationInput } from '../../utils/chainage'
import CustomSelect from '../common/CustomSelect'

const INTERVAL_OPTIONS = [
  { label: '500 meters', value: 500 },
  { label: '1 kilometer', value: 1000 },
  { label: '2 kilometers', value: 2000 },
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
  const roadMinM = hasRoad ? road.segments[0].start_m : null
  const roadMaxM = hasRoad ? road.segments[road.segments.length - 1].end_m : null

  const startM = parseStationInput(range.startRaw)
  const endM = parseStationInput(range.endRaw)

  let rangeError = ''
  if (hasRoad) {
    if (range.startRaw.trim() && startM === null) {
      rangeError = 'Use format like 12+500'
    } else if (range.endRaw.trim() && endM === null) {
      rangeError = 'Use format like 12+500'
    } else if (startM !== null && endM !== null && startM >= endM) {
      rangeError = 'Start must be before End'
    } else if (startM !== null && (startM < roadMinM || startM > roadMaxM)) {
      rangeError = `Start must be within road range (${formatStation(roadMinM)} – ${formatStation(roadMaxM)})`
    } else if (endM !== null && (endM < roadMinM || endM > roadMaxM)) {
      rangeError = `End must be within road range (${formatStation(roadMinM)} – ${formatStation(roadMaxM)})`
    }
  }

  const rangeValid = hasRoad && startM !== null && endM !== null && !rangeError

  function handleReset() {
    onRangeChange({ startRaw: formatStation(roadMinM), endRaw: formatStation(roadMaxM) })
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
            placeholder="0+000"
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
            placeholder="35+000"
            onChange={(e) => onRangeChange({ ...range, endRaw: e.target.value })}
          />
        </label>
      </div>
      {hasRoad && (
        <div className="range-helper-row">
          <span className="range-helper-text">
            Road range: {formatStation(roadMinM)} &ndash; {formatStation(roadMaxM)}
          </span>
          <button type="button" className="range-reset-link" onClick={handleReset}>
            Reset to full road
          </button>
        </div>
      )}
      {rangeError && <p className="range-error">{rangeError}</p>}

      <div className="settings-row">
        <label>
          Station Interval
          <CustomSelect
            size="md"
            ariaLabel="Station Interval"
            value={settings.stationIntervalM}
            onChange={(v) => onChange({ ...settings, stationIntervalM: Number(v) })}
            options={INTERVAL_OPTIONS}
          />
        </label>
        <label>
          Stations per Line
          <CustomSelect
            size="md"
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
