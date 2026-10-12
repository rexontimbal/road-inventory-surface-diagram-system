// Tracks which upload-log entry the user last viewed, purely to drive the
// small "unread" dot on the history icon -- wrapped in try/catch like the
// other localStorage-backed UI state in this app.
const KEY = 'ris.lastSeenLogId'

export function readLastSeenLogId() {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function writeLastSeenLogId(id) {
  try {
    localStorage.setItem(KEY, String(id))
  } catch {
    // localStorage unavailable -- the unread dot just won't persist across reloads
  }
}
