const ITEMS = [
  { label: 'UNPAVED', swatch: { background: '#FFFFFF', border: '1px solid #333' } },
  { label: 'PAVED', swatch: { background: '#9E9E9E' } },
  { label: 'ASPHALT', swatch: { background: '#000000' } },
  { label: 'GRAVEL', swatch: { background: 'repeating-linear-gradient(45deg, #fff 0 2px, #000 2px 3px)', border: '1px solid #333' } },
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
