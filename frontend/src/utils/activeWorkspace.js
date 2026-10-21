// Remembers which workspace ("my data" vs. a specific owner's shared
// workspace) this browser last had active, purely so a reload can restore
// the same choice in the switcher UI -- the backend's active_workspace
// cookie is the actual source of truth for what a request can read/write
// (see app/scope.py); this is never trusted on its own. On mount, App.jsx
// reads this and calls switchWorkspace(ownerUserId) to re-establish the
// real cookie, which itself falls back to "my data" if access was removed
// in the meantime -- so a stale value here can never leak access it
// shouldn't.
//
// Scoped per signed-in user id (not a single bare key) -- localStorage is
// shared by the whole browser, not per-account. A single global key meant
// that switching Google accounts in the same browser WITHOUT using the
// app's own "Sign out" button (e.g. picking a different account from
// Google's own account chooser) left the previous account's choice
// sitting there; the next account's mount-time restore would then blindly
// call switchWorkspace() with THEIR id but the PREVIOUS account's saved
// owner id. If that owner happened to also have shared with the new
// account (plausible -- it's often the same small group re-sharing with
// each other while testing), the switch silently succeeded and marked
// that share "seen" before the new account ever opened the dropdown or
// clicked anything -- the exact cause of a reported missing notification
// badge. Keying by user id makes each account's restore choice its own.
const KEY_PREFIX = 'ris.activeWorkspaceOwnerId'

function keyFor(userId) {
  return `${KEY_PREFIX}.${userId}`
}

export function readActiveWorkspaceOwnerId(userId) {
  if (userId == null) return null
  try {
    const raw = localStorage.getItem(keyFor(userId))
    if (!raw) return null
    const n = Number(raw)
    return Number.isInteger(n) ? n : null
  } catch {
    return null
  }
}

export function writeActiveWorkspaceOwnerId(userId, ownerUserId) {
  if (userId == null) return
  try {
    if (ownerUserId == null) {
      localStorage.removeItem(keyFor(userId))
    } else {
      localStorage.setItem(keyFor(userId), String(ownerUserId))
    }
  } catch {
    // localStorage unavailable (private mode, quota, etc.) -- the choice
    // just won't survive a reload this session; nothing else depends on it.
  }
}
