import { useRef, useState } from 'react'
import Pagination from './Pagination'
import CustomSelect from '../common/CustomSelect'
import { editSegment, getSegmentsExportUrl } from '../../api/roads'
import { SURFACE_SWATCHES } from '../../utils/surfaceSwatches'
import { showToast } from '../common/DialogProvider'

// Matches .app-header-spacer in App.css (the fixed app header's height).
const APP_HEADER_HEIGHT = 72

// A real vector shape, not a unicode glyph (↕ ▲ ▼) -- those could fall back
// to a color-emoji font on Windows/Chrome, which bakes in its own colors
// (CSS `color` can't override a color-glyph) and can render at a different
// box size than a plain text character, which is what was both coloring the
// icons randomly and shifting/clipping the header labels next to them.
// fill="currentColor" on an SVG path is immune to that -- it's a shape, not
// a character, so there's no font/glyph substitution to go wrong.
function SortIcon({ active, dir }) {
  if (active) {
    return (
      <svg
        className="sort-icon-svg sort-icon-svg-active"
        width="10"
        height="10"
        viewBox="0 0 10 10"
        aria-hidden="true"
      >
        {dir === 'asc' ? <path d="M5 1.5 8.5 7h-7Z" fill="currentColor" /> : <path d="M5 8.5 1.5 3h7Z" fill="currentColor" />}
      </svg>
    )
  }
  return (
    <svg className="sort-icon-svg" width="10" height="12" viewBox="0 0 10 12" aria-hidden="true">
      <path d="M5 0 8 3.2H2Z" fill="currentColor" />
      <path d="M5 12 2 8.8h6Z" fill="currentColor" />
    </svg>
  )
}

const SURFACE_TYPE_OPTIONS = ['unpaved', 'paved', 'gravel', 'asphalt']
const SURFACE_EDIT_OPTIONS = SURFACE_TYPE_OPTIONS.map((s) => ({
  value: s,
  label: s.charAt(0).toUpperCase() + s.slice(1),
}))

function renderSurfaceOption(o) {
  return (
    <span className="custom-select-surface-option">
      <span className="custom-select-surface-swatch" style={SURFACE_SWATCHES[o.value]} />
      {o.label}
    </span>
  )
}

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'Complete', label: 'Complete' },
  { value: 'Incomplete', label: 'Incomplete' },
]

// Full labels, natural (table-layout: auto) sizing -- restored to match the
// deployed version after several passes of colgroup/table-layout:fixed
// experiments made the header worse (percentages that didn't visually
// balance, left-aligned columns with a lopsided gap after a short label,
// etc). Column widths are no longer hand-tuned pixel/percentage budgets --
// the browser sizes each one from its own header label + cell content,
// which is what actually keeps every label fully readable at any width.
// The handful of columns that still need a floor (so an edit control can't
// widen them) get a plain CSS min-width instead -- see App.css.
const COLUMNS = [
  { label: '#', key: null },
  { label: 'ROAD ID', key: 'road_id' },
  { label: 'Road Name', key: 'road_name' },
  { label: 'Start Station', key: 'start_station' },
  { label: 'End Station', key: 'end_station' },
  { label: 'Number of Lanes', key: 'num_lanes' },
  { label: 'Surface Type', key: 'surface_type' },
  { label: 'Left Shoulder', key: 'shoulder_left' },
  { label: 'Right Shoulder', key: 'shoulder_right' },
  { label: 'Status', key: 'status' },
  { label: '', key: null },
]

export default function RoadInventoryTable({
  segmentsPage,
  onPageChange,
  roads,
  filters,
  onFilterChange,
  sort,
  onSortChange,
  onSegmentEdited,
}) {
  const records = segmentsPage?.records || []
  const hasActiveFilters = !!(filters.roadId || filters.status || filters.surfaceType)

  const [editingId, setEditingId] = useState(null)
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [tableScrolledOver, setTableScrolledOver] = useState(false)

  const tableScrollRef = useRef(null)
  const actionsCellRefs = useRef(new Map())
  const editBtnRefs = useRef(new Map())
  // Only scroll back to the left on Save/Cancel if startEdit actually had to
  // scroll to reveal the actions column in the first place -- a row that
  // was already fully visible shouldn't jump the viewport on close.
  const didAutoScrollRef = useRef(false)

  function handleTableScroll(e) {
    const el = e.currentTarget
    setTableScrolledOver(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }

  const roadOptions = [
    { value: '', label: 'All roads' },
    ...roads.map((r) => ({ value: r.road_id, label: `${r.road_id} — ${r.road_name}`, roadName: r.road_name })),
  ]
  const surfaceOptions = [
    { value: '', label: 'All surface types' },
    ...SURFACE_TYPE_OPTIONS.map((s) => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) })),
  ]

  function updateFilter(key, value) {
    onFilterChange({ ...filters, [key]: value })
  }

  function clearFilters() {
    onFilterChange({ roadId: '', status: '', surfaceType: '' })
  }

  // Manual scrollLeft/scrollTop math instead of el.scrollIntoView() -- this
  // table's scroll container has overflow-x AND overflow-y auto at once
  // (plus a sticky-positioned child, the actions cell itself), and
  // scrollIntoView's automatic nearest-ancestor resolution turned out not
  // to reliably reach the true end in that combination across widths/
  // browsers. Computing the target directly removes that ambiguity.
  function scrollEditedRowIntoView(id) {
    const wrap = tableScrollRef.current
    const cell = actionsCellRefs.current.get(id)
    if (!wrap || !cell) return

    // Horizontal: Actions is always the last column, so "fully visible" and
    // "scrolled all the way to the right" are the same target.
    const maxScrollLeft = wrap.scrollWidth - wrap.clientWidth
    if (maxScrollLeft > 0 && wrap.scrollLeft < maxScrollLeft) {
      wrap.scrollTo({ left: maxScrollLeft, behavior: 'smooth' })
      didAutoScrollRef.current = true
    }

    // Vertical, inside the table's own box -- only relevant at >=1440px,
    // where .table-scroll still clips vertically (max-height: 70vh); below
    // that breakpoint the box has no vertical overflow of its own, so this
    // is a no-op there.
    const cellRect = cell.getBoundingClientRect()
    const wrapRect = wrap.getBoundingClientRect()
    if (cellRect.bottom > wrapRect.bottom) {
      wrap.scrollTop += cellRect.bottom - wrapRect.bottom + 8
    } else if (cellRect.top < wrapRect.top) {
      wrap.scrollTop -= wrapRect.top - cellRect.top + 8
    }

    // Vertical, on the page itself -- relevant once the table no longer has
    // its own vertical scrollbox (below 1440px) and/or the row sits close
    // to the fold. APP_HEADER_HEIGHT keeps the row from landing underneath
    // the app's fixed header.
    const freshCellRect = cell.getBoundingClientRect()
    if (freshCellRect.top < APP_HEADER_HEIGHT) {
      window.scrollBy({ top: freshCellRect.top - APP_HEADER_HEIGHT - 8, behavior: 'smooth' })
    } else if (freshCellRect.bottom > window.innerHeight) {
      window.scrollBy({ top: freshCellRect.bottom - window.innerHeight + 8, behavior: 'smooth' })
    }
  }

  function startEdit(r) {
    setEditingId(r.id)
    setDraft({
      num_lanes: r.num_lanes,
      surface_type: r.surface_type,
      shoulder_left: r.shoulder_left,
      shoulder_right: r.shoulder_right,
    })
    // The editable columns (Lanes/Surface/Shoulders) have a CSS min-width
    // matching their edit field's own size (App.css), so entering edit mode
    // shouldn't change the table's scrollWidth in practice -- one frame is
    // just to let the edit inputs themselves mount before reading layout.
    requestAnimationFrame(() => {
      scrollEditedRowIntoView(r.id)
    })
  }

  function cancelEdit() {
    const closedId = editingId
    setEditingId(null)
    setDraft(null)
    if (didAutoScrollRef.current) {
      tableScrollRef.current?.scrollTo({ left: 0, behavior: 'smooth' })
    }
    didAutoScrollRef.current = false
    editBtnRefs.current.get(closedId)?.focus()
  }

  async function saveEdit(original) {
    if (saving || !draft) return
    const fields = {}
    if (draft.num_lanes !== original.num_lanes) fields.num_lanes = draft.num_lanes
    if (draft.surface_type !== original.surface_type) fields.surface_type = draft.surface_type
    if (draft.shoulder_left !== original.shoulder_left) fields.shoulder_left = draft.shoulder_left
    if (draft.shoulder_right !== original.shoulder_right) fields.shoulder_right = draft.shoulder_right

    if (Object.keys(fields).length === 0) {
      cancelEdit()
      return
    }

    setSaving(true)
    try {
      await editSegment(original.id, fields)
      cancelEdit()
      onSegmentEdited?.(original.road_id)
      showToast({
        variant: 'success',
        message: `${original.road_id} segment updated (${original.start_station}–${original.end_station})`,
        actionLabel: 'Undo',
        duration: 8000,
        onAction: async () => {
          try {
            await editSegment(original.id, {
              num_lanes: original.num_lanes,
              surface_type: original.surface_type,
              shoulder_left: original.shoulder_left,
              shoulder_right: original.shoulder_right,
            })
            onSegmentEdited?.(original.road_id)
            showToast({ variant: 'info', message: `${original.road_id} segment reverted` })
          } catch (err) {
            showToast({ variant: 'danger', message: `Undo failed: ${err.message}` })
          }
        },
      })
    } catch (err) {
      showToast({ variant: 'danger', message: `Could not save: ${err.message}` })
    } finally {
      setSaving(false)
    }
  }

  function handleRowKeyDown(e, r) {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveEdit(r)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEdit()
    }
  }

  function sortAriaValue(key) {
    if (sort.sortBy !== key) return 'none'
    return sort.sortDir === 'asc' ? 'ascending' : 'descending'
  }

  return (
    <div className="panel inventory-table">
      <div className="panel-header-row">
        <h2>4. Road Inventory Data</h2>
        {segmentsPage && (
          <span className="page-summary">
            Page {segmentsPage.page} of {segmentsPage.total_pages} ({segmentsPage.total_records} records)
          </span>
        )}
      </div>

      <div className="filter-bar">
        <div className="filter-field filter-field-road">
          <span>Road</span>
          <CustomSelect
            size="sm"
            value={filters.roadId}
            onChange={(v) => updateFilter('roadId', v)}
            options={roadOptions}
            ariaLabel="Filter by road"
            disabled={roads.length === 0}
            searchable
            searchPlaceholder="Search road ID or name…"
            getSearchText={(o) => o.label}
            renderOption={(o) =>
              o.value === '' ? (
                o.label
              ) : (
                <div className="custom-select-road-option">
                  <span className="custom-select-road-id">{o.value}</span>
                  <span className="custom-select-road-name">{o.roadName}</span>
                </div>
              )
            }
          />
        </div>
        <div className="filter-field filter-field-narrow">
          <span>Status</span>
          <CustomSelect
            size="sm"
            value={filters.status}
            onChange={(v) => updateFilter('status', v)}
            options={STATUS_OPTIONS}
            ariaLabel="Filter by status"
            renderOption={(o) =>
              o.value === '' ? (
                o.label
              ) : (
                <span className={`status-badge ${o.value === 'Complete' ? 'status-badge-good' : 'status-badge-critical'}`}>
                  <span aria-hidden="true">{o.value === 'Complete' ? '✓' : '✕'}</span>
                  {o.label}
                </span>
              )
            }
          />
        </div>
        <div className="filter-field filter-field-surface">
          <span>Surface Type</span>
          <CustomSelect
            size="sm"
            value={filters.surfaceType}
            onChange={(v) => updateFilter('surfaceType', v)}
            options={surfaceOptions}
            ariaLabel="Filter by surface type"
            renderOption={(o) => (o.value === '' ? o.label : renderSurfaceOption(o))}
          />
        </div>
        {hasActiveFilters && (
          <div className="filter-action">
            <span className="filter-label-spacer">&nbsp;</span>
            <button className="filter-clear" onClick={clearFilters}>
              Clear filters
            </button>
          </div>
        )}
        <div className="filter-action filter-action-right">
          <span className="filter-label-spacer">&nbsp;</span>
          <a
            className="btn-compact export-csv-btn"
            href={getSegmentsExportUrl(filters, sort)}
            download
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 16V4m0 12-4-4m4 4 4-4M4 18v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Export CSV
          </a>
        </div>
      </div>

      <div
        className={`table-scroll thin-scroll${tableScrolledOver ? ' table-scroll-has-overflow' : ''}`}
        ref={tableScrollRef}
        onScroll={handleTableScroll}
      >
        <table>
          <thead>
            <tr>
              {COLUMNS.map((col, i) => (
                <th
                  key={col.label || `col-${i}`}
                  className={`${col.key ? 'sortable-th' : ''}${i === COLUMNS.length - 1 ? ' row-actions-header-cell' : ''}`}
                  aria-sort={col.key ? sortAriaValue(col.key) : undefined}
                >
                  {i === COLUMNS.length - 1 ? null : col.key ? (
                    <button type="button" className="th-sort" onClick={() => onSortChange(col.key)}>
                      <span className="th-label">{col.label}</span>
                      <SortIcon active={sort.sortBy === col.key} dir={sort.sortDir} />
                    </button>
                  ) : (
                    <span className="th-content">
                      <span className="th-label">{col.label}</span>
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {records.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} className="empty-row">
                  {roads.length === 0
                    ? 'No road data yet. Upload an Excel file to get started.'
                    : hasActiveFilters
                    ? 'No records match the selected filters.'
                    : 'No data. Upload an Excel file to begin.'}
                </td>
              </tr>
            )}
            {records.map((r) => {
              const isEditing = editingId === r.id
              return (
                <tr
                  key={`${r.road_id}-${r.index}`}
                  className={isEditing ? 'editing-row' : ''}
                  onKeyDown={isEditing ? (e) => handleRowKeyDown(e, r) : undefined}
                >
                  <td>{r.index}</td>
                  <td>{r.road_id}</td>
                  <td title={r.road_name}>{r.road_name}</td>
                  <td title="Edit stations via Excel upload.">{r.start_station}</td>
                  <td title="Edit stations via Excel upload.">{r.end_station}</td>
                  <td>
                    {isEditing ? (
                      <input
                        type="number"
                        min={1}
                        max={12}
                        className="inline-edit-number"
                        value={draft.num_lanes}
                        onChange={(e) => setDraft((d) => ({ ...d, num_lanes: Number(e.target.value) }))}
                        autoFocus
                      />
                    ) : (
                      r.num_lanes
                    )}
                  </td>
                  <td>
                    {isEditing ? (
                      <CustomSelect
                        size="sm"
                        value={draft.surface_type}
                        onChange={(v) => setDraft((d) => ({ ...d, surface_type: v }))}
                        options={SURFACE_EDIT_OPTIONS}
                        ariaLabel="Surface type"
                        renderOption={renderSurfaceOption}
                        triggerClassName="inline-edit-select"
                      />
                    ) : (
                      r.surface_type
                    )}
                  </td>
                  <td>
                    {isEditing ? (
                      <CustomSelect
                        size="sm"
                        value={draft.shoulder_left}
                        onChange={(v) => setDraft((d) => ({ ...d, shoulder_left: v }))}
                        options={SURFACE_EDIT_OPTIONS}
                        ariaLabel="Left shoulder"
                        renderOption={renderSurfaceOption}
                        triggerClassName="inline-edit-select"
                      />
                    ) : (
                      r.shoulder_left
                    )}
                  </td>
                  <td>
                    {isEditing ? (
                      <CustomSelect
                        size="sm"
                        value={draft.shoulder_right}
                        onChange={(v) => setDraft((d) => ({ ...d, shoulder_right: v }))}
                        options={SURFACE_EDIT_OPTIONS}
                        ariaLabel="Right shoulder"
                        renderOption={renderSurfaceOption}
                        triggerClassName="inline-edit-select"
                      />
                    ) : (
                      r.shoulder_right
                    )}
                  </td>
                  <td>
                    <span
                      className={`status-badge ${r.status === 'Complete' ? 'status-badge-good' : 'status-badge-critical'}`}
                      title={
                        r.status === 'Complete'
                          ? 'Complete = asphalt surface'
                          : `Incomplete = not yet asphalt (surface is "${r.surface_type}")`
                      }
                    >
                      <span aria-hidden="true">{r.status === 'Complete' ? '✓' : '✕'}</span>
                      {r.status}
                    </span>
                  </td>
                  <td
                    className="row-actions-cell"
                    ref={(el) => {
                      if (el) actionsCellRefs.current.set(r.id, el)
                      else actionsCellRefs.current.delete(r.id)
                    }}
                  >
                    <div className="row-actions-inner">
                      {isEditing ? (
                        <>
                          <button
                            type="button"
                            className="row-action-btn row-action-save"
                            onClick={() => saveEdit(r)}
                            disabled={saving}
                            title="Save"
                            aria-label="Save"
                          >
                            ✓
                          </button>
                          <button
                            type="button"
                            className="row-action-btn row-action-cancel"
                            onClick={cancelEdit}
                            title="Cancel"
                            aria-label="Cancel"
                          >
                            ✕
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="row-edit-btn"
                          ref={(el) => {
                            if (el) editBtnRefs.current.set(r.id, el)
                            else editBtnRefs.current.delete(r.id)
                          }}
                          onClick={() => startEdit(r)}
                          title="Edit segment"
                          aria-label="Edit segment"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {segmentsPage && (
        <Pagination
          page={segmentsPage.page}
          totalPages={segmentsPage.total_pages}
          totalRecords={segmentsPage.total_records}
          onPageChange={onPageChange}
        />
      )}
    </div>
  )
}
