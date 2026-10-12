import { useEffect, useRef, useState } from 'react'
import { showAlert } from './common/DialogProvider'

// Two thresholds (not one) so a scroll position that lands between them can't
// flip the header back and forth -- it only switches state when scrollY
// crosses OUT of the dead zone in one direction.
const SHRINK_ON_Y = 60
const EXPAND_BELOW_Y = 20

const HOW_TO_USE_STEPS = [
  { title: 'Upload', detail: 'Upload your road inventory Excel file in "1. Upload Excel File".' },
  { title: 'Select road', detail: 'Pick a Road ID from "2. Select Road" to load its segments.' },
  { title: 'Set range', detail: 'Adjust the Start/End Station and diagram settings in "3. Diagram Settings".' },
  { title: 'Generate', detail: 'Click "Generate Road Surface Diagram" to draw the strip map.' },
  { title: 'Print / Export', detail: 'Use "Print / PDF" or "Export PNG" above the diagram to save it.' },
]

function openHowToUse() {
  showAlert({
    title: 'How to use this system',
    confirmText: 'Got it',
    variant: 'info',
    message: (
      <ol className="how-to-use-list">
        {HOW_TO_USE_STEPS.map((step, i) => (
          <li key={step.title}>
            <span className="how-to-use-step-n">{i + 1}</span>
            <span>
              <strong>{step.title}.</strong> {step.detail}
            </span>
          </li>
        ))}
      </ol>
    ),
  })
}

export default function Header({ summary, lastUploadAt }) {
  const [shrunk, setShrunk] = useState(false)
  const shrunkRef = useRef(false)
  const tickingRef = useRef(false)

  useEffect(() => {
    function applyScrollState() {
      tickingRef.current = false
      const y = window.scrollY
      // Hysteresis: only cross state in one direction per threshold, so a
      // scrollY sitting in the 20-60 dead zone (which the header's own
      // shrink/expand can nudge by a few px via rounding/layout) never
      // flips the state back and forth.
      if (!shrunkRef.current && y > SHRINK_ON_Y) {
        shrunkRef.current = true
        setShrunk(true)
      } else if (shrunkRef.current && y < EXPAND_BELOW_Y) {
        shrunkRef.current = false
        setShrunk(false)
      }
    }

    function handleScroll() {
      if (tickingRef.current) return
      tickingRef.current = true
      window.requestAnimationFrame(applyScrollState)
    }

    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  const hasStats = !!summary && summary.roads.length > 0

  return (
    <>
    <header className={`app-header no-print${shrunk ? ' app-header-shrunk' : ''}`}>
      <div className="app-header-inner">
        <div className="app-header-brand">
          <div className="app-logo-wrap">
            <img src="/favicon.svg" alt="" width="24" height="24" className="app-logo" />
          </div>
          <div className="app-header-title-col">
            <h1>Road Inventory &amp; Surface Diagram System</h1>
            <p>Excel-Based Road Inventory Management</p>
          </div>
        </div>

        <div className="app-header-right">
          {hasStats && (
            <>
              <div className="header-stats">
                <span className="header-stat-chip">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M6 19 11 5m2 0 5 14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {summary.roads.length} road{summary.roads.length !== 1 ? 's' : ''}
                </span>
                <span className="header-stat-chip">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M4 12h16M7 9v6M11 9v6M15 9v6M17 9v6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {(summary.total_length_m / 1000).toFixed(1)} km
                </span>
                <span className="header-stat-chip header-stat-chip-good">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="m6 12 4 4 8-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {summary.pct}% asphalted
                </span>
              </div>
              {lastUploadAt && (
                <span className="header-last-upload">
                  Last upload: {lastUploadAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </span>
              )}
            </>
          )}
          <button
            type="button"
            className="header-help-btn"
            title="How to use this system"
            aria-label="How to use this system"
            onClick={openHowToUse}
          >
            ?
          </button>
        </div>
      </div>
    </header>
    <div className="app-header-spacer no-print" aria-hidden="true" />
    </>
  )
}
