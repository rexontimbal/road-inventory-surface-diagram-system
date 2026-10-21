const BASE = '/api/workspace'

async function handleResponse(res) {
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail = body.detail || JSON.stringify(body)
    } catch {
      // ignore body parse failure, fall back to statusText
    }
    throw new Error(detail)
  }
  return res.json()
}

export async function fetchWorkspaceContext() {
  const res = await fetch(`${BASE}/context`, { credentials: 'include' })
  return handleResponse(res)
}

// ownerUserId: null switches back to "my own data".
export async function switchWorkspace(ownerUserId) {
  const res = await fetch(`${BASE}/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ owner_user_id: ownerUserId }),
  })
  return handleResponse(res)
}

export async function fetchNotifications() {
  const res = await fetch(`${BASE}/notifications`, { credentials: 'include' })
  return handleResponse(res)
}

// shareId: null marks every unseen share seen; a specific id marks just that one.
export async function markNotificationsSeen(shareId = null) {
  const res = await fetch(`${BASE}/notifications/seen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ share_id: shareId }),
  })
  return handleResponse(res)
}

export async function fetchShares() {
  const res = await fetch(`${BASE}/shares`, { credentials: 'include' })
  return handleResponse(res)
}

export async function createShare(email, role) {
  const res = await fetch(`${BASE}/shares`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, role }),
  })
  return handleResponse(res)
}

export async function updateShareRole(shareId, role) {
  const res = await fetch(`${BASE}/shares/${shareId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ role }),
  })
  return handleResponse(res)
}

export async function removeShare(shareId) {
  const res = await fetch(`${BASE}/shares/${shareId}`, { method: 'DELETE', credentials: 'include' })
  return handleResponse(res)
}
