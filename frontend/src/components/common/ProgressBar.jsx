// Single source of truth for every "% complete" bar in the app (header,
// diagram, table summary, network breakdown modal -- overall + per-district).
// A plain <div> fill, never a <span> -- inline elements ignore a CSS
// `height`, which silently collapsed an earlier version of the district
// mini bars to zero height even though their width/pct was correct.
function tierClass(pct) {
  if (pct >= 100) return 'progress-bar-fill-complete'
  if (pct >= 50) return 'progress-bar-fill-mid'
  return 'progress-bar-fill-low'
}

export default function ProgressBar({ pct, height = 10, tiered = false, className = '' }) {
  const clamped = Math.max(0, Math.min(100, pct || 0))
  return (
    <div className={`progress-bar ${className}`} style={{ height }}>
      <div
        className={`progress-bar-fill${tiered ? ` ${tierClass(clamped)}` : ''}`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}
