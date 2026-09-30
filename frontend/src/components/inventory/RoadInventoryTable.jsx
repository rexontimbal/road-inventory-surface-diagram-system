import Pagination from './Pagination'

export default function RoadInventoryTable({ segmentsPage, onPageChange }) {
  const records = segmentsPage?.records || []

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
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>ROAD ID</th>
              <th>Road Name</th>
              <th>Start Station</th>
              <th>End Station</th>
              <th>Number of Lanes</th>
              <th>Surface Type</th>
              <th>Left Shoulder</th>
              <th>Right Shoulder</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {records.length === 0 && (
              <tr>
                <td colSpan={10} className="empty-row">
                  No data. Upload an Excel file to begin.
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
