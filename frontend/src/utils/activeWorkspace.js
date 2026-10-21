// Remembers which workspace ("my data" vs. a specific owner's shared
// workspace) this browser last had active, purely so a reload can restore
// the same choice in the switcher UI -- the backend's active_workspace
// cookie is the actual source of truth for what a request can read/write
// (see app/scope.py); this is never trusted on its own. On mount, App.jsx
// reads this and calls switchWorkspace(ownerUserId) to re-establish the
// real cookie, which itself falls back to "my data" if access was removed
// in the meantime -- so a stale value here can never leak access it
// shouldn't.
const KEY = 'ris.activeWorkspaceOwnerId'

export function readActiveWorkspaceOwnerId() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const n = Number(raw)
    return Number.isInteger(n) ? n : null
  } catch {
    return null
  }
}

export function writeActiveWorkspaceOwnerId(ownerUserId) {
  try {
    if (ownerUserId == null) {
      localStorage.removeItem(KEY)
    } else {
      localStorage.setItem(KEY, String(ownerUserId))
    }
  } catch {
    // localStorage unavailable (private mode, quota, etc.) -- the choice
    // just won't survive a reload this session; nothing else depends on it.
  }
}
