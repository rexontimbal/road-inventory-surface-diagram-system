import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import CustomSelect from '../common/CustomSelect'
import { useModalLayer } from '../common/useModalLayer'
import { getFullscreenPortalRoot } from '../../utils/fullscreenPortal'
import { createShare, fetchShares, removeShare, updateShareRole } from '../../api/workspace'
import { showConfirm, showToast } from '../common/DialogProvider'

const ROLE_OPTIONS = [
  { value: 'viewer', label: 'Viewer' },
  { value: 'editor', label: 'Editor' },
]

function initials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function PersonAvatar({ name, avatarUrl, pending }) {
  const [failed, setFailed] = useState(false)
  if (avatarUrl && !failed) {
    return (
      <img
        src={avatarUrl}
        alt=""
        className="share-avatar"
        onError={() => setFailed(true)}
        referrerPolicy="no-referrer"
      />
    )
  }
  return (
    <span className={`share-avatar share-avatar-initials${pending ? ' share-avatar-pending' : ''}`} aria-hidden="true">
      {pending ? '…' : initials(name)}
    </span>
  )
}

/**
 * "Share" modal, opened from the header's Share button (only shown while
 * viewing your own workspace, since sharing always operates on the
 * CALLER's own data -- see app/routers/workspace.py's create_or_update_share).
 * Same bespoke modal-card skeleton as NetworkBreakdownModal: portaled,
 * backdrop-dismiss, its own z-index via useModalLayer.
 */
export default function ShareModal({ ownerName, ownerEmail, onClose }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('viewer')
  const [sharing, setSharing] = useState(false)
  const [data, setData] = useState(null) // { owner, people }
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const cardRef = useRef(null)
  const firstFocusableRef = useRef(null)
  const { zIndex, isTop } = useModalLayer()

  useEffect(() => {
    let cancelled = false
    fetchShares()
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .catch((err) => {
        if (!cancelled) showToast({ variant: 'danger', message: `Could not load sharing: ${err.message}` })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    firstFocusableRef.current?.focus()

    function handleKeyDown(e) {
      if (!isTop()) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key === 'Tab') {
        const focusable = cardRef.current?.querySelectorAll(
          'button, a[href], input, [tabindex]:not([tabindex="-1"])'
        )
        if (!focusable || focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = prevOverflow
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleShare(e) {
    e.preventDefault()
    const trimmed = email.trim()
    if (!trimmed) return
    setSharing(true)
    try {
      const person = await createShare(trimmed, role)
      setData((d) => {
        const people = d.people.filter((p) => p.id !== person.id)
        return { ...d, people: [...people, person] }
      })
      setEmail('')
      setRole('viewer')
      showToast({
        variant: 'success',
        message: person.pending
          ? `Invited ${trimmed} as ${person.role === 'editor' ? 'Editor' : 'Viewer'} -- access starts once they sign in.`
          : `Shared with ${person.name || trimmed} as ${person.role === 'editor' ? 'Editor' : 'Viewer'}`,
      })
    } catch (err) {
      showToast({ variant: 'danger', message: `Could not share: ${err.message}` })
    } finally {
      setSharing(false)
    }
  }

  async function handleRoleChange(person, newRole) {
    setBusyId(person.id)
    try {
      const updated = await updateShareRole(person.id, newRole)
      setData((d) => ({ ...d, people: d.people.map((p) => (p.id === updated.id ? updated : p)) }))
    } catch (err) {
      showToast({ variant: 'danger', message: `Could not update role: ${err.message}` })
    } finally {
      setBusyId(null)
    }
  }

  async function handleRemove(person) {
    const label = person.name || person.email
    const confirmed = await showConfirm({
      title: 'Remove access?',
      message: `${label} will no longer be able to view or edit this workspace.`,
      confirmText: 'Remove access',
      variant: 'danger',
    })
    if (!confirmed) return
    setBusyId(person.id)
    try {
      await removeShare(person.id)
      setData((d) => ({ ...d, people: d.people.filter((p) => p.id !== person.id) }))
      showToast({ variant: 'info', message: `Removed ${label}'s access` })
    } catch (err) {
      showToast({ variant: 'danger', message: `Could not remove access: ${err.message}` })
    } finally {
      setBusyId(null)
    }
  }

  if (zIndex == null) return null

  return createPortal(
    <div
      className="modal-backdrop no-print"
      style={{ zIndex }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="modal-card share-modal-card"
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-modal-title"
      >
        <div className="modal-header">
          <div className="modal-icon modal-icon-info" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M16 6a3 3 0 1 0-2.83-4H13A3 3 0 1 0 16 6ZM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm12 6a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8.6 13.5l6.8-3.9M8.6 14.5l6.8 3.9"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h3 id="share-modal-title" className="modal-title">
            Share
          </h3>
          <button
            type="button"
            ref={firstFocusableRef}
            className="history-modal-close"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            ×
          </button>
        </div>
        <p className="network-modal-subtitle">
          {ownerName ? `${ownerName}'s data` : 'Your data'}
          {ownerEmail ? ` (${ownerEmail})` : ''}
        </p>

        <form className="share-invite-row" onSubmit={handleShare}>
          <input
            type="email"
            className="share-email-input"
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <CustomSelect
            size="sm"
            value={role}
            onChange={setRole}
            options={ROLE_OPTIONS}
            ariaLabel="Role"
            triggerClassName="share-role-select"
          />
          <button type="submit" className="btn-compact share-btn" disabled={sharing || !email.trim()}>
            {sharing ? 'Sharing…' : 'Share'}
          </button>
        </form>

        <div className="share-people-label">People with access</div>
        <div className="share-people-list thin-scroll">
          {data?.owner && (
            <div className="share-person-row">
              <PersonAvatar name={data.owner.name} avatarUrl={data.owner.avatar_url} />
              <div className="share-person-identity">
                <div className="share-person-name">{data.owner.name}</div>
                <div className="share-person-email">{data.owner.email}</div>
              </div>
              <span className="share-owner-badge">Owner</span>
            </div>
          )}
          {loading && <div className="share-empty">Loading…</div>}
          {!loading && data?.people.length === 0 && (
            <div className="share-empty">Not shared with anyone yet.</div>
          )}
          {!loading &&
            data?.people.map((person) => (
              <div className="share-person-row" key={person.id}>
                <PersonAvatar name={person.name} avatarUrl={person.avatar_url} pending={person.pending} />
                <div className="share-person-identity">
                  <div className="share-person-name">
                    {person.name || person.email}
                    {person.pending && <span className="share-pending-badge">Invited</span>}
                  </div>
                  {person.name && <div className="share-person-email">{person.email}</div>}
                </div>
                <CustomSelect
                  size="sm"
                  value={person.role}
                  onChange={(v) => handleRoleChange(person, v)}
                  options={ROLE_OPTIONS}
                  ariaLabel={`Role for ${person.email}`}
                  triggerClassName="share-role-select"
                  disabled={busyId === person.id}
                />
                <button
                  type="button"
                  className="share-remove-btn"
                  onClick={() => handleRemove(person)}
                  disabled={busyId === person.id}
                  title="Remove access"
                  aria-label={`Remove ${person.email}'s access`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            ))}
        </div>
      </div>
    </div>,
    getFullscreenPortalRoot()
  )
}
