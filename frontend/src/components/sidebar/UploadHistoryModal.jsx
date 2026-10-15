import { Fragment, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import CustomSelect from '../common/CustomSelect'
import Pagination from '../inventory/Pagination'
import { clearUploadLog, fetchUploadLog, fetchUploadLogUsers, getUploadLogExportUrl } from '../../api/roads'
import { showConfirm, showToast } from '../common/DialogProvider'
import { writeLastSeenLogId } from '../../utils/uploadLogSeen'
import { useModalLayer } from '../common/useModalLayer'
import { getFullscreenPortalRoot } from '../../utils/fullscreenPortal'

const ACTION_OPTIONS = [
  { value: 'all', label: 'All actions' },
  { value: 'added', label: 'Added' },
  { value: 'replaced', label: 'Replaced' },
  { value: 'kept_existing', label: 'Kept existing' },
  { value: 'up_to_date', label: 'Up to date' },
  { value: 'edited', label: 'Edited' },
  { value: 'restored', label: 'Restored' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'deleted', label: 'Deleted' },
]

const DATE_OPTIONS = [
  { value: 'all', label: 'All time' },
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
]

const ACTION_LABELS = {
  added: 'Added',
  replaced: 'Replaced',
  kept_existing: 'Kept existing',
  up_to_date: 'Up to date',
  edited: 'Edited',
  rejected: 'Rejected',
  deleted: 'Deleted',
}

const ACTION_BADGE_CLASS = {
  added: 'added',
  replaced: 'replaced',
  kept_existing: 'skipped',
  up_to_date: 'up_to_date',
  edited: 'edited',
  rejected: 'rejected',
  deleted: 'rejected',
}

const STATUS_LABELS = { completed: 'Completed', cancelled: 'Cancelled', failed: 'Failed' }

function formatDateTime(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `${date} · ${time}`
}

// Expanded-panel timestamp includes seconds -- the collapsed column stays
// minute-precision for scannability.
function formatDateTimeFull(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
  return `${date} · ${time}`
}

function formatFileSize(bytes) {
  if (bytes == null) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Restore entries store "Backup from <raw iso>" as file_name (set server-side
// at commit time) -- reformat the embedded timestamp the same way the log's
// own Date & time column reads, instead of showing the raw ISO string.
const BACKUP_FILE_PREFIX = 'Backup from '
function formatFileCell(entry) {
  if (entry.kind === 'restore' && entry.file_name?.startsWith(BACKUP_FILE_PREFIX)) {
    const raw = entry.file_name.slice(BACKUP_FILE_PREFIX.length)
    const formatted = formatDateTime(raw)
    if (formatted !== raw) return `${BACKUP_FILE_PREFIX}${formatted}`
  }
  return entry.file_name || '—'
}

// Inline-edit entries encode the road id + station range in file_name as
// "Inline edit: SD00001 (0+000–5+000)" -- pull those pieces back out for the
// short/full Source labels instead of showing that raw sentence verbatim.
const EDIT_FILE_RE = /^Inline edit: (.+?) \((.+?)–(.+?)\)$/
function parseEditFileName(fileName) {
  const m = fileName?.match(EDIT_FILE_RE)
  if (!m) return null
  return { roadId: m[1], start: m[2], end: m[3] }
}

function sourceLabelShort(entry) {
  if (entry.kind === 'edit') {
    const roadId = entry.details[0]?.road_id || parseEditFileName(entry.file_name)?.roadId || ''
    return `Inline edit · ${roadId}`
  }
  if (entry.kind === 'delete') {
    const roadId = entry.details[0]?.road_id || ''
    return `Deleted · ${roadId}`
  }
  return formatFileCell(entry)
}

function sourceLabelFull(entry) {
  if (entry.kind === 'edit') {
    const parsed = parseEditFileName(entry.file_name)
    const d = entry.details[0]
    const roadId = d?.road_id || parsed?.roadId || ''
    const roadName = d?.road_name ? ` ${d.road_name}` : ''
    const stations = parsed ? ` · Sta. ${parsed.start} – ${parsed.end}` : ''
    return `Inline edit — ${roadId}${roadName}${stations}`
  }
  if (entry.kind === 'delete') {
    const d = entry.details[0]
    return `Deleted — ${d?.road_id || ''}${d?.road_name ? ` ${d.road_name}` : ''}`
  }
  const parts = [formatFileCell(entry)]
  const size = formatFileSize(entry.file_size)
  if (size) parts.push(size)
  if (entry.total_rows != null) parts.push(`${entry.total_rows} row${entry.total_rows !== 1 ? 's' : ''}`)
  return parts.join(' · ')
}

// Splits "Field: old → new; Field2: old2 → new2" into per-field pieces for
// the red-strikethrough/green-new display in the expanded panel.
function parseFieldChanges(changeSummary) {
  if (!changeSummary) return []
  return changeSummary.split('; ').map((part) => {
    const m = part.match(/^(.+?): (.+?) → (.+)$/)
    if (!m) return { field: part, old: null, new: null }
    return { field: m[1], old: m[2], new: m[3] }
  })
}

function initials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

// Guest and "logged before this tracking existed" both arrive as no actor
// fields -- entry.is_guest_action is what tells them apart (the backend
// derives it from owner_type, which is always set, unlike actor_name).
function actorInfo(entry) {
  if (entry.is_guest_action) {
    return { shortLabel: 'Guest', fullLabel: 'Guest', email: null, avatarUrl: null, variant: 'guest' }
  }
  if (entry.actor_name) {
    return {
      shortLabel: entry.actor_name.split(' ')[0],
      fullLabel: entry.actor_name,
      email: entry.actor_email,
      avatarUrl: entry.actor_avatar_url,
      variant: 'user',
    }
  }
  return { shortLabel: 'Unknown', fullLabel: 'Unknown', email: null, avatarUrl: null, variant: 'unknown' }
}

function HistoryByAvatar({ actor }) {
  const [failed, setFailed] = useState(false)
  if (actor.variant === 'user' && actor.avatarUrl && !failed) {
    return (
      <img
        src={actor.avatarUrl}
        alt=""
        className="history-by-avatar"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    )
  }
  if (actor.variant === 'user') {
    return (
      <span className="history-by-avatar history-by-avatar-initials" aria-hidden="true">
        {initials(actor.fullLabel)}
      </span>
    )
  }
  return (
    <span className={`history-by-avatar history-by-avatar-${actor.variant}`} aria-hidden="true">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
        <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-3.3 0-8 1.7-8 5v1h16v-1c0-3.3-4.7-5-8-5Z" fill="currentColor" />
      </svg>
    </span>
  )
}

function summaryBadges(entry) {
  const badges = []
  if (entry.added_count > 0) badges.push({ key: 'added', label: `+${entry.added_count} added` })
  if (entry.replaced_count > 0) badges.push({ key: 'replaced', label: `${entry.replaced_count} replaced` })
  if (entry.kept_count > 0) badges.push({ key: 'kept_existing', label: `${entry.kept_count} kept` })
  if (entry.up_to_date_count > 0) badges.push({ key: 'up_to_date', label: `${entry.up_to_date_count} up to date` })
  if (entry.rejected_count > 0) badges.push({ key: 'rejected', label: `${entry.rejected_count} rejected` })
  if (entry.deleted_count > 0) badges.push({ key: 'deleted', label: `${entry.deleted_count} deleted` })
  return badges
}

// A cancelled upload never touched the database -- the counts above are
// only what WOULD have happened, so the collapsed row must not read like
// they actually did. The real counts still show inside the expanded detail,
// just worded as "would have been".
function wouldHaveSentence(entry) {
  const parts = []
  if (entry.added_count > 0) parts.push(`${entry.added_count} road${entry.added_count !== 1 ? 's' : ''} would have been added`)
  if (entry.replaced_count > 0) parts.push(`${entry.replaced_count} would have been replaced`)
  if (entry.rejected_count > 0) parts.push(`${entry.rejected_count} would have been rejected`)
  return parts.length > 0 ? `${parts.join(', ')}.` : null
}

export default function UploadHistoryModal({ onClose, triggerRef, initialExpandedId }) {
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [action, setAction] = useState('all')
  const [dateRange, setDateRange] = useState('all')
  const [byUser, setByUser] = useState('all')
  const [logUsers, setLogUsers] = useState([])
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [expandedIds, setExpandedIds] = useState(() => (initialExpandedId != null ? new Set([initialExpandedId]) : new Set()))

  const cardRef = useRef(null)
  const firstFocusableRef = useRef(null)
  const { zIndex, isTop } = useModalLayer()

  // Debounce the search box so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput)
      setPage(1)
    }, 300)
    return () => clearTimeout(t)
  }, [searchInput])

  // Opening the modal counts as "viewed" -- find the absolute latest entry
  // (ignoring whatever filters are set) and remember it, clearing the
  // unread dot on the history icon.
  useEffect(() => {
    fetchUploadLog({}, 1, 1)
      .then((res) => {
        const latest = res.entries[0]
        if (latest) writeLastSeenLogId(latest.id)
      })
      .catch(() => {})
  }, [])

  // Populates the "By" filter's user list once -- only users who actually
  // have log entries in this scope, not every account that's ever signed in.
  useEffect(() => {
    fetchUploadLogUsers()
      .then(setLogUsers)
      .catch(() => {})
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchUploadLog({ search, action, dateRange, byUser }, page, pageSize)
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [search, action, dateRange, byUser, page, pageSize])

  // Focus trap + Esc + body scroll lock + return focus on close, mirroring
  // the existing Modal.jsx pattern.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    firstFocusableRef.current?.focus()

    function handleKeyDown(e) {
      if (!isTop()) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key === 'Tab') {
        const focusable = cardRef.current?.querySelectorAll(
          'button, a[href], input, [tabindex]:not([tabindex="-1"])'
        )
        if (!focusable || focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = prevOverflow
      triggerRef?.current?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function toggleExpand(id) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleClearHistory() {
    const confirmed = await showConfirm({
      title: 'Clear upload history?',
      message: 'This removes every log entry. Road data itself is not affected.',
      confirmText: 'Clear history',
      cancelText: 'Cancel',
      variant: 'danger',
    })
    if (!confirmed) return
    await clearUploadLog()
    showToast({ variant: 'success', message: 'Upload history cleared' })
    setPage(1)
    setData(null)
    setLoading(true)
    const res = await fetchUploadLog({ search, action, dateRange, byUser }, 1, pageSize)
    setData(res)
    setLoading(false)
  }

  const exportUrl = getUploadLogExportUrl({ search, action, dateRange, byUser })
  const hasLogs = !!data && data.total_records > 0
  const userFilterOptions = [
    { value: 'all', label: 'All users' },
    { value: 'me', label: 'Me' },
    ...logUsers.map((u) => ({ value: String(u.user_id), label: u.name || 'Unknown' })),
  ]

  if (zIndex == null) return null

  return createPortal(
    <div
      className="modal-backdrop no-print"
      style={{ zIndex }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="modal-card history-modal-card"
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-modal-title"
      >
        <div className="modal-header">
          <div className="modal-icon modal-icon-info" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 8v4l3 2M4.6 9A8 8 0 1 1 4 13"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path d="M4 5v4h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <h3 id="history-modal-title" className="modal-title">
            Upload History
          </h3>
          <div className="history-header-actions">
            <a
              className={`history-header-btn history-header-btn-export${hasLogs ? '' : ' history-header-btn-disabled'}`}
              href={hasLogs ? exportUrl : undefined}
              download
              title="Export logs (CSV)"
              aria-label="Export logs (CSV)"
              aria-disabled={!hasLogs}
              onClick={(e) => {
                if (!hasLogs) e.preventDefault()
              }}
            >
              <svg className="history-header-btn-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12 16V4m0 12-4-4m4 4 4-4M4 18v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="history-header-btn-label">Export CSV</span>
            </a>
            <button
              type="button"
              className="history-header-btn history-header-btn-clear"
              onClick={handleClearHistory}
              disabled={!hasLogs}
              title="Clear history"
              aria-label="Clear history"
            >
              <svg className="history-header-btn-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0-.8 12.1a2 2 0 0 1-2 1.9H9.8a2 2 0 0 1-2-1.9L7 7"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="history-header-btn-label">Clear history</span>
            </button>
            <button
              type="button"
              ref={firstFocusableRef}
              className="history-modal-close"
              onClick={onClose}
              aria-label="Close"
              title="Close"
            >
              ×
            </button>
          </div>
        </div>
        <p className="history-modal-subtitle">All uploads and changes to road data</p>

        <div className="history-toolbar">
          <div className="history-search-wrap">
            <svg className="history-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
              <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <input
              type="text"
              className="history-search"
              placeholder="Search file name, Road ID, or field…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
          <CustomSelect
            size="sm"
            value={action}
            onChange={(v) => {
              setAction(v)
              setPage(1)
            }}
            options={ACTION_OPTIONS}
            ariaLabel="Filter by action"
            triggerClassName="history-action-select"
          />
          <CustomSelect
            size="sm"
            value={dateRange}
            onChange={(v) => {
              setDateRange(v)
              setPage(1)
            }}
            options={DATE_OPTIONS}
            ariaLabel="Filter by date"
            triggerClassName="history-date-select"
          />
          <CustomSelect
            size="sm"
            value={byUser}
            onChange={(v) => {
              setByUser(v)
              setPage(1)
            }}
            options={userFilterOptions}
            ariaLabel="Filter by user"
            triggerClassName="history-user-select"
          />
        </div>

        <div className="history-table-wrap thin-scroll">
          <table className="history-table">
            <thead>
              <tr>
                <th>Date &amp; time</th>
                <th>By</th>
                <th>Source</th>
                <th>Summary</th>
                <th>Status</th>
                <th aria-hidden="true"></th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={6} className="history-empty-cell">
                    Loading…
                  </td>
                </tr>
              )}
              {!loading && data && data.entries.length === 0 && (
                <tr>
                  <td colSpan={6} className="history-empty-cell">
                    <div className="history-empty">
                      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path
                          d="M12 8v4l3 2M4.6 9A8 8 0 1 1 4 13"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      No uploads yet.
                    </div>
                  </td>
                </tr>
              )}
              {!loading &&
                data &&
                data.entries.map((entry) => {
                  const expanded = expandedIds.has(entry.id)
                  const fieldChanges = entry.kind === 'edit' ? parseFieldChanges(entry.details[0]?.change_summary) : []
                  const editedLabel = fieldChanges.length > 1 ? `Edited · ${fieldChanges.length} fields` : 'Edited'
                  const editParsed = entry.kind === 'edit' ? parseEditFileName(entry.file_name) : null
                  const actor = actorInfo(entry)
                  return (
                    <Fragment key={entry.id}>
                      <tr className="history-row" onClick={() => toggleExpand(entry.id)}>
                        <td className="history-cell-nowrap">{formatDateTime(entry.timestamp)}</td>
                        <td className="history-cell-by" title={actor.fullLabel}>
                          <span className="history-by">
                            <HistoryByAvatar actor={actor} />
                            <span className="history-by-name">{actor.shortLabel}</span>
                          </span>
                        </td>
                        <td className="history-cell-source" title={sourceLabelShort(entry)}>
                          {sourceLabelShort(entry)}
                        </td>
                        <td>
                          <div className="history-badge-row">
                            {entry.status === 'cancelled' ? (
                              <span className="upload-summary-badge upload-summary-badge-skipped">No changes applied</span>
                            ) : entry.kind === 'edit' ? (
                              <span className="upload-summary-badge upload-summary-badge-edited">{editedLabel}</span>
                            ) : entry.kind === 'delete' ? (
                              <span className="upload-summary-badge upload-summary-badge-rejected">Deleted</span>
                            ) : entry.kind === 'restore' ? (
                              <span className="upload-summary-badge upload-summary-badge-restored">Restored</span>
                            ) : (
                              summaryBadges(entry).map((b) => (
                                <span key={b.key} className={`upload-summary-badge upload-summary-badge-${ACTION_BADGE_CLASS[b.key]}`}>
                                  {b.label}
                                </span>
                              ))
                            )}
                          </div>
                        </td>
                        <td>
                          <span className={`history-status history-status-${entry.status}`}>{STATUS_LABELS[entry.status]}</span>
                        </td>
                        <td>
                          <span className={`history-chevron${expanded ? ' history-chevron-open' : ''}`} aria-hidden="true">
                            ▾
                          </span>
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="history-expand-row">
                          <td colSpan={6}>
                            <div className="history-expand-body">
                              <p className="history-expand-timestamp">
                                {formatDateTimeFull(entry.timestamp)}
                                <span className="history-expand-by">
                                  {' '}
                                  · By {actor.fullLabel}
                                  {actor.email ? ` (${actor.email})` : ''}
                                </span>
                              </p>
                              {entry.error_message && <p className="history-error-message">{entry.error_message}</p>}
                              {entry.status === 'cancelled' && (
                                <p className="history-cancelled-note">
                                  Cancelled before saving — nothing was changed.
                                  {wouldHaveSentence(entry) && ` ${wouldHaveSentence(entry)}`}
                                </p>
                              )}
                              {entry.kind === 'edit' || entry.kind === 'delete' ? (
                                <div className="history-detail-panel">
                                  <div className="history-detail-panel-row">
                                    <span className="history-detail-panel-label">Source</span>
                                    <span className="history-detail-panel-value">{sourceLabelFull(entry)}</span>
                                  </div>
                                  <div className="history-detail-panel-row">
                                    <span className="history-detail-panel-label">Road</span>
                                    <span className="history-detail-panel-value">
                                      <span className="mono">{entry.details[0]?.road_id}</span>
                                      {entry.details[0]?.road_name ? ` ${entry.details[0].road_name}` : ''}
                                    </span>
                                  </div>
                                  {editParsed && (
                                    <div className="history-detail-panel-row">
                                      <span className="history-detail-panel-label">Station range</span>
                                      <span className="history-detail-panel-value">
                                        Sta. {editParsed.start} – {editParsed.end}
                                      </span>
                                    </div>
                                  )}
                                  {fieldChanges.length > 0 && (
                                    <div className="history-detail-panel-row">
                                      <span className="history-detail-panel-label">Changes</span>
                                      <div className="history-detail-panel-value history-field-changes">
                                        {fieldChanges.map((c, i) => (
                                          <div key={i} className="history-field-change">
                                            <span className="history-field-name">{c.field}:</span>{' '}
                                            {c.old != null ? (
                                              <>
                                                <span className="history-field-old">{c.old}</span>
                                                <span className="history-field-arrow"> → </span>
                                                <span className="history-field-new">{c.new}</span>
                                              </>
                                            ) : (
                                              <span className="history-field-new">{c.field}</span>
                                            )}
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <>
                                  <p className="history-expand-source">{sourceLabelFull(entry)}</p>
                                  {entry.details.length === 0 && !entry.error_message && (
                                    <p className="history-no-detail">No road changes recorded for this entry.</p>
                                  )}
                                  {entry.details.map((d, i) => (
                                    <div key={`${d.road_id}-${i}`} className="history-detail-row">
                                      <span className="mono history-detail-id">{d.road_id}</span>
                                      <span className="history-detail-name">{d.road_name}</span>
                                      <span className={`upload-summary-badge upload-summary-badge-${ACTION_BADGE_CLASS[d.action]}`}>
                                        {ACTION_LABELS[d.action]}
                                      </span>
                                      {d.segment_count != null && (
                                        <span className="history-detail-segments">
                                          {d.segment_count} segment{d.segment_count !== 1 ? 's' : ''}
                                        </span>
                                      )}
                                      {d.change_summary && <span className="history-change-summary">{d.change_summary}</span>}
                                      {d.rejection_reasons.length > 0 && (
                                        <ul className="history-rejection-reasons">
                                          {d.rejection_reasons.map((r, ri) => (
                                            <li key={ri}>{r}</li>
                                          ))}
                                        </ul>
                                      )}
                                    </div>
                                  ))}
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
            </tbody>
          </table>
        </div>

        {data && (
          <div className="history-footer">
            <Pagination
              page={data.page}
              totalPages={data.total_pages}
              totalRecords={data.total_records}
              onPageChange={setPage}
              pageSize={pageSize}
              onPageSizeChange={(n) => {
                setPageSize(n)
                setPage(1)
              }}
              pageSizeOptions={[10, 25, 50]}
              itemLabel="logs"
            />
          </div>
        )}
      </div>
    </div>,
    getFullscreenPortalRoot()
  )
}
