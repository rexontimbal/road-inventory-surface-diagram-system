// Mirrors backend/app/chainage.py's parse_station(): DPWH "K<km post>+<offset>"
// notation, e.g. "K1259+881", "K1259 + (-166)" (negative offset), "K1261 +
// 1009" (offset >= 1000), "K1379 + 224.78" (decimal offset). The offset may
// be wrapped in parentheses only to carry a leading minus sign.
const K_STATION_RE = /^[Kk]\s*(\d+)\s*\+\s*\(?(-?\d+(?:\.\d+)?)\)?\s*$/
// A handful of sections measure chainage in plain meters with the word
// "Chainage" in front instead of "K+offset" notation, e.g. "Chainage 105".
const CHAINAGE_RE = /chainage\s*(\d+(?:\.\d+)?)/i

/**
 * Parses a station input in DPWH 'K+offset' notation (including negative,
 * decimal, and >=1000 offsets), 'Chainage N' text, or plain meters. Returns
 * total meters (a float; may be fractional) or null if the input is empty
 * or doesn't match any recognized form. Same parsing rules as the backend's
 * app/chainage.py parse_station() (re-implemented here since the frontend
 * can't share the Python module directly) -- keep the two in sync.
 */
export function parseDpwhStation(raw) {
  if (raw == null) return null
  const s = String(raw).trim()
  if (s === '') return null

  const chainageMatch = CHAINAGE_RE.exec(s)
  if (chainageMatch) return parseFloat(chainageMatch[1])

  const kMatch = K_STATION_RE.exec(s)
  if (kMatch) {
    const km = parseInt(kMatch[1], 10)
    const offset = parseFloat(kMatch[2])
    return km * 1000 + offset
  }

  if (/^-?\d+(\.\d+)?$/.test(s)) return parseFloat(s)
  return null
}

/** Extracts just the km-post integer from DPWH 'K<km>+<offset>' text, e.g.
 * "K1259 + (-166)" -> 1259 -- the km post as the user/original data actually
 * labeled it, NOT Math.floor(absoluteMeters / 1000) (which would read 1258
 * for that same station, since the offset is negative: 1259000 - 166 =
 * 1258834). Returns null for non-K-notation text (plain meters, "Chainage
 * N") -- callers fall back to deriving km from meters there. */
export function extractKmPost(raw) {
  if (raw == null) return null
  const m = K_STATION_RE.exec(String(raw).trim())
  return m ? parseInt(m[1], 10) : null
}

export function looksLikeDpwhText(raw) {
  if (raw == null) return false
  const s = String(raw).trim()
  return K_STATION_RE.test(s) || CHAINAGE_RE.test(s)
}

/** Formats meters as DPWH "K<km> + <offset>" text -- for SYNTHESIZED grid
 * positions (station ticks, a user-entered sub-range) on a DPWH-style
 * section. Per-segment original station text from the backend
 * (start_station/end_station) is already the real DPWH text and should be
 * shown directly instead of calling this. */
export function formatDpwhStation(meters) {
  const km = Math.floor(meters / 1000)
  const offset = Math.round(meters - km * 1000)
  return `K${km} + ${String(offset).padStart(3, '0')}`
}

/** Classic 'K+MMM' plain-meter station text (no 'K' prefix) -- unchanged
 * format for the ~49 sections whose original stationing is plain meters. */
export function formatPlainStation(meters) {
  const km = Math.floor(meters / 1000)
  const m = Math.round(meters - km * 1000)
  return `${km}+${String(m).padStart(3, '0')}`
}

/** Same as formatPlainStation but with the 'Sta.' prefix used in labels/titles. */
export function formatPlainStationLabel(meters) {
  return `Sta. ${formatPlainStation(meters)}`
}

/**
 * Whether a road's stationing uses DPWH 'K+offset' notation (vs. plain
 * meters). Sections are consistently one style or the other throughout (see
 * backend chainage.py's real-data profiling) -- checking the first segment's
 * original station text is enough. `road` is a RoadDetail-shaped object
 * ({ segments: [{ start_station, ... }] }).
 */
export function isDpwhStyle(road) {
  const seg = road?.segments?.[0]
  if (!seg) return false
  return /^[Kk]/.test(String(seg.start_station).trim())
}

/**
 * Full range text in whichever style the section uses -- "K1260 + 000 –
 * K1270 + 000" for DPWH sections (no 'Sta.' prefix, matching real DPWH
 * range notation), "Sta. 0+000 – 35+000" for plain-meter sections (prefixed
 * once, unchanged from before). Used for the progress bar, print header,
 * and fullscreen topbar -- anywhere an arbitrary (possibly user-typed)
 * sub-range is displayed, as opposed to an original per-segment station.
 *
 * `range` = { startM, endM, startText?, endText? }. For DPWH sections,
 * startText/endText (the literal text that was typed or defaulted from the
 * section's own original station text) are shown VERBATIM when they look
 * like valid DPWH text, rather than re-synthesized from the absolute meters
 * value -- re-deriving km via Math.floor(meters/1000) silently drops the
 * negative-offset reference point (e.g. "K1259 + (-166)" would come back as
 * "K1258 + 834", a different km post than the one actually on record).
 * Plain-meter sections have no such reference-point concept, so they always
 * use the normalized Sta.-prefixed format derived from the meters value.
 */
export function formatStationRange(road, range) {
  if (isDpwhStyle(road)) {
    const start = looksLikeDpwhText(range.startText) ? range.startText.trim() : formatDpwhStation(range.startM)
    const end = looksLikeDpwhText(range.endText) ? range.endText.trim() : formatDpwhStation(range.endM)
    return `${start} – ${end}`
  }
  return `Sta. ${formatPlainStation(range.startM)} – ${formatPlainStation(range.endM)}`
}

/**
 * Filesystem-safe range suffix for exported filenames, e.g. "_K1259-K1281"
 * (km only -- offsets/spaces/parens don't belong in a filename) or
 * "_1259000-1281384" for a plain-meter section. Same km-post-from-original-
 * text preference as formatStationRange, for the same reason (filenames
 * must match what the table/inputs show, not a floor()-derived km).
 */
export function formatFilenameRangeSuffix(road, range) {
  if (isDpwhStyle(road)) {
    const startKm = extractKmPost(range.startText) ?? Math.floor(range.startM / 1000)
    const endKm = extractKmPost(range.endText) ?? Math.floor(range.endM / 1000)
    return `_K${startKm}-K${endKm}`
  }
  return `_${Math.round(range.startM)}-${Math.round(range.endM)}`
}
