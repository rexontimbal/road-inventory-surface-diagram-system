const BASE = '/api/guest'

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

export async function fetchGuestStatus() {
  const res = await fetch(`${BASE}/status`, { credentials: 'include' })
  return handleResponse(res)
}

export async function previewGuestMerge() {
  const res = await fetch(`${BASE}/merge/preview`, { method: 'POST', credentials: 'include' })
  return handleResponse(res)
}

export async function commitGuestMerge(decisions) {
  const res = await fetch(`${BASE}/merge/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ decisions }),
  })
  return handleResponse(res)
}

export async function discardGuestData() {
  const res = await fetch(`${BASE}/discard`, { method: 'POST', credentials: 'include' })
  return handleResponse(res)
}
