import { useEffect, useRef, useState } from 'react'
import Header, { openHowToUse } from './components/Header'
import UploadPanel from './components/sidebar/UploadPanel'
import RoadSelectPanel from './components/sidebar/RoadSelectPanel'
import DiagramSettingsPanel from './components/sidebar/DiagramSettingsPanel'
import RoadInventoryTable from './components/inventory/RoadInventoryTable'
import NetworkSummaryBar from './components/inventory/NetworkSummaryBar'
import DiagramPanel from './components/diagram/DiagramPanel'
import {
  deleteRoad,
  fetchNetworkSummary,
  fetchRoadDetail,
  fetchRoadsList,
  fetchSegmentsPage,
} from './api/roads'
import { formatStation, parseStationInput } from './utils/chainage'
import { readUploadMeta, writeUploadMeta } from './utils/uploadMeta'
import { showToast } from './components/common/DialogProvider'
import './App.css'

const PAGE_SIZE = 10
const NETWORK_SUMMARY_OPEN_KEY = 'ris.networkSummaryOpen'

function readStoredNetworkSummaryOpen() {
  try {
    return localStorage.getItem(NETWORK_SUMMARY_OPEN_KEY) === 'true'
  } catch {
    return false
  }
}

export default function App() {
  const [roads, setRoads] = useState([])
  const [selectedRoadId, setSelectedRoadId] = useState('')
  const [roadDetail, setRoadDetail] = useState(null)
  const [segmentsPage, setSegmentsPage] = useState(null)
  const [tablePage, setTablePage] = useState(1)
  const [tableFilters, setTableFilters] = useState({ roadId: '', status: '', surfaceType: '' })
  const [tableSort, setTableSort] = useState({ sortBy: null, sortDir: 'asc' })
  const [networkSummary, setNetworkSummary] = useState(null)
  const [settings, setSettings] = useState({ stationIntervalM: 1000, stationsPerLine: 10 })
  const [range, setRange] = useState({ startRaw: '', endRaw: '' })
  const [generatedRange, setGeneratedRange] = useState(null)
  const [diagramVersion, setDiagramVersion] = useState(0)
  const [hasGenerated, setHasGenerated] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  // Single source of truth for upload metadata -- both the header's "Last
  // upload" and the sidebar's "Last file" read this same state, seeded from
  // localStorage so it survives a refresh (road data itself persists in the
  // backend DB; this is just the descriptive file name/timestamp).
  const [uploadMeta, setUploadMeta] = useState(readUploadMeta)
  const [networkSummaryOpen, setNetworkSummaryOpen] = useState(readStoredNetworkSummaryOpen)
  const uploadPanelRef = useRef(null)
  const diagramPanelRef = useRef(null)

  async function refreshRoads() {
    const list = await fetchRoadsList()
    setRoads(list)
  }

  async function refreshSegmentsPage(page, filters, sort) {
    const data = await fetchSegmentsPage(page, PAGE_SIZE, filters, sort)
    setSegmentsPage(data)
  }

  async function refreshSummary() {
    const data = await fetchNetworkSummary()
    setNetworkSummary(data)
  }

  useEffect(() => {
    refreshRoads()
    refreshSegmentsPage(1, tableFilters, tableSort)
    refreshSummary()
  }, [])

  // One-time cleanup of keys left behind by the retired "No backup in 7
  // days" reminder banner -- the feature is gone, but browsers that saw it
  // before still have these in localStorage.
  useEffect(() => {
    try {
      localStorage.removeItem('ris.lastBackupAt')
      localStorage.removeItem('ris.backupReminderDismissedAt')
    } catch {
      // localStorage unavailable -- nothing to clean up
    }
  }, [])

  function toggleNetworkSummary() {
    setNetworkSummaryOpen((prev) => {
      const next = !prev
      try {
        localStorage.setItem(NETWORK_SUMMARY_OPEN_KEY, String(next))
      } catch {
        // localStorage unavailable (private mode, etc.) -- toggle still works for this session
      }
      return next
    })
  }

  useEffect(() => {
    document.title = selectedRoadId
      ? `${selectedRoadId} · Road Inventory & Surface Diagram`
      : 'Road Inventory & Surface Diagram System'
  }, [selectedRoadId])

  useEffect(() => {
    refreshSegmentsPage(tablePage, tableFilters, tableSort)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tablePage, tableFilters, tableSort])

  // Global keyboard shortcuts -- disabled while typing in any field/dropdown
  // search, or while a modal is open (every modal in this app sets
  // document.body.style.overflow='hidden' while open, so that's a reliable
  // cross-cutting signal without threading an "any modal open" flag through
  // every component). Esc is handled individually by each modal already.
  useEffect(() => {
    function handleKeyDown(e) {
      const tag = e.target.tagName
      const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable
      const modalOpen = document.body.style.overflow === 'hidden'
      if (isTyping || modalOpen || e.metaKey || e.ctrlKey || e.altKey) return

      switch (e.key) {
        case '/':
          e.preventDefault()
          document.querySelector('.filter-field-road .custom-select-trigger')?.click()
          break
        case 'g':
        case 'G':
          handleGenerate()
          break
        case 'u':
        case 'U':
          uploadPanelRef.current?.openFilePicker()
          break
        case 'h':
        case 'H':
          uploadPanelRef.current?.openHistory()
          break
        case 'f':
        case 'F':
          diagramPanelRef.current?.openFullscreen()
          break
        case '?':
          openHowToUse()
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roadDetail, range])

  async function handleFilterChange(newFilters) {
    // The ROAD filter and "2. Select Road" are kept in sync both ways: if
    // this change came from the table's Road dropdown (or Clear filters),
    // drive the same selection logic Select Road uses so the road detail,
    // station range, and diagram state all stay consistent.
    if (newFilters.roadId !== tableFilters.roadId) {
      await handleSelectRoad(newFilters.roadId)
    }
    setTableFilters(newFilters)
    setTablePage(1)
  }

  // Three-state cycle per column: ascending -> descending -> back to the
  // default (unsorted, original upload order) rather than just toggling
  // forever between asc/desc.
  function handleSortChange(column) {
    setTableSort((prev) => {
      if (prev.sortBy !== column) return { sortBy: column, sortDir: 'asc' }
      if (prev.sortDir === 'asc') return { sortBy: column, sortDir: 'desc' }
      return { sortBy: null, sortDir: 'asc' }
    })
    setTablePage(1)
  }

  async function handleUploaded(uploadResult, fileName) {
    await refreshRoads()
    setTablePage(1)
    await refreshSegmentsPage(1, tableFilters, tableSort)
    await refreshSummary()
    // Saved in the same step as the upload completing, so metadata can never
    // drift out of sync with whether an upload actually happened.
    const meta = { fileName, uploadedAt: new Date().toISOString(), rejected: uploadResult.rejected }
    setUploadMeta(meta)
    writeUploadMeta(meta)

    // The road currently loaded in "2. Select Road" may have just had its
    // segments replaced -- refresh its detail so the station range/road name
    // reflect the new data, but leave the already-drawn diagram alone (it's
    // now stale) and tell the user to regenerate rather than silently
    // redrawing it out from under them.
    const wasReplaced = uploadResult.imported.some(
      (r) => r.action === 'replaced' && r.road_id === selectedRoadId
    )
    if (wasReplaced) {
      const detail = await fetchRoadDetail(selectedRoadId)
      setRoadDetail(detail)
      if (detail.segments.length) {
        const minM = detail.segments[0].start_m
        const maxM = detail.segments[detail.segments.length - 1].end_m
        setRange({ startRaw: formatStation(minM), endRaw: formatStation(maxM) })
      }
      showToast({
        variant: 'info',
        message: `${selectedRoadId} was updated. Regenerate the diagram to see changes.`,
      })
    }
  }

  async function handleSegmentEdited(roadId) {
    // The edit already changed the DB; refetch the current page/sort/filter
    // view so the row reflects the saved values, plus the network summary
    // since surface_type edits change the asphalted %.
    await refreshSegmentsPage(tablePage, tableFilters, tableSort)
    await refreshSummary()

    // If the edited road's diagram is the one currently on screen, refresh
    // its detail (so regenerating draws the new data) but don't silently
    // redraw an already-generated diagram out from under the user.
    if (roadId === selectedRoadId) {
      const detail = await fetchRoadDetail(roadId)
      setRoadDetail(detail)
      if (hasGenerated) {
        showToast({ variant: 'info', message: `${roadId} was updated. Regenerate the diagram to see changes.` })
      }
    }
  }

  async function handleRestored() {
    // A restore can replace or merge an arbitrary set of roads (including a
    // full wipe-and-replace) -- rather than trying to cleverly preserve
    // whatever was selected/filtered before, reset to a clean state and
    // reload everything from scratch, same approach as "all roads deleted".
    setSelectedRoadId('')
    setRoadDetail(null)
    setHasGenerated(false)
    setGeneratedRange(null)
    setRange({ startRaw: '', endRaw: '' })
    const clearedFilters = { roadId: '', status: '', surfaceType: '' }
    setTableFilters(clearedFilters)
    setTablePage(1)
    await refreshRoads()
    await refreshSegmentsPage(1, clearedFilters, tableSort)
    await refreshSummary()
  }

  async function handleSelectRoad(roadId) {
    setSelectedRoadId(roadId)
    setHasGenerated(false)
    setGeneratedRange(null)
    // Keep the table's ROAD filter in sync when the road is picked from
    // "2. Select Road" rather than from the table filter itself.
    setTableFilters((f) => (f.roadId === roadId ? f : { ...f, roadId }))
    setTablePage(1)
    if (!roadId) {
      setRoadDetail(null)
      setRange({ startRaw: '', endRaw: '' })
      return
    }
    const detail = await fetchRoadDetail(roadId)
    setRoadDetail(detail)
    if (detail.segments.length) {
      const minM = detail.segments[0].start_m
      const maxM = detail.segments[detail.segments.length - 1].end_m
      setRange({ startRaw: formatStation(minM), endRaw: formatStation(maxM) })
    } else {
      setRange({ startRaw: '', endRaw: '' })
    }
  }

  async function handleDeleteRoad(roadId) {
    await deleteRoad(roadId)

    // Fetch the fresh list directly (rather than relying on the `roads`
    // state, which won't reflect this delete until the next render) so the
    // filter-reset decisions below are based on what actually exists now.
    const freshRoads = await fetchRoadsList()
    setRoads(freshRoads)

    if (roadId === selectedRoadId) {
      setSelectedRoadId('')
      setRoadDetail(null)
      setHasGenerated(false)
      setGeneratedRange(null)
      setRange({ startRaw: '', endRaw: '' })
    }

    // Clear filters that no longer refer to anything real: all of them once
    // no roads remain at all, or just the ROAD filter if only the road it
    // was pointed at got deleted (other roads/filters are left alone).
    const filteredRoadStillExists = freshRoads.some((r) => r.road_id === tableFilters.roadId)
    const nextFilters =
      freshRoads.length === 0
        ? { roadId: '', status: '', surfaceType: '' }
        : filteredRoadStillExists
        ? tableFilters
        : { ...tableFilters, roadId: '' }
    setTableFilters(nextFilters)
    setTablePage(1)
    await refreshSegmentsPage(1, nextFilters, tableSort)
    await refreshSummary()
    if (freshRoads.length === 0) {
      setUploadMeta(null)
      writeUploadMeta(null)
    }
    showToast({ variant: 'success', message: `Road ${roadId} deleted` })
  }

  function handleGenerate() {
    if (!roadDetail) return
    const startM = parseStationInput(range.startRaw)
    const endM = parseStationInput(range.endRaw)
    if (startM === null || endM === null || startM >= endM) return
    setGeneratedRange({ startM, endM })
    setHasGenerated(true)
    setDiagramVersion((v) => v + 1)
  }

  const selectedRoadName = roadDetail?.road_name || ''

  return (
    <div className="app-shell">
      <Header
        summary={networkSummary}
        lastUploadAt={uploadMeta ? new Date(uploadMeta.uploadedAt) : null}
        networkSummaryOpen={networkSummaryOpen}
        onToggleNetworkSummary={toggleNetworkSummary}
      />
      <div className="main-layout">
        <aside className={`sidebar${sidebarCollapsed ? ' collapsed' : ''}`}>
          <button
            className="sidebar-toggle no-print"
            onClick={() => setSidebarCollapsed((c) => !c)}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              {sidebarCollapsed ? (
                <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              ) : (
                <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              )}
            </svg>
          </button>
          <UploadPanel
            ref={uploadPanelRef}
            onUploaded={handleUploaded}
            onRestored={handleRestored}
            roads={roads}
            uploadMeta={uploadMeta}
            collapsed={sidebarCollapsed}
            onExpand={() => setSidebarCollapsed(false)}
          />
          <RoadSelectPanel
            roads={roads}
            selectedRoadId={selectedRoadId}
            onSelect={handleSelectRoad}
            roadName={selectedRoadName}
            onDelete={handleDeleteRoad}
            collapsed={sidebarCollapsed}
            onExpand={() => setSidebarCollapsed(false)}
          />
          <DiagramSettingsPanel
            road={roadDetail}
            range={range}
            onRangeChange={setRange}
            settings={settings}
            onChange={setSettings}
            onGenerate={handleGenerate}
            canGenerate={!!roadDetail}
            onExpand={() => setSidebarCollapsed(false)}
            collapsed={sidebarCollapsed}
          />
        </aside>
        <main className="content">
          <NetworkSummaryBar
            summary={networkSummary}
            open={networkSummaryOpen}
            onClose={() => networkSummaryOpen && toggleNetworkSummary()}
            onSelectRoad={handleSelectRoad}
          />
          <RoadInventoryTable
            segmentsPage={segmentsPage}
            onPageChange={setTablePage}
            roads={roads}
            filters={tableFilters}
            onFilterChange={handleFilterChange}
            sort={tableSort}
            onSortChange={handleSortChange}
            onSegmentEdited={handleSegmentEdited}
          />
          <DiagramPanel
            ref={diagramPanelRef}
            road={roadDetail ? { roadDetail, settings, range: generatedRange } : null}
            diagramVersion={diagramVersion}
            hasGenerated={hasGenerated}
            hasRoads={roads.length > 0}
          />
        </main>
      </div>
    </div>
  )
}
