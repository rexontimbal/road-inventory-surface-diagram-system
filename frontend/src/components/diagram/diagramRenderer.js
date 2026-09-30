import { fillForCell } from './surfacePatterns'

const STRIP_WIDTH_PX = 1200
const LEFT_MARGIN = 90
const RIGHT_MARGIN = 20
const TOP_MARGIN = 10
const HEADER_H = 24
const STATUS_STRIP_H = 6
const SHOULDER_H = 22
const LANE_H = 22
const STRIP_GAP = 44
const BORDER_COLOR = '#333333'
const MARKING_COLOR = 'rgba(255,255,255,0.75)'
const ARROW_SPACING_PX = 70
const MARKED_SURFACES = new Set(['asphalt', 'paved']) // surfaces with painted lane markings
const STATUS_DONE_COLOR = '#0ca30c'
const STATUS_NOT_DONE_COLOR = '#d03b3b'

function formatStationLabel(meters) {
  const km = Math.floor(meters / 1000)
  const m = meters % 1000
  return `Sta. ${km}+${String(m).padStart(3, '0')}`
}

// Round to whole device pixels so adjacent clipped segments share an exact
// edge (no 1px seams/overlaps from independently-rounded floats) and strokes
// render crisp instead of anti-aliased/blurry.
function px(v) {
  return Math.round(v)
}

// Shared layout math used by both the combined multi-strip canvas (on-screen
// view) and the one-canvas-per-strip print path.
function computeStripPlan(road, settings) {
  const { stationIntervalM, stationsPerLine } = settings
  const stripSpanM = stationIntervalM * stationsPerLine
  const totalLengthM = road.total_length_m
  const numStrips = totalLengthM > 0 ? Math.ceil(totalLengthM / stripSpanM) : 0
  const globalMaxLanes = road.segments.length
    ? Math.max(...road.segments.map((s) => s.num_lanes))
    : 0
  const laneBandH = globalMaxLanes * LANE_H
  const stripHeight = HEADER_H + STATUS_STRIP_H + SHOULDER_H + laneBandH + SHOULDER_H
  const canvasWidth = LEFT_MARGIN + STRIP_WIDTH_PX + RIGHT_MARGIN
  return { stripSpanM, totalLengthM, numStrips, globalMaxLanes, laneBandH, stripHeight, canvasWidth }
}

export function getNumStrips(road, settings) {
  return computeStripPlan(road, settings).numStrips
}

// Renders exactly one strip (one page's worth) onto `canvas`, sized to fit
// just that strip -- used for print, where each strip becomes its own page
// instead of one tall image the browser would otherwise paginate awkwardly
// (leaving a near-blank leading page before the image "fits").
export function renderSingleStrip(canvas, road, settings, stripIndex) {
  const ctx = canvas.getContext('2d')
  const plan = computeStripPlan(road, settings)
  const pxPerMeter = STRIP_WIDTH_PX / plan.stripSpanM

  canvas.width = plan.canvasWidth
  canvas.height = TOP_MARGIN + plan.stripHeight + 10

  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.textBaseline = 'middle'
  ctx.font = '11px sans-serif'

  const stripStartM = stripIndex * plan.stripSpanM
  const stripEndM = Math.min((stripIndex + 1) * plan.stripSpanM, plan.totalLengthM)

  drawStrip(ctx, {
    x0: LEFT_MARGIN,
    y0: TOP_MARGIN,
    stripStartM,
    stripEndM,
    pxPerMeter,
    stationIntervalM: settings.stationIntervalM,
    segments: road.segments,
    globalMaxLanes: plan.globalMaxLanes,
    laneBandH: plan.laneBandH,
    hitRegions: [],
  })
}

/**
 * Renders the strip-map road surface diagram onto `canvas`.
 * `road` = { total_length_m, segments: [{start_m, end_m, num_lanes,
 *   surface_type, shoulder_left, shoulder_right}] } (segments must already be
 *   sorted by start_m, as returned by GET /api/roads/{road_id}).
 * `settings` = { stationIntervalM, stationsPerLine }.
 */
export function renderDiagram(canvas, road, settings) {
  const ctx = canvas.getContext('2d')
  const { stationIntervalM, stationsPerLine } = settings
  const stripSpanM = stationIntervalM * stationsPerLine
  const totalLengthM = road.total_length_m
  const segments = road.segments

  if (totalLengthM <= 0 || segments.length === 0) {
    canvas.width = 0
    canvas.height = 0
    return { hitRegions: [] }
  }

  const numStrips = Math.ceil(totalLengthM / stripSpanM)
  const globalMaxLanes = Math.max(...segments.map((s) => s.num_lanes))
  const laneBandH = globalMaxLanes * LANE_H
  const stripHeight = HEADER_H + STATUS_STRIP_H + SHOULDER_H + laneBandH + SHOULDER_H

  canvas.width = LEFT_MARGIN + STRIP_WIDTH_PX + RIGHT_MARGIN
  canvas.height = TOP_MARGIN + numStrips * stripHeight + (numStrips - 1) * STRIP_GAP + 10

  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.textBaseline = 'middle'
  ctx.font = '11px sans-serif'

  const hitRegions = []

  for (let s = 0; s < numStrips; s++) {
    // Anchor each strip's meter-grid to whole-pixel boundaries at the strip
    // start so station ticks land exactly on-pixel too, not just the fills.
    const stripStartM = s * stripSpanM
    const stripEndM = Math.min((s + 1) * stripSpanM, totalLengthM)
    const pxPerMeter = STRIP_WIDTH_PX / stripSpanM
    const y0 = TOP_MARGIN + s * (stripHeight + STRIP_GAP)

    drawStrip(ctx, {
      x0: LEFT_MARGIN,
      y0,
      stripStartM,
      stripEndM,
      pxPerMeter,
      stationIntervalM,
      segments,
      globalMaxLanes,
      laneBandH,
      hitRegions,
    })
  }

  return { hitRegions }
}

function drawStrip(ctx, cfg) {
  const {
    x0,
    y0,
    stripStartM,
    stripEndM,
    pxPerMeter,
    stationIntervalM,
    segments,
    globalMaxLanes,
    laneBandH,
    hitRegions,
  } = cfg

  const statusStripY = y0 + HEADER_H
  const topShoulderY = statusStripY + STATUS_STRIP_H
  const laneBandTop = topShoulderY + SHOULDER_H

  // Row labels (left margin)
  ctx.fillStyle = '#000000'
  ctx.textAlign = 'right'
  ctx.fillText('Shoulder', x0 - 6, topShoulderY + SHOULDER_H / 2)
  for (let li = 0; li < globalMaxLanes; li++) {
    ctx.fillText(`Lane ${li + 1}`, x0 - 6, laneBandTop + li * LANE_H + LANE_H / 2)
  }
  ctx.fillText('Shoulder', x0 - 6, laneBandTop + laneBandH + SHOULDER_H / 2)
  ctx.textAlign = 'left'

  // Station header ticks/labels -- meters converted to px from the same
  // stripStartM origin used for the segment fills, so ticks and fills never drift apart.
  ctx.strokeStyle = BORDER_COLOR
  ctx.fillStyle = '#000000'
  for (let m = stripStartM; m <= stripEndM; m += stationIntervalM) {
    const x = px(x0 + (m - stripStartM) * pxPerMeter)
    ctx.beginPath()
    ctx.moveTo(x, y0 + HEADER_H - 6)
    ctx.lineTo(x, y0 + HEADER_H)
    ctx.stroke()
    ctx.save()
    ctx.textAlign = m === stripStartM ? 'left' : 'center'
    ctx.fillText(formatStationLabel(m), x, y0 + HEADER_H / 2)
    ctx.restore()
  }

  // Clip segments into this strip and draw each clipped column
  for (const seg of segments) {
    const clippedStart = Math.max(seg.start_m, stripStartM)
    const clippedEnd = Math.min(seg.end_m, stripEndM)
    if (clippedEnd <= clippedStart) continue

    const x = px(x0 + (clippedStart - stripStartM) * pxPerMeter)
    const xEnd = px(x0 + (clippedEnd - stripStartM) * pxPerMeter)
    const w = xEnd - x

    // Done/not-done status strip -- independent of the surface-type legend
    // colors, so progress reads at a glance without reinterpreting materials.
    const isDone = seg.surface_type === 'asphalt'
    ctx.fillStyle = isDone ? STATUS_DONE_COLOR : STATUS_NOT_DONE_COLOR
    ctx.fillRect(x, statusStripY, w, STATUS_STRIP_H)

    // Top shoulder
    paintCell(ctx, x, topShoulderY, w, SHOULDER_H, seg.shoulder_right)
    if (MARKED_SURFACES.has(seg.shoulder_right)) {
      drawRumbleStrip(ctx, x, w, topShoulderY + SHOULDER_H, 'down')
    }

    // Lane rows, centered within the global lane band
    const offset = Math.floor((globalMaxLanes - seg.num_lanes) / 2)
    for (let li = 0; li < seg.num_lanes; li++) {
      const y = laneBandTop + (offset + li) * LANE_H
      paintCell(ctx, x, y, w, LANE_H, seg.surface_type)
    }

    // Bottom shoulder
    const bottomShoulderY = laneBandTop + laneBandH
    paintCell(ctx, x, bottomShoulderY, w, SHOULDER_H, seg.shoulder_left)
    if (MARKED_SURFACES.has(seg.shoulder_left)) {
      drawRumbleStrip(ctx, x, w, bottomShoulderY, 'up')
    }

    if (MARKED_SURFACES.has(seg.surface_type)) {
      drawLaneMarkings(ctx, { x, w, laneBandTop, offset, numLanes: seg.num_lanes })
    }

    // Outer border around the full column (shoulder-to-shoulder)
    ctx.strokeStyle = BORDER_COLOR
    ctx.lineWidth = 1
    ctx.strokeRect(x, topShoulderY, w, SHOULDER_H + laneBandH + SHOULDER_H)

    hitRegions.push({
      x,
      y: statusStripY,
      w,
      h: STATUS_STRIP_H + SHOULDER_H + laneBandH + SHOULDER_H,
      segment: seg,
      isDone,
    })
  }
}

// Real-road-style paint markings: solid white edge lines at the shoulder
// boundary, thin dashed white lines between same-direction lanes, a double
// dashed centerline at the direction split (the standard no-passing-zone
// convention), and filled directional arrows per lane. Only called for
// surfaces that would actually carry paint (asphalt/paved) -- unpaved/gravel
// are left bare, which is itself realistic.
function drawLaneMarkings(ctx, { x, w, laneBandTop, offset, numLanes }) {
  const laneTop = laneBandTop + offset * LANE_H
  const laneBottom = laneBandTop + (offset + numLanes) * LANE_H
  const medianRowIndex = offset + Math.floor(numLanes / 2)

  ctx.save()
  ctx.strokeStyle = MARKING_COLOR

  // Solid edge lines
  ctx.setLineDash([])
  ctx.lineWidth = 1.5
  drawHLine(ctx, x, laneTop, x + w)
  drawHLine(ctx, x, laneBottom, x + w)

  // Lines between lanes: thin dashed for ordinary same-direction splits,
  // a double dashed pair for the direction-change median
  for (let li = 1; li < numLanes; li++) {
    const rowIndex = offset + li
    const y = laneBandTop + rowIndex * LANE_H
    if (rowIndex === medianRowIndex) {
      ctx.lineWidth = 1.25
      ctx.setLineDash([9, 5])
      drawHLine(ctx, x, y - 1.5, x + w)
      drawHLine(ctx, x, y + 1.5, x + w)
    } else {
      ctx.lineWidth = 1
      ctx.setLineDash([5, 4])
      drawHLine(ctx, x, y, x + w)
    }
  }

  // Directional filled paint-arrows, one per lane, repeated along the width
  ctx.setLineDash([])
  for (let li = 0; li < numLanes; li++) {
    const rowIndex = offset + li
    const laneCenterY = laneBandTop + rowIndex * LANE_H + LANE_H / 2
    const pointsRight = rowIndex < medianRowIndex
    drawArrowsAlong(ctx, x, w, laneCenterY, pointsRight)
  }

  ctx.restore()
}

// Short perpendicular ticks along the shoulder's inner edge, mimicking a
// rumble strip -- only drawn where the shoulder is itself paved/asphalt.
// `direction` 'down' draws ticks hanging below the edge (top shoulder),
// 'up' draws them rising above it (bottom shoulder).
function drawRumbleStrip(ctx, x, w, edgeY, direction) {
  const tickLen = 4
  const spacing = 10
  const count = Math.floor(w / spacing)
  ctx.save()
  ctx.strokeStyle = 'rgba(255,255,255,0.6)'
  ctx.lineWidth = 1.5
  for (let i = 0; i < count; i++) {
    const cx = x + spacing * (i + 0.5)
    ctx.beginPath()
    ctx.moveTo(cx, edgeY)
    ctx.lineTo(cx, direction === 'down' ? edgeY + tickLen : edgeY - tickLen)
    ctx.stroke()
  }
  ctx.restore()
}

function drawHLine(ctx, x1, y, x2) {
  ctx.beginPath()
  ctx.moveTo(x1, y)
  ctx.lineTo(x2, y)
  ctx.stroke()
}

function drawArrowsAlong(ctx, x, w, y, pointsRight) {
  if (w < ARROW_SPACING_PX * 0.6) return // too narrow to fit even one arrow cleanly
  const count = Math.max(1, Math.round(w / ARROW_SPACING_PX))
  const step = w / count
  const shaftLen = 7
  const headSize = 4.5
  for (let i = 0; i < count; i++) {
    const cx = x + step * (i + 0.5)
    const dir = pointsRight ? 1 : -1
    const tailX = cx - dir * shaftLen
    const tipX = cx + dir * shaftLen
    ctx.fillStyle = MARKING_COLOR
    ctx.strokeStyle = MARKING_COLOR
    // shaft
    ctx.lineWidth = 1.75
    ctx.beginPath()
    ctx.moveTo(tailX, y)
    ctx.lineTo(tipX - dir * headSize * 0.6, y)
    ctx.stroke()
    // filled arrowhead
    ctx.beginPath()
    ctx.moveTo(tipX, y)
    ctx.lineTo(tipX - dir * headSize, y - headSize * 0.7)
    ctx.lineTo(tipX - dir * headSize, y + headSize * 0.7)
    ctx.closePath()
    ctx.fill()
  }
}

function paintCell(ctx, x, y, w, h, surfaceType) {
  ctx.fillStyle = fillForCell(ctx, surfaceType, x, y, w, h)
  ctx.fillRect(x, y, w, h)
  ctx.strokeStyle = BORDER_COLOR
  ctx.lineWidth = 0.5
  ctx.strokeRect(x, y, w, h)
}
