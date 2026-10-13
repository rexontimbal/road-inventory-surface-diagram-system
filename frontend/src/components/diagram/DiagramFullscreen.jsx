import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatStation } from '../../utils/chainage'
import Legend from './Legend'
import { useModalLayer } from '../common/useModalLayer'

const ZOOM_MIN = 0.25
const ZOOM_MAX = 3
const ZOOM_STEP = 0.15
const CLOSE_ANIMATION_MS = 250

function clampZoom(z) {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z))
}

/**
 * Full-viewport diagram view. Renders its own canvas but never re-runs the
 * strip-layout math -- it copies the bitmap that DiagramPanel's own canvas
 * already rendered (ctx.drawImage), so zoom is pure CSS sizing of a canvas
 * rendered once at native resolution. That's also why station labels never
 * overlap at any zoom level: the whole bitmap (text included) scales
 * uniformly, so spacing that doesn't collide at 100% can't collide at 40%
 * or 300% either. Print/Export PNG are the exact same functions DiagramPanel
 * already uses on its own canvas, so fullscreen can never produce different
 * output than the normal view.
 */
export default function DiagramFullscreen({ road, completion, sourceCanvas, hitRegions, onClose, onPrint, onExportPng, triggerRef }) {
  const containerRef = useRef(null)
  const canvasRef = useRef(null)
  const dragRef = useRef(null)
  const [zoom, setZoom] = useState(1)
  const [fitMode, setFitMode] = useState(true)
  const [tooltip, setTooltip] = useState(null)
  const [ready, setReady] = useState(false)
  const [closing, setClosing] = useState(false)
  const [dragging, setDragging] = useState(false)
  // Even though fullscreen is usually opened from the normal page (not
  // nested under another modal), it still joins the shared stack -- if a
  // confirm/alert ever opens from within it, that needs to render ON TOP,
  // which only works if both participate in the same ordering.
  const { zIndex, isTop } = useModalLayer()

  const nativeWidth = sourceCanvas?.width || 0
  const nativeHeight = sourceCanvas?.height || 0

  function requestClose() {
    setClosing(true)
    setTimeout(onClose, CLOSE_ANIMATION_MS)
  }

  // Copy the already-rendered bitmap once per diagram -- no re-layout here.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !sourceCanvas || !nativeWidth) return
    canvas.width = nativeWidth
    canvas.height = nativeHeight
    canvas.getContext('2d').drawImage(sourceCanvas, 0, 0)
  }, [sourceCanvas, nativeWidth, nativeHeight])

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

  // Fullscreen API as a best-effort enhancement -- the CSS overlay is the
  // real mechanism and works regardless of whether the browser grants it.
  // Body scroll lock + Esc/F to close + return focus, same pattern as every
  // other overlay in this app.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {})
    }

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
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
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
    if (dragRef.current || !hitRegions || !canvasRef.current) return
    const rect = canvasRef.current.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const scaleX = nativeWidth / rect.width
    const scaleY = nativeHeight / rect.height
    const nx = (e.clientX - rect.left) * scaleX
    const ny = (e.clientY - rect.top) * scaleY
    const region = hitRegions.find((r) => nx >= r.x && nx <= r.x + r.w && ny >= r.y && ny <= r.y + r.h)
    if (!region) {
      setTooltip(null)
      return
    }
    setTooltip({ clientX: e.clientX, clientY: e.clientY, segment: region.segment, isDone: region.isDone })
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

  return createPortal(
    <div
      className={`diagram-fullscreen-overlay no-print${ready && !closing ? ' diagram-fullscreen-ready' : ''}${closing ? ' diagram-fullscreen-closing' : ''}`}
      style={{ zIndex: zIndex ?? 3000 }}
      role="dialog"
      aria-modal="true"
      aria-label={`${road.roadDetail.road_id} fullscreen diagram`}
    >
      <div className="fullscreen-topbar">
        <div className="fullscreen-topbar-left">
          <div className="fullscreen-road-id-row">
            <span className="mono fullscreen-road-id">{road.roadDetail.road_id}</span>
            <span className="fullscreen-road-name">{road.roadDetail.road_name}</span>
            {road.range && (
              <span className="fullscreen-station-range">
                Sta. {formatStation(road.range.startM)} – {formatStation(road.range.endM)}
              </span>
            )}
          </div>
          {completion && (
            <div className="fullscreen-completion">
              <div className="completion-bar fullscreen-completion-bar">
                <div className="completion-bar-fill" style={{ width: `${completion.pct}%` }} />
              </div>
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
          <button type="button" className="btn-compact" onClick={onPrint}>
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

      {tooltip && (
        <div className="diagram-tooltip no-print" style={tooltipStyle(tooltip)}>
          <div className={`tooltip-status ${tooltip.isDone ? 'tooltip-done' : 'tooltip-not-done'}`}>
            {tooltip.isDone ? '✓ Asphalted' : '✕ Not yet asphalted'}
          </div>
          <div className="tooltip-row">
            <span>Station</span>
            <span>{tooltip.segment.start_station} &ndash; {tooltip.segment.end_station}</span>
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
        </div>
      )}
    </div>,
    document.body
  )
}
