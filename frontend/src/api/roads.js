const BASE = '/api/roads'

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

export async function uploadExcel(file) {
  const formData = new FormData()
  formData.append('file', file)
  const res = await fetch(`${BASE}/upload`, { method: 'POST', body: formData })
  return handleResponse(res)
}

export async function fetchRoadsList() {
  const res = await fetch(BASE)
  return handleResponse(res)
}

export async function fetchRoadDetail(roadId) {
  const res = await fetch(`${BASE}/${encodeURIComponent(roadId)}`)
  return handleResponse(res)
}

export async function fetchSegmentsPage(page, pageSize) {
  const res = await fetch(`${BASE}/segments?page=${page}&page_size=${pageSize}`)
  return handleResponse(res)
}
