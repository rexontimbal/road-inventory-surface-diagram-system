import { SURFACE_SWATCHES, SHOULDER_SWATCHES, NO_LANE_SWATCH, NO_DATA_SWATCH } from '../../utils/surfaceSwatches'

const ITEMS = [
  { label: 'CONCRETE', swatch: SURFACE_SWATCHES.concrete },
  { label: 'ASPHALT', swatch: SURFACE_SWATCHES.asphalt },
  { label: 'GRAVEL', swatch: SURFACE_SWATCHES.gravel },
  { label: 'EARTH', swatch: SHOULDER_SWATCHES.earth },
  { label: 'NO LANE / NO SHOULDER', swatch: NO_LANE_SWATCH },
  { label: 'NO DATA (gap)', swatch: NO_DATA_SWATCH },
]

export default function Legend() {
  return (
    <div className="legend">
      <strong>Legend</strong>
      <div className="legend-items">
        {ITEMS.map((item) => (
          <div className="legend-item" key={item.label}>
            <span className="legend-swatch" style={item.swatch} />
            <span>{item.label}</span>
          </div>
        ))}
      </div>
      <div className="legend-note">
        Green/red line above each strip = asphalted / not asphalted.
      </div>
    </div>
  )
}
