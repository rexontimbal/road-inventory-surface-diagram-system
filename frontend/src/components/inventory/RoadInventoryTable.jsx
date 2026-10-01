import Pagination from './Pagination'
import { getSegmentsExportUrl } from '../../api/roads'

const SURFACE_TYPE_OPTIONS = ['unpaved', 'paved', 'gravel', 'asphalt']

const COLUMNS = [
  { label: '#', key: null },
  { label: 'ROAD ID', key: 'road_id' },
  { label: 'Road Name', key: 'road_name' },
  { label: 'Start Station', key: 'start_station' },
  { label: 'End Station', key: 'end_station' },
  { label: 'Number of Lanes', key: 'num_lanes' },
  { label: 'Surface Type', key: 'surface_type' },
  { label: 'Left Shoulder', key: null },
  { label: 'Right Shoulder', key: null },
  { label: 'Status', key: 'status' },
]

export default function RoadInventoryTable({
  segmentsPage,
  onPageChange,
  roads,
  filters,
  onFilterChange,
  sort,
  onSortChange,
}) {
  const records = segmentsPage?.records || []
  const hasActiveFilters = !!(filters.roadId || filters.status || filters.surfaceType)

  function updateFilter(key, value) {
    onFilterChange({ ...filters, [key]: value })
  }

  function clearFilters() {
    onFilterChange({ roadId: '', status: '', surfaceType: '' })
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
        <label className="filter-field">
          <span>Road</span>
          <select value={filters.roadId} onChange={(e) => updateFilter('roadId', e.target.value)}>
            <option value="">All roads</option>
            {roads.map((r) => (
              <option key={r.road_id} value={r.road_id}>
                {r.road_id} — {r.road_name}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          <span>Status</span>
          <select value={filters.status} onChange={(e) => updateFilter('status', e.target.value)}>
            <option value="">All statuses</option>
            <option value="Complete">Complete</option>
            <option value="Incomplete">Incomplete</option>
          </select>
        </label>
        <label className="filter-field">
          <span>Surface Type</span>
          <select value={filters.surfaceType} onChange={(e) => updateFilter('surfaceType', e.target.value)}>
            <option value="">All surface types</option>
            {SURFACE_TYPE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        </label>
        {hasActiveFilters && (
          <button className="filter-clear" onClick={clearFilters}>
            Clear filters
          </button>
        )}
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

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {COLUMNS.map((col) => (
                <th
                  key={col.label}
                  className={col.key ? 'sortable-th' : ''}
                  onClick={col.key ? () => onSortChange(col.key) : undefined}
                >
                  {col.label}
                  {col.key && sort.sortBy === col.key && (
                    <span className="sort-arrow">{sort.sortDir === 'asc' ? ' ▲' : ' ▼'}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {records.length === 0 && (
              <tr>
                <td colSpan={10} className="empty-row">
                  {hasActiveFilters
                    ? 'No records match the selected filters.'
                    : 'No data. Upload an Excel file to begin.'}
                </td>
              </tr>
            )}
            {records.map((r) => (
              <tr key={`${r.road_id}-${r.index}`}>
                <td>{r.index}</td>
                <td>{r.road_id}</td>
                <td>{r.road_name}</td>
                <td>{r.start_station}</td>
                <td>{r.end_station}</td>
                <td>{r.num_lanes}</td>
                <td>{r.surface_type}</td>
                <td>{r.shoulder_left}</td>
                <td>{r.shoulder_right}</td>
                <td>
                  <span className={`status-badge ${r.status === 'Complete' ? 'status-badge-good' : 'status-badge-critical'}`}>
                    <span aria-hidden="true">{r.status === 'Complete' ? '✓' : '✕'}</span>
                    {r.status}
                  </span>
                </td>
              </tr>
            ))}
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
