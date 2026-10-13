import { Fragment, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import CustomSelect from '../common/CustomSelect'
import Pagination from '../inventory/Pagination'
import { clearUploadLog, fetchUploadLog, getUploadLogExportUrl } from '../../api/roads'
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

function restoredRoadsLabel(entry) {
  const total = (entry.added_count || 0) + (entry.replaced_count || 0)
  return `${total} road${total !== 1 ? 's' : ''} restored`
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

export default function UploadHistoryModal({ onClose, triggerRef }) {
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [action, setAction] = useState('all')
  const [dateRange, setDateRange] = useState('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [expandedIds, setExpandedIds] = useState(() => new Set())

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

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchUploadLog({ search, action, dateRange }, page, pageSize)
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [search, action, dateRange, page, pageSize])

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
    const res = await fetchUploadLog({ search, action, dateRange }, 1, pageSize)
    setData(res)
    setLoading(false)
  }

  const exportUrl = getUploadLogExportUrl({ search, action, dateRange })

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
              placeholder="Search file name or Road ID…"
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
        </div>

        <div className="history-table-wrap thin-scroll">
          <table className="history-table">
            <thead>
              <tr>
                <th>Date &amp; time</th>
                <th>File</th>
                <th>Summary</th>
                <th>Status</th>
                <th aria-hidden="true"></th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={5} className="history-empty-cell">
                    Loading…
                  </td>
                </tr>
              )}
              {!loading && data && data.entries.length === 0 && (
                <tr>
                  <td colSpan={5} className="history-empty-cell">
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
                  return (
                    <Fragment key={entry.id}>
                      <tr className="history-row" onClick={() => toggleExpand(entry.id)}>
                        <td className="history-cell-nowrap">{formatDateTime(entry.timestamp)}</td>
                        <td className="history-cell-file" title={formatFileCell(entry)}>
                          {formatFileCell(entry)}
                        </td>
                        <td>
                          <div className="history-badge-row">
                            {entry.status === 'cancelled' ? (
                              <span className="upload-summary-badge upload-summary-badge-skipped">No changes applied</span>
                            ) : entry.kind === 'edit' ? (
                              <>
                                <span className="upload-summary-badge upload-summary-badge-edited">Edited</span>
                                {entry.details[0]?.change_summary && (
                                  <span className="history-change-summary">{entry.details[0].change_summary}</span>
                                )}
                              </>
                            ) : entry.kind === 'restore' ? (
                              <>
                                <span className="upload-summary-badge upload-summary-badge-restored">Restored</span>
                                <span className="history-change-summary">{restoredRoadsLabel(entry)}</span>
                              </>
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
                          <td colSpan={5}>
                            <div className="history-expand-body">
                              {entry.error_message && <p className="history-error-message">{entry.error_message}</p>}
                              {entry.status === 'cancelled' && (
                                <p className="history-cancelled-note">
                                  Cancelled before saving — nothing was changed.
                                  {wouldHaveSentence(entry) && ` ${wouldHaveSentence(entry)}`}
                                </p>
                              )}
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
        )}

        <div className="history-footer">
          <div className="history-footer-left">
            <a className="btn-link history-export-link" href={exportUrl} download>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 16V4m0 12-4-4m4 4 4-4M4 18v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Export logs (CSV)
            </a>
            <button type="button" className="btn-link history-clear-link" onClick={handleClearHistory}>
              Clear history
            </button>
          </div>
          <button type="button" className="modal-btn modal-btn-confirm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    getFullscreenPortalRoot()
  )
}
