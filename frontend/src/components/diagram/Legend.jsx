import { SURFACE_SWATCHES } from '../../utils/surfaceSwatches'

const ITEMS = [
  { label: 'CONCRETE', swatch: SURFACE_SWATCHES.concrete },
  { label: 'ASPHALT', swatch: SURFACE_SWATCHES.asphalt },
  { label: 'GRAVEL', swatch: SURFACE_SWATCHES.gravel },
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
    </div>
  )
}
