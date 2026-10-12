import CustomSelect from '../common/CustomSelect'

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
        <div className="pagination-size">
          <span>Rows per page</span>
          <CustomSelect
            size="sm"
            value={pageSize}
            onChange={(v) => onPageSizeChange(Number(v))}
            options={pageSizeOptions.map((n) => ({ value: n, label: String(n) }))}
            ariaLabel="Rows per page"
            triggerClassName="pagination-size-select"
          />
        </div>
      )}
    </div>
  )
}
