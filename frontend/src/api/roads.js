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

export async function previewUpload(file) {
  const formData = new FormData()
  formData.append('file', file)
  const res = await fetch(`${BASE}/upload/preview`, { method: 'POST', body: formData })
  return handleResponse(res)
}

export async function commitUpload(token, decisions) {
  const res = await fetch(`${BASE}/upload/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, decisions }),
  })
  return handleResponse(res)
}

export async function cancelUpload(token) {
  const res = await fetch(`${BASE}/upload/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  return handleResponse(res)
}

function buildUploadLogParams(filters = {}) {
  const params = new URLSearchParams()
  if (filters.search) params.set('search', filters.search)
  if (filters.action) params.set('action', filters.action)
  if (filters.dateRange) params.set('date_range', filters.dateRange)
  return params
}

export async function fetchUploadLog(filters = {}, page = 1, pageSize = 10) {
  const params = buildUploadLogParams(filters)
  params.set('page', page)
  params.set('page_size', pageSize)
  const res = await fetch(`${BASE}/upload-log?${params.toString()}`)
  return handleResponse(res)
}

export function getUploadLogExportUrl(filters = {}) {
  const params = buildUploadLogParams(filters)
  return `${BASE}/upload-log/export?${params.toString()}`
}

export async function clearUploadLog() {
  const res = await fetch(`${BASE}/upload-log`, { method: 'DELETE' })
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

export async function editSegment(segmentId, fields) {
  const res = await fetch(`${BASE}/segments/${segmentId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
  return handleResponse(res)
}

export async function fetchNetworkSummary() {
  const res = await fetch(`${BASE}/summary`)
  return handleResponse(res)
}
