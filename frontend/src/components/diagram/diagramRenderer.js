import { fillForCell, getGravelPattern } from './surfacePatterns'
import { formatDpwhStation, formatPlainStationLabel, isDpwhStyle, looksLikeDpwhText } from '../../utils/chainage'

const BASE_STRIP_WIDTH_PX = 1200
// Minimum horizontal space reserved per station-interval column so its tick
// label ("Sta. 20+000") always has room to breathe -- packing more intervals
// into the same fixed width is what caused labels to overlap at high
// Stations-per-Line settings. The strip grows wider (and the canvas scrolls)
// rather than letting labels collide.
const MIN_PX_PER_INTERVAL = 90
// Minimum gap enforced between two adjacent station labels; if the next
// label would start closer than this to the previous one's right edge, it
// is skipped (the tick mark still draws) rather than letting text overlap.
const LABEL_MIN_GAP_PX = 6
// Conservative, widely-supported ceiling on a single <canvas> dimension
// (actual browser limits vary higher, but this stays safely under all of
// them). A very long multi-strip road at a high scale (devicePixelRatio *
// zoom, or the print/export HD factors) could otherwise ask for a backing
// store past what the browser allows, which silently fails to render
// rather than erroring -- renderDiagram/renderSingleStrip clamp the
// requested scale down before that happens, trading a bit of sharpness for
// never just not rendering at all. True tiling would avoid the tradeoff
// entirely but isn't implemented.
const MAX_CANVAS_DIMENSION_PX = 8192
const LEFT_MARGIN = 90
// Fallback only -- computeRightMargin() below sizes this per-diagram from
// the actual widest terminal label, since a flat value is either wasted
// space (short labels) or too narrow and clips the text (long labels, e.g.
// 3-digit kilometer counts).
const RIGHT_MARGIN_FALLBACK = 20
const TOP_MARGIN = 10
const HEADER_H = 24
const STATUS_STRIP_H = 6
const SHOULDER_H = 22
const LANE_H = 22
const STRIP_GAP = 44
const BORDER_COLOR = '#333333'
// A block clipped to less than this many px (a short, unmerged -- different
// attributes or a gap/overlap neighbor -- segment at the current zoom) still
// renders at this minimum width rather than vanishing or anti-aliasing into
// a near-invisible sliver. Blocks are drawn left-to-right, so a later block
// painting over a widened earlier one's bled-over edge is what keeps this
// from visibly overlapping; the tooltip hit region always uses the real
// (unwidened) data, just the fill width is floored.
const MIN_BLOCK_WIDTH_PX = 2
// Every block's fill is drawn this many px wider than its own [x, xEnd) --
// extending only to the right, where the next block (drawn after, in strip
// order) paints over the extra sliver. Two independently-rounded fillRect
// calls that are mathematically edge-to-edge can still leave a hairline
// gap once the canvas's own backing-store scale (devicePixelRatio, which is
// fractional on most real displays -- 1.25x/1.5x are both common) isn't a
// whole number: each rect's edge anti-aliases against the fractional device
// pixel it lands on independently, and the two antialiased edges don't
// always sum to full coverage. Overlapping forward removes the seam
// regardless of scale, since whichever block draws last always wins.
const SEAM_OVERLAP_PX = 1
// A real gap in the station data (not just a rounding artifact) narrower
// than this, in meters OR current on-screen pixels, reads as visual noise
// rather than a meaningful missing stretch -- it's closed by extending the
// previous block's fill to the next block's start. The underlying data and
// that block's tooltip are untouched; only the drawn rectangle widens.
const GAP_CLOSE_THRESHOLD_M = 50
const GAP_CLOSE_THRESHOLD_PX = 3
// A gap that isn't closed (see above) is drawn as its own flat, hatched
// "no data" block instead of leaving the white canvas background showing
// through -- that bare white was indistinguishable from the seam artifact
// this whole fix removes, so a real missing-data gap needs its own
// deliberately-different look.
const NODATA_BG = '#E3E6EA'
const NODATA_HATCH = '#B7BEC7'
// Thin dashed border drawn over a cell that's blank for a structural reason
// (this station simply has fewer lanes than the strip's tallest segment, or
// the shoulder is recorded as "none") -- distinguishes a deliberate "nothing
// here" from a real missing-data gap (NODATA_BG/HATCH above) and from a
// plain rendering seam. Matches SHOULDER_SWATCHES.none's dropdown swatch
// border color so the canvas and the rest of the UI agree on what "none"
// looks like.
const NO_LANE_BORDER_COLOR = '#94a3b8'
const MARKING_COLOR = 'rgba(255,255,255,0.75)'
const ARROW_SPACING_PX = 70
const MARKED_SURFACES = new Set(['asphalt', 'concrete']) // surfaces with painted lane markings
const STATUS_DONE_COLOR = '#0ca30c'
const STATUS_NOT_DONE_COLOR = '#d03b3b'
// Matches the app's own body font stack (index.css) -- a named system font
// hints more consistently than a bare "sans-serif" fallback, which some
// engines substitute with a less-hinted/blurrier default face.
const STATION_FONT = '11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
// Extra breathing room beyond half the widest label's width, so the glyph's
// own side-bearing/antialiasing never reads as touching the canvas edge.
const LABEL_EDGE_PADDING_PX = 8

// DPWH km-post sections get "K1260 + 000" tick labels (no 'Sta.' prefix,
// matching real DPWH range notation); plain-meter sections keep the
// original "Sta. 0+000" label format unchanged.
function stationLabelFormatter(road) {
  return isDpwhStyle(road) ? formatDpwhStation : formatPlainStationLabel
}

// A throwaway canvas used purely for ctx.measureText() -- lets margins be
// sized from the real rendered width of the widest label *before* the
// target canvas's own width (and therefore its context, which resets on
// resize) is known.
let measureCtx = null
function getMeasureCtx() {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d')
  }
  measureCtx.font = STATION_FONT
  return measureCtx
}

// The right-edge tick of every strip sits at the same x (stripWidthPx from
// the strip's own origin), and that final label is center-anchored on it --
// so it's the single place that can clip against the canvas's right edge.
// Measuring the actual widest terminal label (rather than assuming a flat
// margin) keeps the reserved space exact: never so narrow it clips a long
// label, never so wide it wastes space on a short one.
function computeRightMargin(numStrips, baseM, stripSpanM, totalLengthM, labelFn, overallEndLabel) {
  if (numStrips === 0) return RIGHT_MARGIN_FALLBACK
  const ctx = getMeasureCtx()
  let maxWidth = 0
  for (let s = 0; s < numStrips; s++) {
    const stripEndM = Math.min(baseM + (s + 1) * stripSpanM, baseM + totalLengthM)
    // The very last strip's end tick may render the original range text
    // (overallEndLabel) instead of labelFn's canonical one -- measure
    // whichever text actually gets drawn there, not always the canonical
    // form, so a longer original string can't clip against this margin.
    const text = s === numStrips - 1 && overallEndLabel ? overallEndLabel : labelFn(stripEndM)
    const w = ctx.measureText(text).width
    if (w > maxWidth) maxWidth = w
  }
  return Math.ceil(maxWidth / 2) + LABEL_EDGE_PADDING_PX
}

// Round to whole device pixels so adjacent clipped segments share an exact
// edge (no 1px seams/overlaps from independently-rounded floats) and strokes
// render crisp instead of anti-aliased/blurry.
function px(v) {
  return Math.round(v)
}

function clampScaleToCanvasLimit(logicalWidth, logicalHeight, scale) {
  const maxScale = Math.min(MAX_CANVAS_DIMENSION_PX / logicalWidth, MAX_CANVAS_DIMENSION_PX / logicalHeight)
  return Math.min(scale, maxScale)
}

// Tolerance for comparing station positions (meters) when deciding whether
// two segments are exactly contiguous -- these come straight from stored
// floats on both sides of the comparison, not re-derived, so float drift is
// not expected, but a tiny epsilon is cheap insurance.
const MERGE_EPSILON_M = 0.01

// Merges consecutive (sorted by start_m) segments that share identical
// lanes/surface/shoulders into one wider block for the DIAGRAM ONLY -- real
// DPWH data splits a section into many short same-attribute segments at
// every km post, which (drawn one at a time) made the diagram look like a
// barcode of vertical lines. Only merges truly contiguous runs (curr.start_m
// === prev.end_m); a gap or overlap always starts a new block, so those stay
// visible exactly as before. The table/API data itself is untouched -- this
// runs only on the array handed to the renderer.
function mergeSegmentsForDiagram(segments) {
  const merged = []
  for (const seg of segments) {
    const last = merged[merged.length - 1]
    const sameAttrs =
      last &&
      last.num_lanes === seg.num_lanes &&
      last.surface_type === seg.surface_type &&
      last.shoulder_left === seg.shoulder_left &&
      last.shoulder_right === seg.shoulder_right
    const contiguous = last && Math.abs(seg.start_m - last.end_m) < MERGE_EPSILON_M
    if (sameAttrs && contiguous) {
      last.end_m = seg.end_m
      last.end_station = seg.end_station
      last.length_m += seg.length_m
      last.mergedCount += 1
    } else {
      merged.push({ ...seg, mergedCount: 1 })
    }
  }
  return merged
}

// Shared layout math used by both the combined multi-strip canvas (on-screen
// view) and the one-canvas-per-strip print path. `range` (optional)
// restricts the diagram to a station sub-range of the road: { startM, endM }
// in absolute meters. When omitted, the full road is used (baseM = 0).
function computeStripPlan(road, settings, range) {
  const { stationIntervalM, stationsPerLine } = settings
  const stripSpanM = stationIntervalM * stationsPerLine
  const baseM = range ? range.startM : 0
  const totalLengthM = range
    ? Math.max(0, range.endM - range.startM)
    : road.total_length_m
  const numStrips = totalLengthM > 0 ? Math.ceil(totalLengthM / stripSpanM) : 0

  // Only segments actually visible within the range drive the lane-row band
  // height, so a narrowed range isn't padded for lanes that never appear in
  // it. Irregular (length <= 0) segments are excluded outright -- they're
  // never drawn (see drawStrip's clip check, which always skips them since
  // end_m <= start_m by construction), so they shouldn't inflate the lane
  // band either.
  const relevantSegments = mergeSegmentsForDiagram(
    (range ? road.segments.filter((s) => s.end_m > range.startM && s.start_m < range.endM) : road.segments).filter(
      (s) => !s.irregular_km_post
    )
  )

  const globalMaxLanes = relevantSegments.length
    ? Math.max(...relevantSegments.map((s) => s.num_lanes))
    : 0
  const laneBandH = globalMaxLanes * LANE_H
  const stripHeight = HEADER_H + STATUS_STRIP_H + SHOULDER_H + laneBandH + SHOULDER_H
  const stripWidthPx = Math.max(BASE_STRIP_WIDTH_PX, stationsPerLine * MIN_PX_PER_INTERVAL)
  const labelFn = stationLabelFormatter(road)

  // The overall range's start/end labels prefer the ORIGINAL typed/record
  // station text (e.g. "K1236 + (-848)") over the canonical floor()-derived
  // one ("K1235 + 000") -- same preference formatStationRange already uses
  // for the progress-bar/print-header range text, so the diagram's own edge
  // labels read the same as those. Only DPWH-style sections have this
  // negative-offset reference-point concept; plain-meter sections always
  // use the normalized format, at every tick including the edges.
  const isDpwh = isDpwhStyle(road)
  const overallStartLabel = range && isDpwh && looksLikeDpwhText(range.startText) ? range.startText.trim() : null
  const overallEndLabel = range && isDpwh && looksLikeDpwhText(range.endText) ? range.endText.trim() : null

  const rightMargin = computeRightMargin(numStrips, baseM, stripSpanM, totalLengthM, labelFn, overallEndLabel)
  const canvasWidth = LEFT_MARGIN + stripWidthPx + rightMargin
  const canvasHeight = numStrips > 0 ? TOP_MARGIN + numStrips * stripHeight + (numStrips - 1) * STRIP_GAP + 10 : 0

  return {
    stripSpanM,
    totalLengthM,
    numStrips,
    globalMaxLanes,
    laneBandH,
    stripHeight,
    stripWidthPx,
    rightMargin,
    canvasWidth,
    canvasHeight,
    baseM,
    relevantSegments,
    labelFn,
    overallStartLabel,
    overallEndLabel,
  }
}

// The canvas's LOGICAL (CSS-pixel) size -- i.e. what canvas.width/height
// would be at scale=1 -- independent of both devicePixelRatio and zoom.
// Callers that need to size a <canvas> element's CSS display box (as
// opposed to its backing-store resolution) use this rather than reading
// canvas.width/height back off a canvas that may have been rendered at a
// higher backing-store scale for sharpness.
export function getCanvasLogicalSize(road, settings, range) {
  const plan = computeStripPlan(road, settings, range)
  if (plan.totalLengthM <= 0 || plan.relevantSegments.length === 0) {
    return { width: 0, height: 0 }
  }
  return { width: plan.canvasWidth, height: plan.canvasHeight }
}

export function getNumStrips(road, settings, range) {
  return computeStripPlan(road, settings, range).numStrips
}

// Pixel positions (in the same native canvas coordinate space renderDiagram
// draws into) of the "Shoulder"/"Lane N" row labels baked into the left
// margin of the combined canvas. Used to render a matching sticky HTML
// overlay for the on-screen view only -- the canvas bitmap itself (and
// therefore fullscreen/print/export, which all reuse or rescale that same
// bitmap) is untouched, so this never risks diverging from them.
export function getRowLabelLayout(road, settings, range) {
  const plan = computeStripPlan(road, settings, range)
  if (plan.totalLengthM <= 0 || plan.relevantSegments.length === 0) {
    return { labels: [], leftWidth: LEFT_MARGIN, totalHeight: 0 }
  }
  const { numStrips, globalMaxLanes, laneBandH, stripHeight } = plan
  const labels = []
  for (let s = 0; s < numStrips; s++) {
    const y0 = TOP_MARGIN + s * (stripHeight + STRIP_GAP)
    const topShoulderY = y0 + HEADER_H + STATUS_STRIP_H
    const laneBandTop = topShoulderY + SHOULDER_H
    labels.push({ key: `${s}-shoulder-top`, text: 'Shoulder', top: topShoulderY, height: SHOULDER_H })
    for (let li = 0; li < globalMaxLanes; li++) {
      labels.push({ key: `${s}-lane-${li}`, text: `Lane ${li + 1}`, top: laneBandTop + li * LANE_H, height: LANE_H })
    }
    labels.push({ key: `${s}-shoulder-bottom`, text: 'Shoulder', top: laneBandTop + laneBandH, height: SHOULDER_H })
  }
  return { labels, leftWidth: LEFT_MARGIN, totalHeight: plan.canvasHeight }
}

// Renders exactly one strip (one page's worth) onto `canvas`, sized to fit
// just that strip -- used for print, where each strip becomes its own page
// instead of one tall image the browser would otherwise paginate awkwardly
// (leaving a near-blank leading page before the image "fits").
// `scale` multiplies the canvas's backing-store resolution (devicePixelRatio
// and/or an explicit HD-export factor) while every drawing coordinate below
// stays in the same logical units as before -- ctx.setTransform makes the
// whole canvas denser without the layout math needing to know or care.
export function renderSingleStrip(canvas, road, settings, stripIndex, range, scale = 1) {
  const ctx = canvas.getContext('2d')
  const plan = computeStripPlan(road, settings, range)
  const pxPerMeter = plan.stripWidthPx / plan.stripSpanM
  const logicalWidth = plan.canvasWidth
  const logicalHeight = TOP_MARGIN + plan.stripHeight + 10
  const clampedScale = clampScaleToCanvasLimit(logicalWidth, logicalHeight, scale)

  canvas.width = Math.round(logicalWidth * clampedScale)
  canvas.height = Math.round(logicalHeight * clampedScale)
  ctx.setTransform(clampedScale, 0, 0, clampedScale, 0, 0)

  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, logicalWidth, logicalHeight)
  ctx.textBaseline = 'middle'
  ctx.font = STATION_FONT

  const stripStartM = plan.baseM + stripIndex * plan.stripSpanM
  const stripEndM = Math.min(plan.baseM + (stripIndex + 1) * plan.stripSpanM, plan.baseM + plan.totalLengthM)

  drawStrip(ctx, {
    x0: LEFT_MARGIN,
    y0: TOP_MARGIN,
    stripStartM,
    stripEndM,
    pxPerMeter,
    stationIntervalM: settings.stationIntervalM,
    segments: plan.relevantSegments,
    globalMaxLanes: plan.globalMaxLanes,
    laneBandH: plan.laneBandH,
    hitRegions: [],
    scale: clampedScale,
    labelFn: plan.labelFn,
    startLabelOverride: stripIndex === 0 ? plan.overallStartLabel : null,
    endLabelOverride: stripIndex === plan.numStrips - 1 ? plan.overallEndLabel : null,
  })
}

/**
 * Renders the strip-map road surface diagram onto `canvas`.
 * `road` = { total_length_m, segments: [{start_m, end_m, num_lanes,
 *   surface_type, shoulder_left, shoulder_right}] } (segments must already be
 *   sorted by start_m, as returned by GET /api/roads/{section_id}).
 * `settings` = { stationIntervalM, stationsPerLine }.
 * `range` (optional) = { startM, endM } to restrict the diagram to a station
 *   sub-range of the road, clipping segments at the boundaries and starting
 *   station labels from `startM` instead of 0.
 * `scale` (default 1) multiplies the canvas's backing-store resolution --
 * pass devicePixelRatio for a crisp on-screen render, devicePixelRatio*zoom
 * to re-render (rather than CSS-stretch) a zoomed view, or a flat HD/export
 * factor -- without changing any of the logical layout coordinates below.
 */
export function renderDiagram(canvas, road, settings, range, scale = 1) {
  const ctx = canvas.getContext('2d')
  const { stationIntervalM } = settings
  const plan = computeStripPlan(road, settings, range)
  const segments = plan.relevantSegments

  if (plan.totalLengthM <= 0 || segments.length === 0) {
    canvas.width = 0
    canvas.height = 0
    return { hitRegions: [] }
  }

  const { numStrips, globalMaxLanes, laneBandH, stripHeight, stripWidthPx, stripSpanM, canvasWidth, canvasHeight, baseM } = plan
  const pxPerMeter = stripWidthPx / stripSpanM
  const logicalWidth = canvasWidth
  const logicalHeight = canvasHeight
  const clampedScale = clampScaleToCanvasLimit(logicalWidth, logicalHeight, scale)

  canvas.width = Math.round(logicalWidth * clampedScale)
  canvas.height = Math.round(logicalHeight * clampedScale)
  ctx.setTransform(clampedScale, 0, 0, clampedScale, 0, 0)

  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, logicalWidth, logicalHeight)
  ctx.textBaseline = 'middle'
  ctx.font = STATION_FONT

  const hitRegions = []

  for (let s = 0; s < numStrips; s++) {
    // Anchor each strip's meter-grid to whole-pixel boundaries at the strip
    // start so station ticks land exactly on-pixel too, not just the fills.
    const stripStartM = baseM + s * stripSpanM
    const stripEndM = Math.min(baseM + (s + 1) * stripSpanM, baseM + plan.totalLengthM)
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
      scale: clampedScale,
      labelFn: plan.labelFn,
      startLabelOverride: s === 0 ? plan.overallStartLabel : null,
      endLabelOverride: s === numStrips - 1 ? plan.overallEndLabel : null,
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
    scale,
    labelFn,
    startLabelOverride,
    endLabelOverride,
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
  // stripStartM origin used for the segment fills, so ticks and fills never
  // drift apart. The tick mark is always drawn; the text label is only
  // drawn when it fits without touching a neighboring label, so labels
  // never overlap regardless of interval/range/font-metric combination.
  //
  // Tick *positions* are chosen in two tiers:
  //  - Mandatory: the strip's own exact start and end (stripStartM/
  //    stripEndM) -- almost never round numbers themselves (a station range
  //    rarely starts/ends on a whole km-post), but always need their own
  //    label so the viewer knows exactly what's at each edge.
  //  - Optional: round multiples of stationIntervalM strictly between them
  //    (e.g. every whole km for a 1km interval) -- these read naturally as
  //    "the grid", unlike ticks offset by the range's own odd starting
  //    remainder (the bug this replaces: K1235+152, K1236+152, ... instead
  //    of K1236+000, K1237+000, ...).
  // A round tick's label is dropped (not the tick mark) if it would collide
  // with a neighboring label, so the two mandatory edge labels always win.
  ctx.strokeStyle = BORDER_COLOR
  ctx.fillStyle = '#000000'

  const endX = px(x0 + (stripEndM - stripStartM) * pxPerMeter)
  const endLabel = endLabelOverride || labelFn(stripEndM)
  const endLabelLeft = endX - ctx.measureText(endLabel).width / 2

  const ticks = [{ m: stripStartM, mandatory: true }]
  const firstRoundM = Math.ceil(stripStartM / stationIntervalM) * stationIntervalM
  for (let m = firstRoundM; m < stripEndM - MERGE_EPSILON_M; m += stationIntervalM) {
    if (m > stripStartM + MERGE_EPSILON_M) ticks.push({ m, mandatory: false })
  }
  if (stripEndM > stripStartM + MERGE_EPSILON_M) ticks.push({ m: stripEndM, mandatory: true })

  let lastLabelRight = -Infinity
  for (const tick of ticks) {
    const { m, mandatory } = tick
    const isFirst = m === stripStartM
    const isLast = m === stripEndM && !isFirst
    const x = px(x0 + (m - stripStartM) * pxPerMeter)
    ctx.beginPath()
    ctx.moveTo(x, y0 + HEADER_H - 6)
    ctx.lineTo(x, y0 + HEADER_H)
    ctx.stroke()

    const label = isFirst && startLabelOverride ? startLabelOverride : isLast && endLabelOverride ? endLabelOverride : labelFn(m)
    const textWidth = ctx.measureText(label).width
    const labelLeft = isFirst ? x : x - textWidth / 2
    const labelRight = isFirst ? x + textWidth : x + textWidth / 2
    const fitsBehindPrevious = labelLeft >= lastLabelRight + LABEL_MIN_GAP_PX
    // Optional ticks must also leave room before the mandatory end label,
    // even though that label hasn't been drawn yet (it's last in iteration
    // order) -- without this look-ahead, a round tick just before the end
    // could get drawn first and only THEN collide once the end label (which
    // is never skipped) is placed on top of it.
    const fitsBeforeEnd = isLast || labelRight + LABEL_MIN_GAP_PX <= endLabelLeft

    if (mandatory || (fitsBehindPrevious && fitsBeforeEnd)) {
      ctx.save()
      ctx.textAlign = isFirst ? 'left' : 'center'
      ctx.fillText(label, x, y0 + HEADER_H / 2)
      ctx.restore()
      lastLabelRight = labelRight
    }
  }

  // Clip segments into this strip, then walk consecutive pairs to decide
  // what (if anything) fills the space between them: nothing for a
  // contiguous/overlapping pair, an extended previous block for a small
  // real gap, or a dedicated "no data" block for a larger one. This runs
  // as its own pass (building `blocks` first) rather than drawing inline,
  // because closing a small gap means retroactively widening the PREVIOUS
  // block already added to the list.
  const blocks = []
  for (const seg of segments) {
    const clippedStart = Math.max(seg.start_m, stripStartM)
    const clippedEnd = Math.min(seg.end_m, stripEndM)
    if (clippedEnd <= clippedStart) continue

    const prev = blocks[blocks.length - 1]
    if (prev) {
      const gapM = clippedStart - prev.endM
      if (gapM > MERGE_EPSILON_M) {
        const gapPx = gapM * pxPerMeter
        if (gapM < GAP_CLOSE_THRESHOLD_M || gapPx < GAP_CLOSE_THRESHOLD_PX) {
          // Visual only -- the data/tooltip for `prev.seg` is untouched,
          // only the rectangle drawn for it widens to meet this segment.
          prev.endM = clippedStart
        } else {
          blocks.push({ seg: null, startM: prev.endM, endM: clippedStart })
        }
      }
    }
    blocks.push({ seg, startM: clippedStart, endM: clippedEnd })
  }

  for (const block of blocks) {
    const x = px(x0 + (block.startM - stripStartM) * pxPerMeter)
    const xEnd = px(x0 + (block.endM - stripStartM) * pxPerMeter)
    const w = Math.max(xEnd - x, MIN_BLOCK_WIDTH_PX)
    // Fills only (never hit regions) overshoot to the right -- see
    // SEAM_OVERLAP_PX above.
    const fillW = w + SEAM_OVERLAP_PX
    const columnH = STATUS_STRIP_H + SHOULDER_H + laneBandH + SHOULDER_H

    if (!block.seg) {
      drawNoDataFill(ctx, x, statusStripY, fillW, columnH)
      hitRegions.push({
        x,
        y: statusStripY,
        w,
        h: columnH,
        segment: {
          isNoData: true,
          start_station: labelFn(block.startM),
          end_station: labelFn(block.endM),
          length_m: block.endM - block.startM,
        },
        isDone: false,
      })
      continue
    }

    const seg = block.seg

    // Done/not-done status strip -- independent of the surface-type legend
    // colors, so progress reads at a glance without reinterpreting materials.
    const isDone = seg.surface_type === 'asphalt'
    ctx.fillStyle = isDone ? STATUS_DONE_COLOR : STATUS_NOT_DONE_COLOR
    ctx.fillRect(x, statusStripY, fillW, STATUS_STRIP_H)

    // Top shoulder
    paintCell(ctx, x, topShoulderY, fillW, SHOULDER_H, seg.shoulder_right, scale)
    if (seg.shoulder_right === 'none') strokeEmptyBorder(ctx, x, topShoulderY, fillW, SHOULDER_H)
    if (MARKED_SURFACES.has(seg.shoulder_right)) {
      drawRumbleStrip(ctx, x, w, topShoulderY + SHOULDER_H, 'down')
    }

    // Lane rows, centered within the global lane band -- rows outside
    // [offset, offset+num_lanes) don't exist at this station (this segment
    // has fewer lanes than the strip's tallest one), so they get the
    // dashed "no lane" border instead of a surface fill.
    const offset = Math.floor((globalMaxLanes - seg.num_lanes) / 2)
    for (let li = 0; li < globalMaxLanes; li++) {
      const y = laneBandTop + li * LANE_H
      if (li >= offset && li < offset + seg.num_lanes) {
        paintCell(ctx, x, y, fillW, LANE_H, seg.surface_type, scale)
      } else {
        strokeEmptyBorder(ctx, x, y, fillW, LANE_H)
      }
    }

    // Bottom shoulder
    const bottomShoulderY = laneBandTop + laneBandH
    paintCell(ctx, x, bottomShoulderY, fillW, SHOULDER_H, seg.shoulder_left, scale)
    if (seg.shoulder_left === 'none') strokeEmptyBorder(ctx, x, bottomShoulderY, fillW, SHOULDER_H)
    if (MARKED_SURFACES.has(seg.shoulder_left)) {
      drawRumbleStrip(ctx, x, w, bottomShoulderY, 'up')
    }

    if (MARKED_SURFACES.has(seg.surface_type)) {
      // lineDashOffset anchors the dash pattern to the strip's absolute x
      // origin (not each block's own local x) -- without it, two adjacent
      // but separately-drawn blocks each restart their dash cycle at their
      // own left edge, which reads as a visible break in the line even
      // though the lane markings are logically continuous across them.
      drawLaneMarkings(ctx, { x, w, laneBandTop, offset, numLanes: seg.num_lanes })
    }

    hitRegions.push({
      x,
      y: statusStripY,
      w,
      h: columnH,
      segment: seg,
      isDone,
      // Lets the tooltip tell a real lane/shoulder apart from the blank
      // rows drawn above (strokeEmptyBorder) within this same hit region,
      // without re-deriving the strip's row geometry from scratch.
      rowLayout: { statusStripH: STATUS_STRIP_H, shoulderH: SHOULDER_H, laneH: LANE_H, laneBandH, offset },
    })
  }
}

// Given a hit region (as pushed above) and the hovered y in the SAME native
// canvas coordinate space, returns which structurally-blank row (if any)
// the pointer is over -- 'no-shoulder' | 'no-lane' | null. isNoData blocks
// (real data gaps) don't carry rowLayout and are handled by the caller
// separately, as before.
export function hoveredEmptyRowType(region, ny) {
  if (!region.rowLayout) return null
  const { statusStripH, shoulderH, laneH, laneBandH, offset } = region.rowLayout
  const relY = ny - region.y
  if (relY < statusStripH) return null
  const bandY = relY - statusStripH
  if (bandY < shoulderH) {
    return region.segment.shoulder_right === 'none' ? 'no-shoulder' : null
  }
  if (bandY < shoulderH + laneBandH) {
    const laneIdx = Math.floor((bandY - shoulderH) / laneH)
    return laneIdx < offset || laneIdx >= offset + region.segment.num_lanes ? 'no-lane' : null
  }
  if (bandY < shoulderH + laneBandH + shoulderH) {
    return region.segment.shoulder_left === 'none' ? 'no-shoulder' : null
  }
  return null
}

// Flat, lightly hatched fill for a real (not visually-closed) gap in the
// station data -- deliberately distinct from both the plain-white canvas
// background and every real surface color/pattern, so it reads as "nothing
// recorded here" rather than either a rendering seam or an actual surface.
function drawNoDataFill(ctx, x, y, w, h) {
  ctx.fillStyle = NODATA_BG
  ctx.fillRect(x, y, w, h)
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  ctx.strokeStyle = NODATA_HATCH
  ctx.lineWidth = 1
  const step = 10
  for (let lx = x - h; lx < x + w; lx += step) {
    ctx.beginPath()
    ctx.moveTo(lx, y + h)
    ctx.lineTo(lx + h, y)
    ctx.stroke()
  }
  ctx.restore()
}

// Real-road-style paint markings: solid white edge lines at the shoulder
// boundary, thin dashed white lines between same-direction lanes, a double
// dashed centerline at the direction split (the standard no-passing-zone
// convention), and filled directional arrows per lane. Only called for
// surfaces that would actually carry paint (asphalt/concrete) -- gravel/
// earth/none are left bare, which is itself realistic.
function drawLaneMarkings(ctx, { x, w, laneBandTop, offset, numLanes }) {
  const laneTop = laneBandTop + offset * LANE_H
  const laneBottom = laneBandTop + (offset + numLanes) * LANE_H
  const medianRowIndex = offset + Math.floor(numLanes / 2)

  ctx.save()
  ctx.strokeStyle = MARKING_COLOR
  // Anchors the dash pattern to the strip's absolute x origin rather than
  // this block's own local x -- without it, two adjacent blocks (drawn
  // separately, each starting its dash cycle fresh at its own left edge)
  // visibly break the line where one ends and the next begins, even though
  // the lane marking is logically continuous across them.
  ctx.lineDashOffset = -x

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

// ===== Legend panel, baked onto the exported PNG only =====
// Export produces a single standalone image with no surrounding app chrome,
// so (unlike normal/fullscreen/print, which all reuse the same <Legend/>
// DOM component) it needs the legend drawn directly onto the canvas to be
// self-explanatory on its own.
const LEGEND_SWATCH_W = 20
const LEGEND_SWATCH_H = 14
const LEGEND_ITEM_GAP_PX = 20
const LEGEND_LABEL_GAP_PX = 8
const LEGEND_TITLE_H = 20
const LEGEND_NOTE_H = 20
const LEGEND_FONT = '12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
const LEGEND_NOTE_FONT = '11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
const LEGEND_TITLE_COLOR = '#334155'
const LEGEND_NOTE_COLOR = '#64748b'

function legendPanelItems() {
  return [
    { label: 'CONCRETE', draw: (ctx, x, y) => flatSwatch(ctx, x, y, '#9E9E9E') },
    { label: 'ASPHALT', draw: (ctx, x, y) => flatSwatch(ctx, x, y, '#000000') },
    {
      label: 'GRAVEL',
      draw: (ctx, x, y, scale) => {
        ctx.fillStyle = getGravelPattern(ctx, scale)
        ctx.fillRect(x, y, LEGEND_SWATCH_W, LEGEND_SWATCH_H)
        ctx.strokeStyle = '#333333'
        ctx.lineWidth = 1
        ctx.strokeRect(x + 0.5, y + 0.5, LEGEND_SWATCH_W - 1, LEGEND_SWATCH_H - 1)
      },
    },
    { label: 'EARTH', draw: (ctx, x, y) => flatSwatch(ctx, x, y, '#C8A165') },
    {
      label: 'NO LANE / NO SHOULDER',
      draw: (ctx, x, y) => {
        flatSwatch(ctx, x, y, '#FFFFFF')
        strokeEmptyBorder(ctx, x, y, LEGEND_SWATCH_W, LEGEND_SWATCH_H)
      },
    },
    { label: 'NO DATA (gap)', draw: (ctx, x, y) => drawNoDataFill(ctx, x, y, LEGEND_SWATCH_W, LEGEND_SWATCH_H) },
  ]
}

function flatSwatch(ctx, x, y, color) {
  ctx.fillStyle = color
  ctx.fillRect(x, y, LEGEND_SWATCH_W, LEGEND_SWATCH_H)
}

// Lays out the fixed legend items into rows that fit `maxWidth`, wrapping
// to a new row rather than overflowing or shrinking text -- independent of
// drawing, so the composite export canvas can be sized correctly BEFORE
// anything is actually painted onto it.
function computeLegendLayout(maxWidth) {
  const ctx = getMeasureCtx()
  ctx.font = LEGEND_FONT
  const rowH = LEGEND_SWATCH_H + 12
  let x = 0
  let row = 0
  const placed = []
  for (const item of legendPanelItems()) {
    const textWidth = ctx.measureText(item.label).width
    const itemWidth = LEGEND_SWATCH_W + LEGEND_LABEL_GAP_PX + textWidth
    if (x > 0 && x + itemWidth > maxWidth) {
      x = 0
      row += 1
    }
    placed.push({ item, x, y: row * rowH })
    x += itemWidth + LEGEND_ITEM_GAP_PX
  }
  const rows = row + 1
  const bodyHeight = rows * rowH
  return { placed, rowH, bodyHeight, totalHeight: LEGEND_TITLE_H + bodyHeight + LEGEND_NOTE_H }
}

// Total vertical space drawLegendPanel will need at this width -- call
// before sizing the destination canvas.
export function measureLegendPanelHeight(maxWidth) {
  return computeLegendLayout(maxWidth).totalHeight
}

export function drawLegendPanel(ctx, x0, y0, maxWidth, scale = 1) {
  const { placed, bodyHeight } = computeLegendLayout(maxWidth)
  ctx.save()
  ctx.textBaseline = 'alphabetic'
  ctx.font = LEGEND_FONT
  ctx.fillStyle = LEGEND_TITLE_COLOR
  ctx.fillText('LEGEND', x0, y0 + 12)

  const bodyY = y0 + LEGEND_TITLE_H
  for (const { item, x, y } of placed) {
    item.draw(ctx, x0 + x, bodyY + y, scale)
    ctx.font = LEGEND_FONT
    ctx.fillStyle = LEGEND_TITLE_COLOR
    ctx.textBaseline = 'middle'
    ctx.fillText(item.label, x0 + x + LEGEND_SWATCH_W + LEGEND_LABEL_GAP_PX, bodyY + y + LEGEND_SWATCH_H / 2)
  }

  ctx.textBaseline = 'alphabetic'
  ctx.font = LEGEND_NOTE_FONT
  ctx.fillStyle = LEGEND_NOTE_COLOR
  ctx.fillText('Green/red line above each strip = asphalted / not asphalted.', x0, bodyY + bodyHeight + 14)
  ctx.restore()
}

// Returns a NEW canvas containing `sourceCanvas`'s own content with the
// legend panel appended below -- doesn't touch sourceCanvas or any of the
// core strip-rendering path above, so normal/fullscreen/print render
// exactly as before; only the PNG export call site uses this.
export function appendLegendBelow(sourceCanvas, scale = 1) {
  const logicalWidth = sourceCanvas.width / scale
  const logicalHeight = sourceCanvas.height / scale
  const legendMaxWidth = Math.max(100, logicalWidth - LEFT_MARGIN)
  const legendHeight = measureLegendPanelHeight(legendMaxWidth) + 16

  const out = document.createElement('canvas')
  out.width = sourceCanvas.width
  out.height = Math.round((logicalHeight + legendHeight) * scale)
  const ctx = out.getContext('2d')
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, logicalWidth, logicalHeight + legendHeight)
  ctx.drawImage(sourceCanvas, 0, 0, logicalWidth, logicalHeight)
  drawLegendPanel(ctx, LEFT_MARGIN, logicalHeight + 6, legendMaxWidth, scale)
  return out
}

function paintCell(ctx, x, y, w, h, surfaceType, scale = 1) {
  ctx.fillStyle = fillForCell(ctx, surfaceType, x, y, w, h, scale)
  ctx.fillRect(x, y, w, h)
}

// Thin dashed outline marking a cell as deliberately blank -- a lane row
// that doesn't exist at this station (narrower segment than the strip's
// tallest), or a shoulder recorded as "none". The cell itself is already
// white (either from paintCell's own 'none' fill, or from the canvas's own
// base white fill for lane rows that are never painted at all), so this
// only needs to add the border, not re-fill.
function strokeEmptyBorder(ctx, x, y, w, h) {
  ctx.save()
  ctx.strokeStyle = NO_LANE_BORDER_COLOR
  ctx.lineWidth = 1
  ctx.setLineDash([4, 3])
  ctx.strokeRect(x + 0.5, y + 0.5, Math.max(w - 1, 0), Math.max(h - 1, 0))
  ctx.restore()
}
