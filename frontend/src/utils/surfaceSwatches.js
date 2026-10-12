// Shared surface-type -> swatch style map so the diagram legend and the
// Surface Type dropdown render identical colors/patterns.
export const SURFACE_SWATCHES = {
  unpaved: { background: '#FFFFFF', border: '1px solid #333' },
  paved: { background: '#9E9E9E' },
  asphalt: { background: '#000000' },
  gravel: { background: 'repeating-linear-gradient(45deg, #fff 0 2px, #000 2px 3px)', border: '1px solid #333' },
}
