const BASE = '/api/auth'

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

export async function signInWithGoogle(idToken) {
  const res = await fetch(`${BASE}/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ id_token: idToken }),
  })
  return handleResponse(res)
}

export async function fetchMe() {
  const res = await fetch(`${BASE}/me`, { credentials: 'include' })
  return handleResponse(res)
}

export async function signOut() {
  const res = await fetch(`${BASE}/logout`, { method: 'POST', credentials: 'include' })
  return handleResponse(res)
}
