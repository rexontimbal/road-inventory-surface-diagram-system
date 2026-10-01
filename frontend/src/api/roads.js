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

function buildSegmentsParams(filters = {}, sort = {}) {
  const params = new URLSearchParams()
  if (filters.roadId) params.set('road_id', filters.roadId)
  if (filters.status) params.set('status', filters.status)
  if (filters.surfaceType) params.set('surface_type', filters.surfaceType)
  if (sort.sortBy) {
    params.set('sort_by', sort.sortBy)
    params.set('sort_dir', sort.sortDir || 'asc')
  }
  return params
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

export async function deleteRoad(roadId) {
  const res = await fetch(`${BASE}/${encodeURIComponent(roadId)}`, { method: 'DELETE' })
  return handleResponse(res)
}

export async function fetchSegmentsPage(page, pageSize, filters = {}, sort = {}) {
  const params = buildSegmentsParams(filters, sort)
  params.set('page', page)
  params.set('page_size', pageSize)
  const res = await fetch(`${BASE}/segments?${params.toString()}`)
  return handleResponse(res)
}

export function getSegmentsExportUrl(filters = {}, sort = {}) {
  const params = buildSegmentsParams(filters, sort)
  return `${BASE}/segments/export?${params.toString()}`
}

export async function fetchNetworkSummary() {
  const res = await fetch(`${BASE}/summary`)
  return handleResponse(res)
}
