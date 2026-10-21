import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getFullscreenPortalRoot } from '../../utils/fullscreenPortal'

const PANEL_WIDTH = 220
const GAP = 8

function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export default function UserMenu({ user, onSignOut, onOpenHistory, workspaceContext, onSwitchWorkspace }) {
  const [open, setOpen] = useState(false)
  const [ready, setReady] = useState(false)
  const [avatarFailed, setAvatarFailed] = useState(false)
  const [placement, setPlacement] = useState(null) // { top, left }
  const triggerRef = useRef(null)
  const panelRef = useRef(null)

  function close() {
    setOpen(false)
    setReady(false)
  }

  // Portal-rendered (not a CSS-absolute child of the trigger) so the panel
  // escapes .app-header's own overflow:hidden (used for its background
  // pattern) instead of being clipped by it -- the same reason CustomSelect
  // portals its own panel. Positioned from the trigger's live rect, right-
  // edge aligned, flipping horizontally inward if it would overflow the
  // viewport on a narrow screen.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const left = Math.min(Math.max(8, rect.right - PANEL_WIDTH), window.innerWidth - PANEL_WIDTH - 8)
    setPlacement({ top: rect.bottom + GAP, left })
    setReady(true)
  }, [open])

  useEffect(() => {
    if (!open) return
    function handlePointerDown(e) {
      if (triggerRef.current?.contains(e.target)) return
      if (panelRef.current?.contains(e.target)) return
      close()
    }
    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
        triggerRef.current?.focus()
      }
    }
    // Any outer-page scroll invalidates the computed position (the panel is
    // a short static list, never itself scrollable) -- just close it.
    function handleScroll(e) {
      if (panelRef.current?.contains(e.target)) return
      close()
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [open])

  const showImage = user.avatar_url && !avatarFailed

  return (
    <div className="user-menu">
      <button
        type="button"
        ref={triggerRef}
        className="user-menu-trigger"
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="true"
        aria-expanded={open}
        title={user.name}
      >
        {showImage ? (
          <img
            src={user.avatar_url}
            alt=""
            className="user-menu-avatar"
            onError={() => setAvatarFailed(true)}
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="user-menu-avatar user-menu-avatar-initials" aria-hidden="true">
            {initials(user.name)}
          </span>
        )}
        <span className="user-menu-name">{user.name.split(' ')[0]}</span>
      </button>

      {open &&
        placement &&
        createPortal(
          <div
            ref={panelRef}
            className={`user-menu-panel${ready ? ' user-menu-panel-ready' : ''}`}
            style={{ top: placement.top, left: placement.left, width: PANEL_WIDTH }}
            role="menu"
          >
            <div className="user-menu-identity">
              <div className="user-menu-identity-name">{user.name}</div>
              <div className="user-menu-identity-email">{user.email}</div>
            </div>
            <div className="user-menu-divider" />
            <div className="user-menu-section-label">Workspace</div>
            <button
              type="button"
              className="user-menu-item user-menu-workspace-item"
              role="menuitemradio"
              aria-checked={workspaceContext?.mode === 'own'}
              onClick={() => {
                close()
                onSwitchWorkspace?.(null)
              }}
            >
              <span className="user-menu-workspace-check" aria-hidden="true">
                {workspaceContext?.mode === 'own' ? '✓' : ''}
              </span>
              My data
            </button>
            {workspaceContext?.shared_with_me?.map((w) => (
              <button
                type="button"
                key={w.owner_user_id}
                className="user-menu-item user-menu-workspace-item"
                role="menuitemradio"
                aria-checked={workspaceContext?.mode === 'shared' && workspaceContext?.owner_user_id === w.owner_user_id}
                title={`${w.owner_name}'s data · ${w.role === 'editor' ? 'Editor' : 'Viewer'}`}
                onClick={() => {
                  close()
                  onSwitchWorkspace?.(w.owner_user_id)
                }}
              >
                <span className="user-menu-workspace-check" aria-hidden="true">
                  {workspaceContext?.mode === 'shared' && workspaceContext?.owner_user_id === w.owner_user_id ? '✓' : ''}
                </span>
                <span className="user-menu-workspace-label">
                  {w.owner_name}&rsquo;s data
                  <span className="user-menu-workspace-role"> · {w.role === 'editor' ? 'Editor' : 'Viewer'}</span>
                </span>
              </button>
            ))}
            <div className="user-menu-divider" />
            <button
              type="button"
              className="user-menu-item"
              role="menuitem"
              onClick={() => {
                close()
                onOpenHistory()
              }}
            >
              Upload history
            </button>
            <div className="user-menu-divider" />
            <button
              type="button"
              className="user-menu-item user-menu-item-danger"
              role="menuitem"
              onClick={() => {
                close()
                onSignOut()
              }}
            >
              Sign out
            </button>
          </div>,
          getFullscreenPortalRoot()
        )}
    </div>
  )
}
