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
    const error = new Error(detail)
    // Lets callers distinguish "you're not allowed" (403, e.g. an Editor/
    // Viewer hitting an owner-only endpoint) from any other failure without
    // sniffing the message text -- used by Clear History's error toast.
    error.status = res.status
    throw error
  }
  return res.json()
}

function buildSegmentsParams(filters = {}, sort = {}) {
  const params = new URLSearchParams()
  if (filters.sectionId) params.set('section_id', filters.sectionId)
  if (filters.district) params.set('district', filters.district)
  if (filters.classification) params.set('classification', filters.classification)
  if (filters.status) params.set('status', filters.status)
  if (filters.surfaceType) params.set('surface_type', filters.surfaceType)
  if (filters.numLanes) params.set('num_lanes', filters.numLanes)
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
  if (filters.byUser) params.set('by_user', filters.byUser)
  return params
}

export async function fetchUploadLog(filters = {}, page = 1, pageSize = 10) {
  const params = buildUploadLogParams(filters)
  params.set('page', page)
  params.set('page_size', pageSize)
  const res = await fetch(`${BASE}/upload-log?${params.toString()}`, { credentials: 'include' })
  return handleResponse(res)
}

export async function fetchUploadLogUsers() {
  const res = await fetch(`${BASE}/upload-log/users`, { credentials: 'include' })
  return handleResponse(res)
}

export function getUploadLogExportUrl(filters = {}) {
  const params = buildUploadLogParams(filters)
  return `${BASE}/upload-log/export?${params.toString()}`
}

export async function clearUploadLog() {
  const res = await fetch(`${BASE}/upload-log`, { method: 'DELETE', credentials: 'include' })
  return handleResponse(res)
}

export async function fetchDeletePreview() {
  const res = await fetch(`${BASE}/delete-preview`, { credentials: 'include' })
  return handleResponse(res)
}

// district: null/undefined deletes everything in the active workspace;
// otherwise narrows to just that District (DEO).
export async function deleteAllRoads(district) {
  const params = district ? `?district=${encodeURIComponent(district)}` : ''
  const res = await fetch(`${BASE}${params}`, { method: 'DELETE', credentials: 'include' })
  return handleResponse(res)
}

export async function fetchRoadsList() {
  const res = await fetch(BASE)
  return handleResponse(res)
}

export async function fetchRoadDetail(sectionId) {
  const res = await fetch(`${BASE}/${encodeURIComponent(sectionId)}`)
  return handleResponse(res)
}

export async function deleteRoad(sectionId) {
  const res = await fetch(`${BASE}/${encodeURIComponent(sectionId)}`, { method: 'DELETE' })
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

export async function fetchFilteredSegmentsSummary(filters = {}) {
  const params = buildSegmentsParams(filters, {})
  const res = await fetch(`${BASE}/segments/summary?${params.toString()}`)
  return handleResponse(res)
}

export async function fetchLaneCounts() {
  const res = await fetch(`${BASE}/lane-counts`)
  return handleResponse(res)
}
