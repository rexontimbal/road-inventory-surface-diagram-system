const CHAINAGE_RE = /^\s*(\d+)\s*\+\s*(\d{1,3})\s*$/
const PLAIN_METERS_RE = /^\s*(\d+)\s*$/

/**
 * Parses a station input in either 'K+MMM' chainage form (e.g. '12+500') or
 * plain meters (e.g. '12500'). Returns total meters as an integer, or null
 * if the input is empty or doesn't match either form.
 */
export function parseStationInput(raw) {
  if (raw == null) return null
  const s = String(raw).trim()
  if (s === '') return null

  const chainageMatch = CHAINAGE_RE.exec(s)
  if (chainageMatch) {
    const km = parseInt(chainageMatch[1], 10)
    const meters = parseInt(chainageMatch[2], 10)
    if (meters >= 1000) return null
    return km * 1000 + meters
  }

  const plainMatch = PLAIN_METERS_RE.exec(s)
  if (plainMatch) return parseInt(plainMatch[1], 10)

  return null
}

/** Formats total meters as 'K+MMM' (no 'Sta.' prefix -- for inputs/helper text). */
export function formatStation(meters) {
  const km = Math.floor(meters / 1000)
  const m = meters % 1000
  return `${km}+${String(m).padStart(3, '0')}`
}

/** Same as formatStation but with the 'Sta.' prefix used in labels/titles. */
export function formatStationLabel(meters) {
  return `Sta. ${formatStation(meters)}`
}
