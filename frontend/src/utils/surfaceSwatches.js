// Shared surface-type -> swatch style map so the diagram legend and the
// Surface Type dropdown render identical colors/patterns. Matches the DPWH
// vocabulary: lane surface is concrete/asphalt/gravel; shoulders add earth
// and none (no shoulder) on top of that.
export const SURFACE_SWATCHES = {
  concrete: { background: '#9E9E9E' },
  asphalt: { background: '#000000' },
  gravel: { background: 'repeating-linear-gradient(45deg, #fff 0 2px, #000 2px 3px)', border: '1px solid #333' },
}

export const SHOULDER_SWATCHES = {
  ...SURFACE_SWATCHES,
  earth: { background: '#C8A165' },
  none: { background: '#FFFFFF', border: '1px dashed #94a3b8' },
}

// Diagram-only fills that aren't a real surface/shoulder value -- shown in
// the legend so the strip map's two "blank-looking" areas (a lane that
// doesn't exist at this station vs. a real gap in the recorded data) read
// as deliberate, distinct states instead of looking like the same thing or
// a rendering glitch.
export const NO_LANE_SWATCH = { background: '#FFFFFF', border: '1px dashed #94a3b8' }
export const NO_DATA_SWATCH = {
  background: '#E3E6EA',
  backgroundImage: 'repeating-linear-gradient(45deg, transparent 0 4px, #B7BEC7 4px 5px)',
  backgroundSize: '8px 8px',
}
