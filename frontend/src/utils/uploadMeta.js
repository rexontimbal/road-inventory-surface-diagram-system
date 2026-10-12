// Upload metadata (file name, timestamp, rejected-roads detail) persisted
// separately from road data itself. Road records live in the backend's
// SQLite database; this is lightweight, browser-local, and purely
// descriptive, so localStorage is used rather than adding a backend table
// just to remember a file name and a clock time.
const KEY = 'ris.uploadMeta'

export function readUploadMeta() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.fileName !== 'string' || typeof parsed.uploadedAt !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

export function writeUploadMeta(meta) {
  try {
    if (meta) {
      localStorage.setItem(KEY, JSON.stringify(meta))
    } else {
      localStorage.removeItem(KEY)
    }
  } catch {
    // localStorage unavailable (private mode, quota, etc.) -- metadata just
    // won't survive a reload this session; nothing else depends on it.
  }
}
