// Tracks when the user last backed up (and whether they dismissed today's
// reminder) so the "No backup in 7 days" banner isn't shown on every load.
// This is a tiny timestamp, not the backup itself -- the backup data always
// lives in the backend DB and is only ever materialized client-side as the
// downloaded .json file.
const LAST_BACKUP_KEY = 'ris.lastBackupAt'
const DISMISSED_KEY = 'ris.backupReminderDismissedAt'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const ONE_DAY_MS = 24 * 60 * 60 * 1000

export function readLastBackupAt() {
  try {
    const raw = localStorage.getItem(LAST_BACKUP_KEY)
    return raw ? new Date(raw) : null
  } catch {
    return null
  }
}

export function writeLastBackupAt(date) {
  try {
    localStorage.setItem(LAST_BACKUP_KEY, date.toISOString())
  } catch {
    // localStorage unavailable -- the reminder just won't remember this backup
  }
}

export function dismissBackupReminder() {
  try {
    localStorage.setItem(DISMISSED_KEY, new Date().toISOString())
  } catch {
    // ignore
  }
}

export function shouldShowBackupReminder() {
  const lastBackup = readLastBackupAt()
  const isStale = !lastBackup || Date.now() - lastBackup.getTime() > SEVEN_DAYS_MS
  if (!isStale) return false

  try {
    const dismissedRaw = localStorage.getItem(DISMISSED_KEY)
    if (dismissedRaw && Date.now() - new Date(dismissedRaw).getTime() < ONE_DAY_MS) {
      return false
    }
  } catch {
    // ignore -- fall through to showing the reminder
  }
  return true
}
