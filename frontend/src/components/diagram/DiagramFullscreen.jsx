import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { formatStationRange } from '../../utils/chainage'
import Legend from './Legend'
import { useModalLayer } from '../common/useModalLayer'
import { useDevicePixelRatio } from '../../utils/useDevicePixelRatio'
import { renderDiagram, getCanvasLogicalSize, hoveredEmptyRowType } from './diagramRenderer'
import ProgressBar from '../common/ProgressBar'

const ZOOM_MIN = 0.25
const ZOOM_MAX = 3
const ZOOM_STEP = 0.15
const CLOSE_ANIMATION_MS = 250

function clampZoom(z) {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z))
}

function exitBrowserFullscreen() {
  const exit = document.exitFullscreen || document.webkitExitFullscreen
  if ((document.fullscreenElement || document.webkitFullscreenElement) && exit) {
    return exit.call(document).catch(() => {})
  }
  return Promise.resolve()
}

/**
 * Full-viewport diagram view. Uses the exact same renderDiagram/layout math
 * as the normal view (same hitRegions, same label collision handling, same
 * everything) -- it just renders into its own canvas at a different scale,
 * so station labels that don't overlap at 100% can't overlap at 40% or
 * 300% either, and Print/Export PNG are the same functions DiagramPanel
 * uses on its own canvas.
 *
 * Not portaled to document.body here -- DiagramPanel renders this inside a
 * persistent, always-mounted anchor element and calls the real
 * element.requestFullscreen() on THAT anchor synchronously from the user's
 * click/keypress (required by the Fullscreen API; this component mounts a
 * moment later via React, too late for that same call to count as
 * user-gesture-initiated). Its own position:fixed/inset:0 styling still
 * makes it cover the full viewport exactly as before, both when true
 * fullscreen engages and as the in-window fallback when it doesn't.
 *
 * Re-renders its own canvas (via the same renderDiagram the normal view
 * uses) at devicePixelRatio*zoom whenever either changes, rather than
 * copying one fixed-resolution bitmap and CSS-stretching it to zoom --
 * that's what used to make zoomed-in text/lines/hatching look soft here
 * even though the normal view (at 100%, no stretch) looked fine.
 */
export default function DiagramFullscreen({ road, completion, onClose, onPrint, onExportPng, triggerRef }) {
  const dpr = useDevicePixelRatio()
  const containerRef = useRef(null)
  const canvasRef = useRef(null)
  const dragRef = useRef(null)
  const hitRegionsRef = useRef([])
  const [zoom, setZoom] = useState(1)
  const [fitMode, setFitMode] = useState(true)
  const fitModeRef = useRef(fitMode)
  const [tooltip, setTooltip] = useState(null)
  const [ready, setReady] = useState(false)
  const [closing, setClosing] = useState(false)
  const [dragging, setDragging] = useState(false)
  // Logical (CSS-pixel, scale-independent) size of the diagram -- the same
  // layout dimensions the normal view's canvas would have at 100%/1x. Zoom
  // and dpr only ever affect the canvas's backing-store resolution and its
  // CSS display size (nativeWidth*zoom below), never this.
  const [logicalSize, setLogicalSize] = useState({ width: 0, height: 0 })
  // Even though fullscreen is usually opened from the normal page (not
  // nested under another modal), it still joins the shared stack -- if a
  // confirm/alert ever opens from within it, that needs to render ON TOP,
  // which only works if both participate in the same ordering.
  const { zIndex, isTop } = useModalLayer()

  const nativeWidth = logicalSize.width
  const nativeHeight = logicalSize.height
  // Guards against double-closing: our own exit button calls exitFullscreen
  // (below) AND that itself fires fullscreenchange, which would otherwise
  // call requestClose a second time.
  const closingRef = useRef(false)

  function requestClose() {
    if (closingRef.current) return
    closingRef.current = true
    exitBrowserFullscreen()
    setClosing(true)
    setTimeout(onClose, CLOSE_ANIMATION_MS)
  }

  // The logical layout size depends only on the road/settings/range -- not
  // on zoom or dpr -- so it's computed separately from the render effect
  // below, which re-runs far more often (every zoom step).
  useEffect(() => {
    if (!road) {
      setLogicalSize({ width: 0, height: 0 })
      return
    }
    setLogicalSize(getCanvasLogicalSize(road.roadDetail, road.settings, road.range))
  }, [road])

  // Re-renders (not CSS-stretches) at devicePixelRatio*zoom -- the canvas's
  // CSS display size is set separately below (nativeWidth*zoom, logical
  // units), so this only ever changes how much actual pixel detail backs
  // that same displayed size.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !road || !nativeWidth) return
    const result = renderDiagram(canvas, road.roadDetail, road.settings, road.range, dpr * zoom)
    hitRegionsRef.current = result?.hitRegions || []
  }, [road, nativeWidth, zoom, dpr])

  function computeFitZoom() {
    const container = containerRef.current
    if (!container || !nativeWidth) return 1
    const availableWidth = container.clientWidth - 32
    return clampZoom(availableWidth / nativeWidth)
  }

  // Default view is "fit to width" -- computed once the container has a
  // real size, and recalculated on resize as long as the user hasn't
  // explicitly zoomed away from fit mode.
  useLayoutEffect(() => {
    setZoom(computeFitZoom())
    setReady(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeWidth, nativeHeight])

  useEffect(() => {
    function handleResize() {
      if (fitMode) setZoom(computeFitZoom())
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitMode, nativeWidth])

  // Keeps a ref mirror of fitMode for the fullscreenchange listener below,
  // which is registered once ([] deps) and would otherwise close over a
  // stale value.
  useEffect(() => {
    fitModeRef.current = fitMode
  }, [fitMode])

  // DiagramPanel already called element.requestFullscreen() synchronously
  // on its anchor before this mounted -- this just reacts to the result:
  // re-fits once the transition lands (true fullscreen hands over more
  // viewport than the windowed browser had), and syncs the app's own state
  // closed if the user exits via Esc, F11, or any other OS/browser-native
  // path that bypasses our own exit button entirely.
  useEffect(() => {
    function handleFullscreenChange() {
      const inFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement)
      if (inFullscreen) {
        if (fitModeRef.current) setZoom(computeFitZoom())
      } else if (!closingRef.current) {
        requestClose()
      }
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange)
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Body scroll lock + Esc/F to close + return focus, same pattern as every
  // other overlay in this app. Esc also triggers the browser's own native
  // exit-fullscreen behavior (not cancelable) -- that's handled by the
  // fullscreenchange listener above; this handler covers F, and Esc for the
  // in-window fallback case where true fullscreen never actually engaged.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    function handleKeyDown(e) {
      if (!isTop()) return
      if (e.key === 'Escape' || e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        requestClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = prevOverflow
      triggerRef?.current?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function zoomIn() {
    setFitMode(false)
    setZoom((z) => clampZoom(z + ZOOM_STEP))
  }
  function zoomOut() {
    setFitMode(false)
    setZoom((z) => clampZoom(z - ZOOM_STEP))
  }
  function fitToScreen() {
    setFitMode(true)
    setZoom(computeFitZoom())
  }

  // Browsers can't reliably show the print dialog/preview while a true
  // Fullscreen-API session is active, so leave it first and only then hand
  // off to the same print function the normal view uses. Exiting fires
  // fullscreenchange, which (via the listener above) closes this view back
  // to the normal page -- same as pressing Esc, just triggered by Print.
  async function handlePrintClick() {
    await exitBrowserFullscreen()
    onPrint()
  }

  function handleMouseDown(e) {
    const container = containerRef.current
    if (!container) return
    dragRef.current = { startX: e.clientX, startY: e.clientY, scrollLeft: container.scrollLeft, scrollTop: container.scrollTop }
    setDragging(true)
  }

  useEffect(() => {
    function handleMouseMove(e) {
      if (!dragRef.current || !containerRef.current) return
      const d = dragRef.current
      containerRef.current.scrollLeft = d.scrollLeft - (e.clientX - d.startX)
      containerRef.current.scrollTop = d.scrollTop - (e.clientY - d.startY)
    }
    function handleMouseUp() {
      dragRef.current = null
      setDragging(false)
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  function handleCanvasMouseMove(e) {
    if (dragRef.current || !hitRegionsRef.current.length || !canvasRef.current) return
    const rect = canvasRef.current.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    // hitRegions are in logical units; the canvas's CSS size is always
    // nativeWidth*zoom (logical * zoom), so dividing by zoom alone recovers
    // logical coordinates regardless of the canvas's actual backing-store
    // resolution (dpr*zoom) -- no dependency on measuring rect.width at all.
    const nx = (e.clientX - rect.left) / zoom
    const ny = (e.clientY - rect.top) / zoom
    const region = hitRegionsRef.current.find((r) => nx >= r.x && nx <= r.x + r.w && ny >= r.y && ny <= r.y + r.h)
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

  // Clamped so the tooltip can never render partly off-screen, unlike the
  // normal view where the page itself can scroll to reveal it.
  function tooltipStyle(t) {
    const estW = 220
    const estH = 150
    const pad = 14
    let left = t.clientX + pad
    let top = t.clientY + pad
    if (left + estW > window.innerWidth) left = t.clientX - estW - pad
    if (top + estH > window.innerHeight) top = t.clientY - estH - pad
    return { left: Math.max(8, left), top: Math.max(8, top) }
  }

  const canOverflow = nativeWidth * zoom > (containerRef.current?.clientWidth || 0) || nativeHeight * zoom > (containerRef.current?.clientHeight || 0)

  return (
    <div
      className={`diagram-fullscreen-overlay no-print${ready && !closing ? ' diagram-fullscreen-ready' : ''}${closing ? ' diagram-fullscreen-closing' : ''}`}
      style={{ zIndex: zIndex ?? 3000 }}
      role="dialog"
      aria-modal="true"
      aria-label={`${road.roadDetail.section_id} fullscreen diagram`}
    >
      <div className="fullscreen-topbar">
        <div className="fullscreen-topbar-left">
          <div className="fullscreen-road-id-row">
            <span className="mono fullscreen-road-id">{road.roadDetail.section_id}</span>
            <span className="fullscreen-road-name">{road.roadDetail.road_name}</span>
            {road.range && (
              <span className="fullscreen-station-range">
                {formatStationRange(road.roadDetail, road.range)}
              </span>
            )}
          </div>
          {completion && (
            <div className="fullscreen-completion">
              <ProgressBar pct={completion.pct} className="fullscreen-completion-bar" />
              <span className="completion-label">
                {completion.pct}% Asphalted ({(completion.doneM / 1000).toFixed(1)} km of{' '}
                {(completion.totalM / 1000).toFixed(1)} km)
              </span>
            </div>
          )}
        </div>
        <div className="fullscreen-topbar-right">
          <button type="button" className="fullscreen-btn" onClick={zoomOut} disabled={zoom <= ZOOM_MIN} title="Zoom out" aria-label="Zoom out">
            −
          </button>
          <span className="fullscreen-zoom-pct">{Math.round(zoom * 100)}%</span>
          <button type="button" className="fullscreen-btn" onClick={zoomIn} disabled={zoom >= ZOOM_MAX} title="Zoom in" aria-label="Zoom in">
            +
          </button>
          <button type="button" className="btn-compact fullscreen-fit-btn" onClick={fitToScreen}>
            Fit to screen
          </button>
          <button type="button" className="btn-compact" onClick={handlePrintClick}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 9V4h12v5M6 18H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-2M6 14h12v6H6z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Print / PDF
          </button>
          <button type="button" className="btn-compact" onClick={onExportPng}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 16V4m0 12-4-4m4 4 4-4M4 18v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Export PNG
          </button>
          <button type="button" className="fullscreen-exit-btn" onClick={requestClose} title="Exit fullscreen (Esc)" aria-label="Exit fullscreen">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M9 3H5a2 2 0 0 0-2 2v4m18 0V5a2 2 0 0 0-2-2h-4M3 15v4a2 2 0 0 0 2 2h4m10-6v4a2 2 0 0 1-2 2h-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      <div
        className={`fullscreen-canvas-wrap thin-scroll${dragging ? ' fullscreen-dragging' : ''}`}
        ref={containerRef}
        onMouseDown={canOverflow ? handleMouseDown : undefined}
      >
        <canvas
          ref={canvasRef}
          style={{ width: nativeWidth * zoom, height: nativeHeight * zoom }}
          onMouseMove={handleCanvasMouseMove}
          onMouseLeave={() => setTooltip(null)}
        />
      </div>

      <div className="fullscreen-legend-bar">
        <Legend />
        <div className="fullscreen-status-legend">
          <span className="fullscreen-status-swatch fullscreen-status-done" />
          Asphalted
          <span className="fullscreen-status-swatch fullscreen-status-pending" />
          Not asphalted
        </div>
      </div>

      {tooltip && tooltip.segment.isNoData && (
        <div className="diagram-tooltip no-print" style={tooltipStyle(tooltip)}>
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
        <div className="diagram-tooltip no-print" style={tooltipStyle(tooltip)}>
          <div className="tooltip-status tooltip-empty-row">
            {tooltip.emptyRow === 'no-lane' ? 'No lane at this station' : 'No shoulder (None)'}
          </div>
        </div>
      )}
      {tooltip && !tooltip.segment.isNoData && !tooltip.emptyRow && (
        <div className="diagram-tooltip no-print" style={tooltipStyle(tooltip)}>
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
    </div>
  )
}
