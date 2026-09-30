import { useEffect, useRef } from 'react'
import { renderDiagram } from './diagramRenderer'
import Legend from './Legend'

export default function DiagramPanel({ road, diagramVersion, hasGenerated }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    if (!road || !canvasRef.current) return
    renderDiagram(canvasRef.current, road.roadDetail, road.settings)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagramVersion])

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
      <p className="hint no-print">Ten station intervals are shown on each horizontal line.</p>
      <div className="diagram-canvas-wrap">
        {!hasGenerated && (
          <p className="placeholder">
            Upload an Excel file, select a road, and click Generate Road Surface Diagram.
          </p>
        )}
        <canvas ref={canvasRef} id="diagram-canvas" />
      </div>
      <Legend />
    </div>
  )
}
