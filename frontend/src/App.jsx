import { useEffect, useState } from 'react'
import Header from './components/Header'
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
  const [lastUploadAt, setLastUploadAt] = useState(null)
  const [networkSummaryOpen, setNetworkSummaryOpen] = useState(readStoredNetworkSummaryOpen)

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

  function handleSortChange(column) {
    setTableSort((prev) => {
      if (prev.sortBy === column) {
        return { sortBy: column, sortDir: prev.sortDir === 'asc' ? 'desc' : 'asc' }
      }
      return { sortBy: column, sortDir: 'asc' }
    })
    setTablePage(1)
  }

  async function handleUploaded() {
    await refreshRoads()
    setTablePage(1)
    await refreshSegmentsPage(1, tableFilters, tableSort)
    await refreshSummary()
    setLastUploadAt(new Date())
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
    if (roadId === selectedRoadId) {
      setSelectedRoadId('')
      setRoadDetail(null)
      setHasGenerated(false)
    }
    await refreshRoads()
    setTablePage(1)
    await refreshSegmentsPage(1, tableFilters, tableSort)
    await refreshSummary()
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
        lastUploadAt={lastUploadAt}
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
            onUploaded={handleUploaded}
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
          />
          <DiagramPanel
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
