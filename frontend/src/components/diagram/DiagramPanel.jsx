import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { renderDiagram, renderSingleStrip, getNumStrips } from './diagramRenderer'
import { formatStation } from '../../utils/chainage'
import Legend from './Legend'
import DiagramFullscreen from './DiagramFullscreen'

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

const DiagramPanel = forwardRef(function DiagramPanel({ road, diagramVersion, hasGenerated, hasRoads }, ref) {
  const canvasRef = useRef(null)
  const hitRegionsRef = useRef([])
  const printCanvasRefs = useRef([])
  const fullscreenBtnRef = useRef(null)
  const [tooltip, setTooltip] = useState(null)
  const [fullscreenOpen, setFullscreenOpen] = useState(false)

  useImperativeHandle(ref, () => ({
    openFullscreen: () => {
      if (hasGenerated) setFullscreenOpen(true)
    },
  }))

  const numStrips = useMemo(
    () => (road ? getNumStrips(road.roadDetail, road.settings, road.range) : 0),
    [road, diagramVersion]
  )

  useEffect(() => {
    if (!hasGenerated) setTooltip(null)
  }, [hasGenerated])

  useEffect(() => {
    if (!road || !canvasRef.current) return
    const result = renderDiagram(canvasRef.current, road.roadDetail, road.settings, road.range)
    hitRegionsRef.current = result?.hitRegions || []

    // One canvas per strip for print, sized to fit one page each -- avoids
    // the browser pushing the whole tall combined canvas to a near-empty
    // leading page before it "fits".
    printCanvasRefs.current.slice(0, numStrips).forEach((c, i) => {
      if (c) renderSingleStrip(c, road.roadDetail, road.settings, i, road.range)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagramVersion, numStrips])

  const completion = useMemo(
    () => (hasGenerated ? computeCompletion(road?.roadDetail, road?.range) : null),
    [hasGenerated, road]
  )

  function rangeSuffix() {
    if (!road?.range) return ''
    return `_Sta${formatStation(road.range.startM)}-${formatStation(road.range.endM)}`
  }

  function exportPng() {
    const canvas = canvasRef.current
    if (!canvas || canvas.width === 0) return
    const link = document.createElement('a')
    link.download = `${road.roadDetail.road_id}${rangeSuffix()}.png`
    link.href = canvas.toDataURL('image/png')
    link.click()
  }

  function printDiagram() {
    window.print()
  }

  function handleMouseMove(e) {
    const region = hitRegionsRef.current.find(
      (r) =>
        e.nativeEvent.offsetX >= r.x &&
        e.nativeEvent.offsetX <= r.x + r.w &&
        e.nativeEvent.offsetY >= r.y &&
        e.nativeEvent.offsetY <= r.y + r.h
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
    })
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
            onClick={() => setFullscreenOpen(true)}
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
          <div className="completion-bar">
            <div className="completion-bar-fill" style={{ width: `${completion.pct}%` }} />
          </div>
          <span className="completion-label">
            {completion.pct}% Asphalted ({(completion.doneM / 1000).toFixed(1)} km of{' '}
            {(completion.totalM / 1000).toFixed(1)} km)
            {road?.range && (
              <>
                {' '}
                &middot; Sta. {formatStation(road.range.startM)} &ndash; {formatStation(road.range.endM)}
              </>
            )}
          </span>
        </div>
      )}

      <div className="diagram-canvas-wrap thin-scroll">
        {!hasGenerated && (
          <div className="diagram-empty-guide">
            <div className="guide-steps-row">
              {[
                { n: 1, label: 'Upload Excel', done: hasRoads },
                { n: 2, label: 'Select road', done: !!road },
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
          <canvas
            ref={canvasRef}
            id="diagram-canvas"
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setTooltip(null)}
          />
        )}
      </div>
      <Legend />

      {/* Print-only: one canvas per strip, packed onto pages naturally (the
          browser fits as many whole strips per page as it can, then
          continues on the next page) -- kept out of the normal layout
          (.print-strips is display:none) and shown only under @media print,
          replacing #diagram-canvas there. */}
      {hasGenerated && (
        <div className="print-strips">
          {Array.from({ length: numStrips }).map((_, i) => (
            <div key={i}>
              {i === 0 && (
                <div className="print-only-header">
                  <strong>{road.roadDetail.road_name}</strong> ({road.roadDetail.road_id})
                  {road.range && (
                    <>
                      {' '}
                      &mdash; Sta. {formatStation(road.range.startM)}&ndash;{formatStation(road.range.endM)}
                    </>
                  )}
                  {' '}&mdash; Generated {new Date().toLocaleDateString()}
                </div>
              )}
              <canvas ref={(el) => (printCanvasRefs.current[i] = el)} />
            </div>
          ))}
        </div>
      )}

      {tooltip && (
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

      {fullscreenOpen && hasGenerated && (
        <DiagramFullscreen
          road={road}
          completion={completion}
          sourceCanvas={canvasRef.current}
          hitRegions={hitRegionsRef.current}
          onClose={() => setFullscreenOpen(false)}
          onPrint={printDiagram}
          onExportPng={exportPng}
          triggerRef={fullscreenBtnRef}
        />
      )}
    </div>
  )
})

export default DiagramPanel
