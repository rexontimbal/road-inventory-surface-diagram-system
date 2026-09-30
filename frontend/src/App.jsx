import { useEffect, useState } from 'react'
import Header from './components/Header'
import UploadPanel from './components/sidebar/UploadPanel'
import RoadSelectPanel from './components/sidebar/RoadSelectPanel'
import DiagramSettingsPanel from './components/sidebar/DiagramSettingsPanel'
import RoadInventoryTable from './components/inventory/RoadInventoryTable'
import DiagramPanel from './components/diagram/DiagramPanel'
import { fetchRoadDetail, fetchRoadsList, fetchSegmentsPage } from './api/roads'
import './App.css'

const PAGE_SIZE = 10

export default function App() {
  const [roads, setRoads] = useState([])
  const [selectedRoadId, setSelectedRoadId] = useState('')
  const [roadDetail, setRoadDetail] = useState(null)
  const [segmentsPage, setSegmentsPage] = useState(null)
  const [tablePage, setTablePage] = useState(1)
  const [settings, setSettings] = useState({ stationIntervalM: 1000, stationsPerLine: 10 })
  const [diagramVersion, setDiagramVersion] = useState(0)
  const [hasGenerated, setHasGenerated] = useState(false)

  async function refreshRoads() {
    const list = await fetchRoadsList()
    setRoads(list)
  }

  async function refreshSegmentsPage(page) {
    const data = await fetchSegmentsPage(page, PAGE_SIZE)
    setSegmentsPage(data)
  }

  useEffect(() => {
    refreshRoads()
    refreshSegmentsPage(1)
  }, [])

  useEffect(() => {
    refreshSegmentsPage(tablePage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tablePage])

  async function handleUploaded() {
    await refreshRoads()
    setTablePage(1)
    await refreshSegmentsPage(1)
  }

  async function handleSelectRoad(roadId) {
    setSelectedRoadId(roadId)
    setHasGenerated(false)
    if (!roadId) {
      setRoadDetail(null)
      return
    }
    const detail = await fetchRoadDetail(roadId)
    setRoadDetail(detail)
  }

  function handleGenerate() {
    if (!roadDetail) return
    setHasGenerated(true)
    setDiagramVersion((v) => v + 1)
  }

  const selectedRoadName = roadDetail?.road_name || ''

  return (
    <div className="app-shell">
      <Header />
      <div className="main-layout">
        <aside className="sidebar">
          <UploadPanel onUploaded={handleUploaded} />
          <RoadSelectPanel
            roads={roads}
            selectedRoadId={selectedRoadId}
            onSelect={handleSelectRoad}
            roadName={selectedRoadName}
          />
          <DiagramSettingsPanel
            settings={settings}
            onChange={setSettings}
            onGenerate={handleGenerate}
            canGenerate={!!roadDetail}
          />
        </aside>
        <main className="content">
          <RoadInventoryTable segmentsPage={segmentsPage} onPageChange={setTablePage} />
          <DiagramPanel
            road={roadDetail ? { roadDetail, settings } : null}
            diagramVersion={diagramVersion}
            hasGenerated={hasGenerated}
          />
        </main>
      </div>
    </div>
  )
}
