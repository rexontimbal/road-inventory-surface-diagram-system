export default function Pagination({
  page,
  totalPages,
  totalRecords,
  onPageChange,
  pageSize,
  onPageSizeChange,
  pageSizeOptions,
  itemLabel = 'records',
}) {
  return (
    <div className="pagination">
      <button onClick={() => onPageChange(page - 1)} disabled={page <= 1}>
        ◀ Previous
      </button>
      <span>
        Page {page} of {totalPages} ({totalRecords} {itemLabel})
      </span>
      <button onClick={() => onPageChange(page + 1)} disabled={page >= totalPages}>
        Next ▶
      </button>
      {pageSizeOptions && (
        <label className="pagination-size">
          Rows per page
          <select value={pageSize} onChange={(e) => onPageSizeChange(Number(e.target.value))}>
            {pageSizeOptions.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  )
}
