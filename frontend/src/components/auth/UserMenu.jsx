import { useEffect, useRef, useState } from 'react'

function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export default function UserMenu({ user, onSignOut, onOpenHistory }) {
  const [open, setOpen] = useState(false)
  const [avatarFailed, setAvatarFailed] = useState(false)
  const wrapRef = useRef(null)

  useEffect(() => {
    if (!open) return
    function handleOutside(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    function handleKeyDown(e) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const showImage = user.avatar_url && !avatarFailed

  return (
    <div className="user-menu" ref={wrapRef}>
      <button
        type="button"
        className="user-menu-trigger"
        onClick={() => setOpen((o) => !o)}
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

      {open && (
        <div className="user-menu-panel" role="menu">
          <div className="user-menu-identity">
            <div className="user-menu-identity-name">{user.name}</div>
            <div className="user-menu-identity-email">{user.email}</div>
          </div>
          <div className="user-menu-divider" />
          <button
            type="button"
            className="user-menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false)
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
              setOpen(false)
              onSignOut()
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}
