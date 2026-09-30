export default function Pagination({ page, totalPages, totalRecords, onPageChange }) {
  return (
    <div className="pagination">
      <button onClick={() => onPageChange(page - 1)} disabled={page <= 1}>
        ◀ Previous
      </button>
      <span>
        Page {page} of {totalPages} ({totalRecords} records)
      </span>
      <button onClick={() => onPageChange(page + 1)} disabled={page >= totalPages}>
        Next ▶
      </button>
    </div>
  )
}
