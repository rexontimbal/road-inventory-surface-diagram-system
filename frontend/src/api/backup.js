const BASE = '/api/backup'

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

export async function exportBackup(district) {
  const url = district ? `${BASE}/export?district=${encodeURIComponent(district)}` : `${BASE}/export`
  const res = await fetch(url)
  return handleResponse(res)
}

export async function previewRestore(backup) {
  const res = await fetch(`${BASE}/restore/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backup }),
  })
  return handleResponse(res)
}

export async function commitRestore(token, mode, decisions) {
  const res = await fetch(`${BASE}/restore/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, mode, decisions }),
  })
  return handleResponse(res)
}
