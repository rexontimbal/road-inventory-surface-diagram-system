// Rendered in normal document flow right after the header's own spacer,
// same placement rule as GuestNotice (never position:fixed/sticky -- see
// that component's comment for why).
export default function WorkspaceBanner({ context, onBackToMine }) {
  if (!context || context.mode !== 'shared') return null

  const roleLabel = context.role === 'editor' ? 'Editor' : 'View only'

  return (
    <div className="workspace-banner no-print">
      <span className="workspace-banner-text">
        <span className="workspace-banner-icon" aria-hidden="true">
          👁
        </span>
        Viewing {context.owner_name}&rsquo;s data &middot; {roleLabel}
      </span>
      <button type="button" className="workspace-banner-link" onClick={onBackToMine}>
        Back to my data
      </button>
    </div>
  )
}
