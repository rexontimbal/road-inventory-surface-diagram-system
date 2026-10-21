import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { showAlert } from './common/DialogProvider'
import SignInModal from './auth/SignInModal'
import UserMenu from './auth/UserMenu'

// Two thresholds (not one) so a scroll position that lands between them can't
// flip the header back and forth -- it only switches state when scrollY
// crosses OUT of the dead zone in one direction.
const SHRINK_ON_Y = 60
const EXPAND_BELOW_Y = 20

const HOW_TO_USE_STEPS = [
  { title: 'Upload', detail: 'Upload your road inventory Excel file in "1. Upload Excel File".' },
  { title: 'Select section', detail: 'Pick a District, then a Section ID from "2. Select Section" to load its segments.' },
  { title: 'Set range', detail: 'Adjust the Start/End Station and diagram settings in "3. Diagram Settings".' },
  { title: 'Generate', detail: 'Click "Generate Road Surface Diagram" to draw the strip map.' },
  { title: 'Print / Export', detail: 'Use "Print / PDF" or "Export PNG" above the diagram to save it.' },
]

const KEYBOARD_SHORTCUTS = [
  { keys: '/', detail: 'Focus the Section filter' },
  { keys: 'G', detail: 'Generate the diagram (when enabled)' },
  { keys: 'F', detail: 'Open the diagram fullscreen (when generated)' },
  { keys: 'U', detail: 'Open Choose Excel File' },
  { keys: 'H', detail: 'Open Upload History' },
  { keys: '?', detail: 'Open this help' },
]

export function openHowToUse() {
  showAlert({
    title: 'How to use this system',
    confirmText: 'Got it',
    variant: 'info',
    message: (
      <>
        <ol className="how-to-use-list">
          {HOW_TO_USE_STEPS.map((step, i) => (
            <li key={step.title}>
              <span className="how-to-use-step-n">{i + 1}</span>
              <span>
                <strong>{step.title}.</strong> {step.detail}
              </span>
            </li>
          ))}
        </ol>
        <div className="how-to-use-shortcuts">
          <strong>Keyboard shortcuts</strong>
          <ul className="shortcut-list">
            {KEYBOARD_SHORTCUTS.map((s) => (
              <li key={s.keys}>
                <kbd>{s.keys}</kbd>
                <span>{s.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      </>
    ),
  })
}

const Header = forwardRef(function Header(
  {
    summary,
    onOpenNetworkBreakdown,
    authUser,
    authChecked,
    onGoogleCredential,
    onSignOut,
    onOpenHistory,
    workspaceContext,
    onSwitchWorkspace,
    onOpenShare,
    notifications,
    onDropdownClose,
  },
  ref
) {
  const [shrunk, setShrunk] = useState(false)
  const [signInOpen, setSignInOpen] = useState(false)
  const shrunkRef = useRef(false)
  const tickingRef = useRef(false)
  // Sharing always operates on the CALLER's own workspace (see
  // app/routers/workspace.py) -- the button only makes sense while viewing
  // your own data, not someone else's shared-with-you workspace.
  const canShare = authUser && workspaceContext?.mode === 'own'

  // Lets GuestNotice's "Sign in" link (a sibling of Header, not a child)
  // open this same modal instead of duplicating sign-in UI elsewhere.
  useImperativeHandle(ref, () => ({
    openSignIn: () => setSignInOpen(true),
  }))

  useEffect(() => {
    function applyScrollState() {
      tickingRef.current = false
      const y = window.scrollY
      // Hysteresis: only cross state in one direction per threshold, so a
      // scrollY sitting in the 20-60 dead zone (which the header's own
      // shrink/expand can nudge by a few px via rounding/layout) never
      // flips the state back and forth.
      if (!shrunkRef.current && y > SHRINK_ON_Y) {
        shrunkRef.current = true
        setShrunk(true)
      } else if (shrunkRef.current && y < EXPAND_BELOW_Y) {
        shrunkRef.current = false
        setShrunk(false)
      }
    }

    function handleScroll() {
      if (tickingRef.current) return
      tickingRef.current = true
      window.requestAnimationFrame(applyScrollState)
    }

    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  const hasStats = !!summary && summary.roads.length > 0

  return (
    <>
    <header className={`app-header no-print${shrunk ? ' app-header-shrunk' : ''}`}>
      <div className="app-header-inner">
        <div className="app-header-brand">
          <div className="app-logo-wrap">
            <img src="/favicon.svg" alt="" width="24" height="24" className="app-logo" />
          </div>
          <div className="app-header-title-col">
            <h1>Road Inventory &amp; Surface Diagram System</h1>
            <p>Excel-Based Road Inventory Management</p>
          </div>
        </div>

        <div className="app-header-right">
          {hasStats && (
            <>
              <div className="header-stats">
                <span className="header-stat-chip">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M6 19 11 5m2 0 5 14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {summary.roads.length} section{summary.roads.length !== 1 ? 's' : ''}
                </span>
                <span className="header-stat-chip">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M4 12h16M7 9v6M11 9v6M15 9v6M17 9v6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {(summary.total_length_m / 1000).toFixed(1)} km
                </span>
                <button
                  type="button"
                  className="header-stat-chip header-stat-chip-good header-stat-chip-toggle"
                  onClick={onOpenNetworkBreakdown}
                  title="Show network breakdown"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="m6 12 4 4 8-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {summary.pct}% asphalted
                  <svg
                    className="header-stat-chip-chevron"
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            </>
          )}
          <button
            type="button"
            className="header-help-btn"
            title="How to use this system"
            aria-label="How to use this system"
            onClick={openHowToUse}
          >
            ?
          </button>
          {canShare && (
            <button type="button" className="btn-compact header-share-btn" onClick={onOpenShare}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M16 6a3 3 0 1 0-2.83-4H13A3 3 0 1 0 16 6ZM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm12 6a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8.6 13.5l6.8-3.9M8.6 14.5l6.8 3.9"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Share
            </button>
          )}
          {!authChecked ? (
            <span className="header-auth-skeleton" aria-hidden="true" />
          ) : authUser ? (
            <UserMenu
              user={authUser}
              onSignOut={onSignOut}
              onOpenHistory={onOpenHistory}
              workspaceContext={workspaceContext}
              onSwitchWorkspace={onSwitchWorkspace}
              notifications={notifications}
              onDropdownClose={onDropdownClose}
            />
          ) : (
            <button type="button" className="header-signin-btn" onClick={() => setSignInOpen(true)}>
              <svg className="header-signin-btn-icon" width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
                <path
                  fill="#FFC107"
                  d="M43.6 20.5H42V20H24v8h11.3C33.8 32.9 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.1 8.1 3l5.7-5.7C34.5 6.1 29.5 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20c11 0 19.6-8 19.6-20 0-1.3-.1-2.7-.4-3.5z"
                />
                <path
                  fill="#FF3D00"
                  d="M6.3 14.7l6.6 4.8C14.5 15.1 18.9 12 24 12c3.1 0 5.9 1.1 8.1 3l5.7-5.7C34.5 6.1 29.5 4 24 4 16.3 4 9.6 8.3 6.3 14.7z"
                />
                <path
                  fill="#4CAF50"
                  d="M24 44c5.2 0 9.9-1.8 13.6-4.9l-6.3-5.2C29.2 35.6 26.7 36 24 36c-5.3 0-9.7-3.1-11.3-7.5l-6.5 5C9.4 39.6 16.1 44 24 44z"
                />
                <path
                  fill="#1976D2"
                  d="M43.6 20.5H42V20H24v8h11.3c-1 2.7-2.9 5-5.3 6.4l6.3 5.2C39.6 36.7 44 30.9 44 24c0-1.3-.1-2.7-.4-3.5z"
                />
              </svg>
              Sign in
            </button>
          )}
        </div>
      </div>
    </header>
    <div className="app-header-spacer no-print" aria-hidden="true" />
    {signInOpen && (
      <SignInModal
        onClose={() => setSignInOpen(false)}
        onCredential={onGoogleCredential}
      />
    )}
    </>
  )
})

export default Header
