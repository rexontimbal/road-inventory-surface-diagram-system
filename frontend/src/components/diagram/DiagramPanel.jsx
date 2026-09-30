import { useEffect, useMemo, useRef, useState } from 'react'
import { renderDiagram, renderSingleStrip, getNumStrips } from './diagramRenderer'
import Legend from './Legend'

function computeCompletion(roadDetail) {
  if (!roadDetail || !roadDetail.segments.length) return null
  let doneM = 0
  const totalM = roadDetail.total_length_m
  for (const seg of roadDetail.segments) {
    if (seg.surface_type === 'asphalt') doneM += seg.end_m - seg.start_m
  }
  const pct = totalM > 0 ? Math.round((doneM / totalM) * 100) : 0
  return { pct, doneM, totalM }
}

export default function DiagramPanel({ road, diagramVersion, hasGenerated }) {
  const canvasRef = useRef(null)
  const hitRegionsRef = useRef([])
  const printCanvasRefs = useRef([])
  const [tooltip, setTooltip] = useState(null)

  const numStrips = useMemo(
    () => (road ? getNumStrips(road.roadDetail, road.settings) : 0),
    [road, diagramVersion]
  )

  useEffect(() => {
    if (!hasGenerated) setTooltip(null)
  }, [hasGenerated])

  useEffect(() => {
    if (!road || !canvasRef.current) return
    const result = renderDiagram(canvasRef.current, road.roadDetail, road.settings)
    hitRegionsRef.current = result?.hitRegions || []

    // One canvas per strip for print, sized to fit one page each -- avoids
    // the browser pushing the whole tall combined canvas to a near-empty
    // leading page before it "fits".
    printCanvasRefs.current.slice(0, numStrips).forEach((c, i) => {
      if (c) renderSingleStrip(c, road.roadDetail, road.settings, i)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagramVersion, numStrips])

  const completion = useMemo(
    () => (hasGenerated ? computeCompletion(road?.roadDetail) : null),
    [hasGenerated, road]
  )

  function exportPng() {
    const canvas = canvasRef.current
    if (!canvas || canvas.width === 0) return
    const link = document.createElement('a')
    link.download = `${road.roadDetail.road_name}_${road.roadDetail.road_id}_diagram.png`
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
        <div className="no-print" style={{ display: 'flex', gap: 8 }}>
          <button onClick={printDiagram} disabled={!hasGenerated}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 9V4h12v5M6 18H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-2M6 14h12v6H6z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Print / PDF
          </button>
          <button onClick={exportPng} disabled={!hasGenerated}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 16V4m0 12-4-4m4 4 4-4M4 18v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Export PNG
          </button>
        </div>
      </div>
      <p className="hint no-print">Ten station intervals are shown on each horizontal line. Hover a segment for details.</p>

      {completion && (
        <div className="completion-summary no-print">
          <div className="completion-bar">
            <div className="completion-bar-fill" style={{ width: `${completion.pct}%` }} />
          </div>
          <span className="completion-label">
            {completion.pct}% Asphalted ({(completion.doneM / 1000).toFixed(1)} km of{' '}
            {(completion.totalM / 1000).toFixed(1)} km)
          </span>
        </div>
      )}

      <div className="diagram-canvas-wrap">
        {!hasGenerated && (
          <p className="placeholder">
            Upload an Excel file, select a road, and click Generate Road Surface Diagram.
          </p>
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
                  <strong>{road.roadDetail.road_name}</strong> ({road.roadDetail.road_id}) &mdash;
                  Generated {new Date().toLocaleDateString()}
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
    </div>
  )
}
