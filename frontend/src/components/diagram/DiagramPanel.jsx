import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import {
  renderDiagram,
  renderSingleStrip,
  getNumStrips,
  getRowLabelLayout,
  getCanvasLogicalSize,
  hoveredEmptyRowType,
  appendLegendBelow,
} from './diagramRenderer'
import { formatFilenameRangeSuffix, formatStationRange } from '../../utils/chainage'
import Legend from './Legend'
import DiagramFullscreen from './DiagramFullscreen'
import { showToast } from '../common/DialogProvider'
import { useDevicePixelRatio } from '../../utils/useDevicePixelRatio'
import ProgressBar from '../common/ProgressBar'

// Sums only the portion of each segment that falls inside `range` (if given)
// so the completion % reflects just the selected station range, not the
// whole road -- a segment straddling a range boundary is clipped, not
// counted in full or dropped.
function computeCompletion(roadDetail, range) {
  if (!roadDetail || !roadDetail.segments.length) return null
  const startM = range ? range.startM : 0
  const endM = range ? range.endM : roadDetail.total_length_m
  if (startM === null || endM === null || startM >= endM) return null

  let doneM = 0
  let totalM = 0
  for (const seg of roadDetail.segments) {
    if (seg.irregular_km_post) continue // length 0, excluded from totals
    const clipStart = Math.max(seg.start_m, startM)
    const clipEnd = Math.min(seg.end_m, endM)
    if (clipEnd <= clipStart) continue
    const len = clipEnd - clipStart
    totalM += len
    if (seg.surface_type === 'asphalt') doneM += len
  }
  const pct = totalM > 0 ? Math.round((doneM / totalM) * 100) : 0
  return { pct, doneM, totalM }
}

const WRAP_PADDING_PX = 32 // .diagram-canvas-wrap's 16px padding on each side
// Matches .app-header-spacer in App.css (the fixed app header's height) --
// same constant RoadInventoryTable.jsx keeps its own copy of, for the same
// "don't scroll a selected row/block under the fixed header" reason.
const APP_HEADER_HEIGHT = 72
// Print/export don't have a "device" to match -- both render once, offscreen
// or into a page the viewer may still pinch-zoom, so they use a flat HD
// factor instead of devicePixelRatio (which could be as low as 1 even on a
// perfectly normal monitor).
const PRINT_SCALE = 3
const EXPORT_SCALE = 2

const DiagramPanel = forwardRef(function DiagramPanel(
  { road, diagramVersion, hasGenerated, hasRoads, highlightedSegmentId, onBlockSelect },
  ref
) {
  const dpr = useDevicePixelRatio()
  const canvasRef = useRef(null)
  const canvasWrapRef = useRef(null)
  const hitRegionsRef = useRef([])
  const printCanvasRefs = useRef([])
  const fullscreenBtnRef = useRef(null)
  // Always mounted (never conditionally rendered), so it already exists in
  // the DOM for requestFullscreen() to target synchronously the instant the
  // user clicks/presses F -- DiagramFullscreen itself only mounts inside it
  // a render later, which would be too late (the Fullscreen API requires
  // the call to happen within the original user-gesture call stack).
  const fullscreenAnchorRef = useRef(null)
  const [tooltip, setTooltip] = useState(null)
  const [fullscreenOpen, setFullscreenOpen] = useState(false)
  // Default view is "fit to width" (mirrors fullscreen's own default) --
  // never upscaled past native resolution, only shrunk when the natural
  // diagram width can't fit the panel. Horizontal scroll is the fallback
  // for whatever doesn't fit even at that minimum.
  const [fitScale, setFitScale] = useState(1)
  const [nativeSize, setNativeSize] = useState({ width: 0, height: 0 })
  const [canvasScrolled, setCanvasScrolled] = useState(false)

  // Must run synchronously in direct response to a click/keydown -- no
  // await or setTimeout before requestFullscreen(), or the browser silently
  // refuses it (the call is only honored while still inside the original
  // user-gesture call stack).
  function openFullscreen() {
    if (!hasGenerated) return
    setFullscreenOpen(true)
    const anchor = fullscreenAnchorRef.current
    if (!anchor) return
    const request = anchor.requestFullscreen
      ? () => anchor.requestFullscreen({ navigationUI: 'hide' })
      : anchor.webkitRequestFullscreen
      ? () => anchor.webkitRequestFullscreen()
      : null
    if (!request) {
      showToast({ variant: 'info', message: 'Fullscreen not supported here. Showing expanded view.' })
      return
    }
    // Rejected (e.g. iframe restrictions) or simply unsupported on this
    // device (iPhone Safari) -- the overlay opened above either way, so
    // this is purely a "heads up, it's windowed" notice, not an error path.
    request().catch(() => {
      showToast({ variant: 'info', message: 'Fullscreen not supported here. Showing expanded view.' })
    })
  }

  useImperativeHandle(ref, () => ({
    openFullscreen,
  }))

  const numStrips = useMemo(
    () => (road ? getNumStrips(road.roadDetail, road.settings, road.range) : 0),
    [road, diagramVersion]
  )

  // Positions of the "Shoulder"/"Lane N" text baked into the canvas's own
  // left margin -- mirrored as a sticky HTML overlay (below) so that column
  // stays visible while the canvas itself scrolls horizontally. It sits
  // directly on top of (not beside) that same margin, opaquely covering the
  // canvas's own copy, so the text reads once -- the canvas bitmap itself
  // (and therefore fullscreen/print/export, which all derive from it) still
  // has it painted in underneath, untouched.
  const rowLabelLayoutNative = useMemo(
    () => (road ? getRowLabelLayout(road.roadDetail, road.settings, road.range) : { labels: [], leftWidth: 0, totalHeight: 0 }),
    [road, diagramVersion]
  )
  // Scaled to match whatever size the canvas is actually displayed at
  // (fitScale), so the overlay's rows stay pixel-aligned with the shrunk
  // canvas's own rows at any zoom level.
  const rowLabelLayout = useMemo(() => {
    if (fitScale === 1) return rowLabelLayoutNative
    return {
      leftWidth: rowLabelLayoutNative.leftWidth * fitScale,
      totalHeight: rowLabelLayoutNative.totalHeight * fitScale,
      labels: rowLabelLayoutNative.labels.map((l) => ({ ...l, top: l.top * fitScale, height: l.height * fitScale })),
    }
  }, [rowLabelLayoutNative, fitScale])

  useEffect(() => {
    if (!hasGenerated) setTooltip(null)
  }, [hasGenerated])

  useEffect(() => {
    if (!road || !canvasRef.current) return
    // Backing-store resolution = devicePixelRatio -- the canvas is still
    // *displayed* at its logical CSS size (see the style on the <canvas>
    // below), so this only adds pixel density, not visual size. Re-renders
    // (not CSS-stretches) whenever dpr itself changes, e.g. dragging the
    // window to a differently-scaled monitor.
    const result = renderDiagram(canvasRef.current, road.roadDetail, road.settings, road.range, dpr, highlightedSegmentId)
    hitRegionsRef.current = result?.hitRegions || []

    // One canvas per strip for print, sized to fit one page each -- avoids
    // the browser pushing the whole tall combined canvas to a near-empty
    // leading page before it "fits". Rendered at a flat HD factor rather
    // than dpr, since the screen's own pixel density has nothing to do with
    // how sharp a printed page or PDF should be. Never highlighted -- that's
    // a transient on-screen selection, not something a saved/printed page
    // should carry.
    printCanvasRefs.current.slice(0, numStrips).forEach((c, i) => {
      if (c) renderSingleStrip(c, road.roadDetail, road.settings, i, road.range, PRINT_SCALE)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagramVersion, numStrips, dpr, highlightedSegmentId])

  // Recomputes the fit-to-width scale from the diagram's LOGICAL size (not
  // canvas.width/height, which is now dpr-scaled and would otherwise make
  // the canvas render at 1/dpr of its intended on-screen size). Runs after
  // the effect above (declaration order) so it reflects whatever that just
  // rendered. A new diagram also resets the horizontal scroll position,
  // since the old scrollLeft is meaningless against a differently-sized one.
  useEffect(() => {
    function recomputeFitScale() {
      const wrap = canvasWrapRef.current
      if (!wrap || !road) {
        setFitScale(1)
        setNativeSize({ width: 0, height: 0 })
        return
      }
      const logical = getCanvasLogicalSize(road.roadDetail, road.settings, road.range)
      if (!logical.width) {
        setFitScale(1)
        setNativeSize({ width: 0, height: 0 })
        return
      }
      setNativeSize(logical)
      const available = wrap.clientWidth - WRAP_PADDING_PX
      setFitScale(Math.min(1, available / logical.width))
    }
    recomputeFitScale()
    if (canvasWrapRef.current) canvasWrapRef.current.scrollLeft = 0
    setCanvasScrolled(false)
    window.addEventListener('resize', recomputeFitScale)
    return () => window.removeEventListener('resize', recomputeFitScale)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagramVersion, numStrips])

  // Scrolls the just-highlighted block into view -- triggered when the user
  // clicks a matching row in the inventory table (highlightedSegmentId is
  // shared App.jsx state, not local). hitRegionsRef is already populated by
  // the render effect above (same render pass, earlier in declaration
  // order), and fitScale/canvasWrapRef/canvasRef all reflect the CURRENT
  // render by closure, so no extra dependency bookkeeping is needed beyond
  // highlightedSegmentId itself.
  useEffect(() => {
    if (highlightedSegmentId == null) return
    const wrap = canvasWrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const region = hitRegionsRef.current.find((r) => r.segment?.mergedIds?.includes(highlightedSegmentId))
    if (!region) return

    const regionLeft = region.x * fitScale
    const regionRight = (region.x + region.w) * fitScale
    const regionTop = region.y * fitScale
    const regionBottom = (region.y + region.h) * fitScale

    // Horizontal, inside the canvas's own scroll box -- center the block if
    // it isn't already fully visible.
    const viewLeft = wrap.scrollLeft
    const viewRight = viewLeft + wrap.clientWidth
    if (regionLeft < viewLeft || regionRight > viewRight) {
      const target = regionLeft - wrap.clientWidth / 2 + (regionRight - regionLeft) / 2
      wrap.scrollTo({ left: Math.max(0, target), behavior: 'smooth' })
    }

    // Vertical, on the page itself -- the diagram panel can sit well below
    // the fold, same APP_HEADER_HEIGHT offset the table's own scroll-to-row
    // uses so the block doesn't land underneath the fixed app header.
    const canvasRect = canvas.getBoundingClientRect()
    const absoluteTop = canvasRect.top + window.scrollY + regionTop
    const absoluteBottom = canvasRect.top + window.scrollY + regionBottom
    if (absoluteTop < window.scrollY + APP_HEADER_HEIGHT) {
      window.scrollBy({ top: absoluteTop - window.scrollY - APP_HEADER_HEIGHT - 8, behavior: 'smooth' })
    } else if (absoluteBottom > window.scrollY + window.innerHeight) {
      window.scrollBy({ top: absoluteBottom - (window.scrollY + window.innerHeight) + 8, behavior: 'smooth' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightedSegmentId])

  function handleCanvasWrapScroll(e) {
    setCanvasScrolled(e.currentTarget.scrollLeft > 0)
  }

  const completion = useMemo(
    () => (hasGenerated ? computeCompletion(road?.roadDetail, road?.range) : null),
    [hasGenerated, road]
  )

  function rangeSuffix() {
    if (!road?.range) return ''
    return formatFilenameRangeSuffix(road.roadDetail, road.range)
  }

  // Renders into a throwaway offscreen canvas at a flat HD factor rather
  // than exporting the on-screen canvas directly -- the on-screen one is
  // only as sharp as this device's own devicePixelRatio (which could be a
  // plain 1 on an ordinary external monitor), independent of what makes a
  // *saved* PNG look good when someone views or prints it elsewhere.
  function exportPng() {
    if (!road) return
    const exportCanvas = document.createElement('canvas')
    const result = renderDiagram(exportCanvas, road.roadDetail, road.settings, road.range, EXPORT_SCALE)
    if (!result || exportCanvas.width === 0) return
    // Bakes the legend below the diagram -- unlike normal/fullscreen/print,
    // a standalone exported PNG has no surrounding app chrome to explain
    // the fills otherwise.
    const finalCanvas = appendLegendBelow(exportCanvas, EXPORT_SCALE)
    const link = document.createElement('a')
    link.download = `${road.roadDetail.section_id}${rangeSuffix()}.png`
    link.href = finalCanvas.toDataURL('image/png')
    link.click()
  }

  function printDiagram() {
    window.print()
  }

  function handleMouseMove(e) {
    // hitRegions are in the canvas's native bitmap coordinates; offsetX/Y
    // are in displayed (CSS) pixels, which differ once fitScale shrinks the
    // canvas below its native size.
    const nx = e.nativeEvent.offsetX / fitScale
    const ny = e.nativeEvent.offsetY / fitScale
    const region = hitRegionsRef.current.find(
      (r) => nx >= r.x && nx <= r.x + r.w && ny >= r.y && ny <= r.y + r.h
    )
    if (!region) {
      setTooltip(null)
      return
    }
    setTooltip({
      clientX: e.clientX,
      clientY: e.clientY,
      segment: region.segment,
      isDone: region.isDone,
      emptyRow: region.segment.isNoData ? null : hoveredEmptyRowType(region, ny),
    })
  }

  // Resolves the clicked block the same way handleMouseMove resolves a
  // hover, then reports its FIRST underlying segment id -- a merged block
  // can fold in several original rows, and "its first row" is the one the
  // table should scroll to and highlight.
  function handleCanvasClick(e) {
    if (!road) return
    const nx = e.nativeEvent.offsetX / fitScale
    const ny = e.nativeEvent.offsetY / fitScale
    const region = hitRegionsRef.current.find(
      (r) => nx >= r.x && nx <= r.x + r.w && ny >= r.y && ny <= r.y + r.h
    )
    if (!region || region.segment.isNoData) return
    onBlockSelect?.({ id: region.segment.mergedIds[0], sectionId: road.roadDetail.section_id })
  }

  return (
    <div className="panel diagram-panel">
      <div className="panel-header-row">
        <h2>5. Road Surface Diagram</h2>
        <div className="no-print" style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            ref={fullscreenBtnRef}
            className="btn-icon-32"
            onClick={openFullscreen}
            disabled={!hasGenerated}
            title="Fullscreen (F)"
            aria-label="Open diagram in fullscreen"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3m11-5v3a2 2 0 0 1-2 2h-3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button className="btn-compact" onClick={printDiagram} disabled={!hasGenerated}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 9V4h12v5M6 18H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-2M6 14h12v6H6z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Print / PDF
          </button>
          <button className="btn-compact" onClick={exportPng} disabled={!hasGenerated}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 16V4m0 12-4-4m4 4 4-4M4 18v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Export PNG
          </button>
        </div>
      </div>
      <p className="hint no-print">
        {road?.settings?.stationsPerLine ?? 10} station interval{(road?.settings?.stationsPerLine ?? 10) !== 1 ? 's' : ''} are
        shown on each horizontal line. Hover a segment for details.
      </p>

      {completion && (
        <div className="completion-summary no-print">
          <ProgressBar pct={completion.pct} className="progress-bar-grow" />
          <span className="completion-label">
            {completion.pct}% Asphalted ({(completion.doneM / 1000).toFixed(1)} km of{' '}
            {(completion.totalM / 1000).toFixed(1)} km)
            {road?.range && (
              <>
                {' '}
                &middot; {formatStationRange(road.roadDetail, road.range)}
              </>
            )}
          </span>
        </div>
      )}

      <div className="diagram-canvas-wrap thin-scroll" ref={canvasWrapRef} onScroll={handleCanvasWrapScroll}>
        {!hasGenerated && (
          <div className="diagram-empty-guide">
            <div className="guide-steps-row">
              {[
                { n: 1, label: 'Upload Excel', done: hasRoads },
                { n: 2, label: 'Select section', done: !!road },
                { n: 3, label: 'Generate diagram', done: false },
              ].map((step, i, arr) => (
                <div className="guide-step-wrap" key={step.n}>
                  <div
                    className={`guide-step ${step.done ? 'guide-step-done' : 'guide-step-pending'}`}
                  >
                    <span className="guide-step-icon">{step.done ? '✓' : step.n}</span>
                    <span className="guide-step-label">{step.label}</span>
                  </div>
                  {i < arr.length - 1 && (
                    <span className={`guide-connector ${step.done ? 'guide-connector-done' : ''}`} />
                  )}
                </div>
              ))}
            </div>
            <p className="guide-hint">
              {!hasRoads
                ? 'Upload an Excel file to get started.'
                : !road
                ? 'Select a road from the sidebar.'
                : 'Click Generate Road Surface Diagram.'}
            </p>
          </div>
        )}
        {hasGenerated && (
          <div className="diagram-canvas-scroll-area">
            {rowLabelLayout.labels.length > 0 && (
              // Wrapped in a zero-width, overflow-visible anchor so this
              // column reserves no flex space of its own -- it overlays the
              // canvas's own (identical, already-painted) margin instead of
              // sitting beside it, which is what kept the labels from
              // appearing twice.
              <div className="diagram-row-labels-anchor no-print">
                <div
                  className={`diagram-row-labels${canvasScrolled ? ' diagram-row-labels-scrolled' : ''}`}
                  style={{ width: rowLabelLayout.leftWidth, height: rowLabelLayout.totalHeight }}
                  aria-hidden="true"
                >
                  {rowLabelLayout.labels.map((l) => (
                    <span
                      key={l.key}
                      className="diagram-row-label"
                      style={{ top: l.top, height: l.height, lineHeight: `${l.height}px`, fontSize: `${11 * fitScale}px` }}
                    >
                      {l.text}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <canvas
              ref={canvasRef}
              id="diagram-canvas"
              // Always explicit now (not just when shrinking): canvas.width
              // is the dpr-scaled BACKING STORE, which a <canvas> with no
              // CSS size displays at 1:1 -- i.e. dpr times too big on-screen
              // without this, even when fitScale is 1 and nothing is meant
              // to be scaled down at all.
              style={{
                ...(nativeSize.width ? { width: nativeSize.width * fitScale, height: nativeSize.height * fitScale } : undefined),
                cursor: 'pointer',
              }}
              onMouseMove={handleMouseMove}
              onMouseLeave={() => setTooltip(null)}
              onClick={handleCanvasClick}
            />
          </div>
        )}
      </div>
      <div className="no-print">
        <Legend />
      </div>

      {/* Print-only: one canvas per strip, packed onto pages naturally (the
          browser fits as many whole strips per page as it can, then
          continues on the next page) -- kept out of the normal layout
          (.print-strips is display:none) and shown only under @media print,
          replacing #diagram-canvas there. The legend repeats here (instead
          of just reusing the onscreen one) because that one lives outside
          .print-strips and stays hidden for print like the rest of the
          app's chrome. */}
      {hasGenerated && (
        <div className="print-strips">
          {Array.from({ length: numStrips }).map((_, i) => (
            <div key={i}>
              {i === 0 && (
                <div className="print-only-header">
                  <strong>{road.roadDetail.section_id}</strong> &mdash; {road.roadDetail.road_name}
                  {road.roadDetail.deo && <> &mdash; {road.roadDetail.deo}</>}
                  {road.range && (
                    <>
                      {' '}
                      &mdash; {formatStationRange(road.roadDetail, road.range)}
                    </>
                  )}
                  {' '}&mdash; Generated {new Date().toLocaleDateString()}
                </div>
              )}
              <canvas ref={(el) => (printCanvasRefs.current[i] = el)} />
            </div>
          ))}
          <div className="print-legend">
            <Legend />
          </div>
        </div>
      )}

      {tooltip && tooltip.segment.isNoData && (
        <div
          className="diagram-tooltip no-print"
          style={{ left: tooltip.clientX + 14, top: tooltip.clientY + 14 }}
        >
          <div className="tooltip-status tooltip-nodata">No data</div>
          <div className="tooltip-row">
            <span>Station</span>
            <span>{tooltip.segment.start_station} &ndash; {tooltip.segment.end_station}</span>
          </div>
          <div className="tooltip-row">
            <span>Length</span>
            <span>{Math.round(tooltip.segment.length_m).toLocaleString()} m</span>
          </div>
        </div>
      )}
      {tooltip && !tooltip.segment.isNoData && tooltip.emptyRow && (
        <div
          className="diagram-tooltip no-print"
          style={{ left: tooltip.clientX + 14, top: tooltip.clientY + 14 }}
        >
          <div className="tooltip-status tooltip-empty-row">
            {tooltip.emptyRow === 'no-lane' ? 'No lane at this station' : 'No shoulder (None)'}
          </div>
        </div>
      )}
      {tooltip && !tooltip.segment.isNoData && !tooltip.emptyRow && (
        <div
          className="diagram-tooltip no-print"
          style={{ left: tooltip.clientX + 14, top: tooltip.clientY + 14 }}
        >
          <div className={`tooltip-status ${tooltip.isDone ? 'tooltip-done' : 'tooltip-not-done'}`}>
            {tooltip.isDone ? '✓ Asphalted' : '✕ Not yet asphalted'}
          </div>
          <div className="tooltip-row">
            <span>Station</span>
            <span>{tooltip.segment.start_station} &ndash; {tooltip.segment.end_station}</span>
          </div>
          <div className="tooltip-row">
            <span>Length</span>
            <span>{Math.round(tooltip.segment.length_m).toLocaleString()} m</span>
          </div>
          <div className="tooltip-row">
            <span>Lanes</span>
            <span>{tooltip.segment.num_lanes}</span>
          </div>
          <div className="tooltip-row">
            <span>Surface</span>
            <span>{tooltip.segment.surface_type}</span>
          </div>
          <div className="tooltip-row">
            <span>Shoulder L / R</span>
            <span>{tooltip.segment.shoulder_left} / {tooltip.segment.shoulder_right}</span>
          </div>
          {tooltip.segment.mergedCount > 1 && (
            <div className="tooltip-row">
              <span>Merged</span>
              <span>{tooltip.segment.mergedCount} segments</span>
            </div>
          )}
          {tooltip.segment.irregular_km_post && (
            <div className="tooltip-irregular">⚠ Irregular km post</div>
          )}
        </div>
      )}

      {/* Always mounted (even when empty) so requestFullscreen() in
          openFullscreen() above always has a real target -- see that
          function's comment. DiagramFullscreen renders as its plain child
          (no portal): its own position:fixed/inset:0 covers the viewport
          whether or not the browser actually granted true fullscreen. */}
      <div ref={fullscreenAnchorRef} className="diagram-fullscreen-anchor">
        {fullscreenOpen && hasGenerated && (
          <DiagramFullscreen
            road={road}
            completion={completion}
            onClose={() => setFullscreenOpen(false)}
            onPrint={printDiagram}
            onExportPng={exportPng}
            triggerRef={fullscreenBtnRef}
          />
        )}
      </div>
    </div>
  )
})

export default DiagramPanel
