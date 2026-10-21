// Rendered in normal document flow right after the header's own spacer,
// same placement rule as GuestNotice (never position:fixed/sticky -- see
// that component's comment for why).
export default function WorkspaceBanner({ context, onBackToMine }) {
  if (!context || context.mode !== 'shared') return null

  const roleLabel = context.role === 'editor' ? 'Editor' : 'View only'

  return (
    <div className="workspace-banner no-print">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
      </svg>
      <span>
        Viewing {context.owner_name}&rsquo;s data · {roleLabel}
      </span>
      <button type="button" className="workspace-banner-link" onClick={onBackToMine}>
        Back to my data
      </button>
    </div>
  )
}
