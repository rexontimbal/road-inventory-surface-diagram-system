import { useEffect, useMemo, useRef, useState } from 'react'
import Header, { openHowToUse } from './components/Header'
import GuestNotice from './components/GuestNotice'
import WorkspaceBanner from './components/WorkspaceBanner'
import ShareModal from './components/auth/ShareModal'
import UploadPanel from './components/sidebar/UploadPanel'
import SectionSelectPanel from './components/sidebar/SectionSelectPanel'
import DiagramSettingsPanel from './components/sidebar/DiagramSettingsPanel'
import RoadInventoryTable from './components/inventory/RoadInventoryTable'
import NetworkBreakdownModal from './components/inventory/NetworkBreakdownModal'
import DiagramPanel from './components/diagram/DiagramPanel'
import {
  deleteRoad,
  fetchLaneCounts,
  fetchNetworkSummary,
  fetchRoadDetail,
  fetchRoadsList,
  fetchSegmentsPage,
} from './api/roads'
import { parseDpwhStation } from './utils/chainage'
import { readUploadMeta, writeUploadMeta } from './utils/uploadMeta'
import { fetchMe, signInWithGoogle, signOut } from './api/auth'
import { fetchGuestStatus } from './api/guest'
import { fetchWorkspaceContext, switchWorkspace, fetchNotifications, markNotificationsSeen } from './api/workspace'
import { readActiveWorkspaceOwnerId, writeActiveWorkspaceOwnerId } from './utils/activeWorkspace'
import { showToast } from './components/common/DialogProvider'
import './App.css'

const PAGE_SIZE = 10

const EMPTY_TABLE_FILTERS = {
  sectionId: '',
  district: '',
  classification: '',
  status: '',
  surfaceType: '',
  numLanes: '',
}

// Groups the flat /api/roads list into one entry per District (DEO), each
// carrying its distinct LD value(s) and how many sections fall under it --
// drives both "2. Select Section"'s District dropdown and the inventory
// table's District filter, so the two never disagree on what a "district" is.
function buildDistricts(roads) {
  const map = new Map()
  for (const r of roads) {
    const key = r.deo || '(No District)'
    if (!map.has(key)) map.set(key, { deo: key, lds: new Set(), count: 0 })
    const entry = map.get(key)
    if (r.ld) entry.lds.add(r.ld)
    entry.count += 1
  }
  return [...map.values()]
    .map((e) => ({ deo: e.deo, ld: [...e.lds].join(', '), count: e.count }))
    .sort((a, b) => a.deo.localeCompare(b.deo))
}

function buildClassifications(roads) {
  const set = new Set(roads.map((r) => r.classification).filter(Boolean))
  return [...set].sort((a, b) => a.localeCompare(b))
}

export default function App() {
  const [roads, setRoads] = useState([])
  const [selectedDistrict, setSelectedDistrict] = useState('')
  const [selectedSectionId, setSelectedSectionId] = useState('')
  const [roadDetail, setRoadDetail] = useState(null)
  const [segmentsPage, setSegmentsPage] = useState(null)
  const [tablePage, setTablePage] = useState(1)
  const [tableFilters, setTableFilters] = useState(EMPTY_TABLE_FILTERS)
  const [tableSort, setTableSort] = useState({ sortBy: null, sortDir: 'asc' })
  const [networkSummary, setNetworkSummary] = useState(null)
  const [laneCounts, setLaneCounts] = useState([])
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
  const [networkBreakdownOpen, setNetworkBreakdownOpen] = useState(false)
  // authChecked gates the header's auth UI so it doesn't flash "signed out"
  // before the /api/auth/me check resolves.
  const [authUser, setAuthUser] = useState(null)
  const [authChecked, setAuthChecked] = useState(false)
  // Which workspace is active -- own data, or (if shared with this account)
  // someone else's -- per /api/workspace/context. null while signed out or
  // not yet loaded; the header/switcher/banner all treat that as "own".
  const [workspaceContext, setWorkspaceContext] = useState(null)
  const [shareModalOpen, setShareModalOpen] = useState(false)
  // Share notifications (badge count + dropdown New/role-changed pills),
  // per /api/workspace/notifications -- pulseKey increments only when
  // new_count goes UP, so the badge's one-shot pulse (see UserMenu) replays
  // exactly on a genuinely new unseen share, not on every poll tick.
  const [notifications, setNotifications] = useState({ new_count: 0, items: [], pulseKey: 0 })
  const prevNewCountRef = useRef(0)
  // Share ids already toasted this session, keyed by `${share_id}:${last_change}`
  // so a later role change (a DIFFERENT "new" event on the same share) still
  // gets its own toast, without re-toasting the same unseen share every poll.
  const notifiedKeysRef = useRef(new Set())
  const uploadPanelRef = useRef(null)
  const diagramPanelRef = useRef(null)
  const headerRef = useRef(null)

  async function refreshWorkspaceContext() {
    const context = await fetchWorkspaceContext().catch(() => null)
    setWorkspaceContext(context)
    writeActiveWorkspaceOwnerId(context?.mode === 'shared' ? context.owner_user_id : null)
    if (context?.access_removed_owner_name) {
      showToast({
        variant: 'info',
        message: `Your access to ${context.access_removed_owner_name}'s data was removed.`,
      })
      await refreshAfterScopeChange()
    }
    return context
  }

  async function refreshNotifications({ toastNew = false } = {}) {
    const data = await fetchNotifications().catch(() => null)
    if (!data) return null
    if (toastNew) {
      for (const item of data.items) {
        if (!item.is_new) continue
        const key = `${item.share_id}:${item.last_change}`
        if (notifiedKeysRef.current.has(key)) continue
        notifiedKeysRef.current.add(key)
        const roleLabel = item.role === 'editor' ? 'Editor' : 'Viewer'
        const isRoleChange = item.last_change === 'role_changed'
        const message = isRoleChange
          ? `${item.owner_name} changed your access · ${roleLabel}`
          : `${item.owner_name} shared their data with you · ${roleLabel}`
        showToast({
          variant: 'info',
          title: isRoleChange ? 'Role updated' : 'Shared with you',
          message,
          avatarUrl: item.owner_avatar_url,
          duration: 8000,
          actionLabel: 'Open',
          onAction: () => handleSwitchWorkspace(item.owner_user_id),
        })
      }
    }
    const pulse = data.new_count > prevNewCountRef.current
    prevNewCountRef.current = data.new_count
    setNotifications((prev) => ({ ...data, pulseKey: pulse ? prev.pulseKey + 1 : prev.pulseKey }))
    return data
  }

  // Avatar dropdown opening is what marks everything seen server-side (via
  // switchWorkspace for a single workspace, or this for "closed the whole
  // dropdown") -- called on close, not open, since the "New" pill must stay
  // visible for the whole time the dropdown is open (see UserMenu's
  // openSnapshotRef).
  async function handleDropdownClose() {
    await markNotificationsSeen(null).catch(() => {})
    await refreshNotifications()
  }

  useEffect(() => {
    fetchMe()
      .then(async (res) => {
        setAuthUser(res.user)
        if (!res.user) return
        // The active_workspace cookie (if any) already survives a reload on
        // its own -- this localStorage value only matters as a courtesy
        // re-confirmation, converting "assume the cookie is still valid"
        // into "ask the backend to confirm it, and fall back to My data if
        // that access was removed while this browser was closed."
        const savedOwnerId = readActiveWorkspaceOwnerId()
        if (savedOwnerId != null) {
          await switchWorkspace(savedOwnerId).catch(() => writeActiveWorkspaceOwnerId(null))
        }
        await refreshWorkspaceContext()
        await refreshNotifications({ toastNew: true })
      })
      .catch(() => setAuthUser(null))
      .finally(() => setAuthChecked(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Live updates (Part 6): poll while the tab is visible, pause while
  // hidden -- a background tab doesn't need a badge that's accurate to the
  // second, and skipping the fetch there avoids surprising the user with a
  // toast for a share they never actually looked away from. Catches back up
  // immediately on regaining visibility rather than waiting out the rest of
  // whatever the last 60s interval had left.
  useEffect(() => {
    if (!authUser) return
    function tick() {
      if (document.hidden) return
      refreshNotifications({ toastNew: true })
      refreshWorkspaceContext()
    }
    const interval = setInterval(tick, 60000)
    function handleVisibility() {
      if (!document.hidden) tick()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser])

  // Signing in/out switches which workspace's data the backend returns for
  // every read -- the road list, table, diagram selection, and network
  // summary already on screen are for the OLD scope and must be dropped,
  // not just left stale underneath the new state.
  async function refreshAfterScopeChange() {
    setSelectedDistrict('')
    setSelectedSectionId('')
    setRoadDetail(null)
    setGeneratedRange(null)
    setHasGenerated(false)
    setTablePage(1)
    // "Last upload: <file>, <time>" is browser-local (localStorage), not
    // tied to any account -- without clearing it here, switching accounts
    // (or signing out) in the same browser would keep showing the PREVIOUS
    // workspace's last-uploaded file next to the new, unrelated workspace.
    setUploadMeta(null)
    writeUploadMeta(null)
    await Promise.all([
      refreshRoads(),
      refreshSegmentsPage(1, tableFilters, tableSort),
      refreshSummary(),
      refreshLaneCounts(),
    ])
  }

  // Deliberately rethrows on failure instead of catching -- SignInModal is
  // the caller for this (its Google button lives inside the modal), and it
  // needs the rejection itself to show its own inline "account not allowed"
  // message rather than a toast the user might not even see behind the
  // still-open modal.
  async function handleGoogleCredential(idToken) {
    const res = await signInWithGoogle(idToken)
    setAuthUser(res.user)
    showToast({ variant: 'success', message: `Signed in as ${res.user.name}` })
    // Guest data is never moved into an account -- it just stays in the
    // guest sandbox and expires on its own TTL (GuestNotice already shows
    // the countdown). This toast is the only acknowledgment that it existed
    // and wasn't carried over, in case the user expected otherwise.
    const guestStatus = await fetchGuestStatus().catch(() => null)
    if (guestStatus?.has_data) {
      showToast({
        variant: 'info',
        message: "Your guest data wasn't moved. Use Backup data before signing in to keep it.",
      })
    }
    // A fresh sign-in via the button (as opposed to the on-mount restore
    // above) never carries over a previous account's workspace choice --
    // whatever active_workspace cookie happens to exist is this account's
    // own history, fetched fresh rather than assumed.
    await refreshWorkspaceContext()
    await refreshAfterScopeChange()
    await refreshNotifications({ toastNew: true })
  }

  function handleOpenHistoryFromHeader() {
    uploadPanelRef.current?.openHistory()
  }

  async function handleSignOut() {
    try {
      await signOut()
      setAuthUser(null)
      setWorkspaceContext(null)
      setNotifications({ new_count: 0, items: [], pulseKey: 0 })
      prevNewCountRef.current = 0
      notifiedKeysRef.current = new Set()
      // Tied to the account that just signed out -- carrying it over to
      // whichever account signs in next in this same browser would put
      // them straight into a workspace that was never shared with THEM.
      writeActiveWorkspaceOwnerId(null)
      showToast({ variant: 'info', message: 'Signed out' })
      await refreshAfterScopeChange()
    } catch (err) {
      showToast({ variant: 'danger', message: `Sign-out failed: ${err.message}` })
    }
  }

  async function handleSwitchWorkspace(ownerUserId) {
    try {
      await switchWorkspace(ownerUserId)
      const context = await refreshWorkspaceContext()
      await refreshAfterScopeChange()
      // Switching into a shared workspace already marked that one share
      // seen server-side -- resync the local badge/pill state to match
      // instead of waiting for the next 60s poll.
      await refreshNotifications()
      showToast({
        variant: 'info',
        message: context?.mode === 'shared' ? `Viewing ${context.owner_name}'s data` : 'Viewing your own data',
      })
    } catch (err) {
      showToast({ variant: 'danger', message: `Could not switch workspace: ${err.message}` })
    }
  }

  async function refreshRoads() {
    const list = await fetchRoadsList()
    setRoads(list)
  }

  async function refreshLaneCounts() {
    const data = await fetchLaneCounts()
    setLaneCounts(data.lanes)
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
    refreshLaneCounts()
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


  useEffect(() => {
    document.title = selectedSectionId
      ? `${selectedSectionId} · Road Inventory & Surface Diagram`
      : 'Road Inventory & Surface Diagram System'
  }, [selectedSectionId])

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
          document.querySelector('.filter-field-section .custom-select-trigger')?.click()
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
    // The SECTION filter and "2. Select Section" are kept in sync both ways:
    // if this change came from the table's Section dropdown (or Clear
    // filters), drive the same selection logic Select Section uses so the
    // road detail, station range, and diagram state all stay consistent.
    if (newFilters.sectionId !== tableFilters.sectionId) {
      await handleSelectSection(newFilters.sectionId)
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
    await refreshLaneCounts()
    // Saved in the same step as the upload completing, so metadata can never
    // drift out of sync with whether an upload actually happened.
    const meta = { fileName, uploadedAt: new Date().toISOString(), rejected: uploadResult.rejected }
    setUploadMeta(meta)
    writeUploadMeta(meta)

    // The section currently loaded in "2. Select Section" may have just had
    // its segments replaced -- refresh its detail so the station range/road
    // name reflect the new data, but leave the already-drawn diagram alone
    // (it's now stale) and tell the user to regenerate rather than silently
    // redrawing it out from under them.
    const wasReplaced = uploadResult.imported.some(
      (r) => r.action === 'replaced' && r.section_id === selectedSectionId
    )
    if (wasReplaced) {
      const detail = await fetchRoadDetail(selectedSectionId)
      setRoadDetail(detail)
      if (detail.segments.length) {
        const first = detail.segments[0]
        const last = detail.segments[detail.segments.length - 1]
        setRange({ startRaw: first.start_station, endRaw: last.end_station })
      }
      showToast({
        variant: 'info',
        message: `${selectedSectionId} was updated. Regenerate the diagram to see changes.`,
      })
    }
  }

  async function handleSegmentEdited(sectionId) {
    // The edit already changed the DB; refetch the current page/sort/filter
    // view so the row reflects the saved values, plus the network summary
    // since surface_type edits change the asphalted %.
    await refreshSegmentsPage(tablePage, tableFilters, tableSort)
    await refreshSummary()

    // If the edited section's diagram is the one currently on screen, refresh
    // its detail (so regenerating draws the new data) but don't silently
    // redraw an already-generated diagram out from under the user.
    if (sectionId === selectedSectionId) {
      const detail = await fetchRoadDetail(sectionId)
      setRoadDetail(detail)
      if (hasGenerated) {
        showToast({ variant: 'info', message: `${sectionId} was updated. Regenerate the diagram to see changes.` })
      }
    }
  }

  async function handleRestored() {
    // A restore can replace or merge an arbitrary set of roads (including a
    // full wipe-and-replace) -- rather than trying to cleverly preserve
    // whatever was selected/filtered before, reset to a clean state and
    // reload everything from scratch, same approach as "all roads deleted".
    setSelectedDistrict('')
    setSelectedSectionId('')
    setRoadDetail(null)
    setHasGenerated(false)
    setGeneratedRange(null)
    setRange({ startRaw: '', endRaw: '' })
    setTableFilters(EMPTY_TABLE_FILTERS)
    setTablePage(1)
    await refreshRoads()
    await refreshSegmentsPage(1, EMPTY_TABLE_FILTERS, tableSort)
    await refreshSummary()
    await refreshLaneCounts()
  }

  // Selecting a section from ANY entry point (the "2. Select Section" Section
  // ID dropdown, the table's Section filter, or a network-summary chip) goes
  // through this one function -- it derives the section's District from the
  // `roads` list so all three stay consistent without each caller having to
  // know/pass it separately.
  async function handleSelectSection(sectionId) {
    const road = sectionId ? roads.find((r) => r.section_id === sectionId) : null
    setSelectedSectionId(sectionId)
    if (road) setSelectedDistrict(road.deo || '')
    setHasGenerated(false)
    setGeneratedRange(null)
    // Keep the table's SECTION filter in sync when the section is picked from
    // "2. Select Section" rather than from the table filter itself.
    setTableFilters((f) => (f.sectionId === sectionId ? f : { ...f, sectionId }))
    setTablePage(1)
    if (!sectionId) {
      setRoadDetail(null)
      setRange({ startRaw: '', endRaw: '' })
      return
    }
    const detail = await fetchRoadDetail(sectionId)
    setRoadDetail(detail)
    if (detail.segments.length) {
      const first = detail.segments[0]
      const last = detail.segments[detail.segments.length - 1]
      setRange({ startRaw: first.start_station, endRaw: last.end_station })
    } else {
      setRange({ startRaw: '', endRaw: '' })
    }
  }

  // Changing the District dropdown invalidates a selected Section from a
  // different (or no) district -- "2. Select Section"'s Section ID dropdown
  // only ever lists the current district's sections, so a stale selection
  // from before the change must be cleared, not silently kept.
  function handleSelectDistrict(deo) {
    setSelectedDistrict(deo)
    const current = selectedSectionId ? roads.find((r) => r.section_id === selectedSectionId) : null
    if (selectedSectionId && (!current || (current.deo || '') !== deo)) {
      handleSelectSection('')
    }
  }

  async function handleDeleteRoad(sectionId) {
    await deleteRoad(sectionId)

    // Fetch the fresh list directly (rather than relying on the `roads`
    // state, which won't reflect this delete until the next render) so the
    // filter-reset decisions below are based on what actually exists now.
    const freshRoads = await fetchRoadsList()
    setRoads(freshRoads)

    if (sectionId === selectedSectionId) {
      setSelectedSectionId('')
      setRoadDetail(null)
      setHasGenerated(false)
      setGeneratedRange(null)
      setRange({ startRaw: '', endRaw: '' })
    }

    // Clear filters that no longer refer to anything real: all of them once
    // no roads remain at all, or just the SECTION filter if only the section
    // it was pointed at got deleted (other filters are left alone).
    const filteredSectionStillExists = freshRoads.some((r) => r.section_id === tableFilters.sectionId)
    const nextFilters =
      freshRoads.length === 0
        ? EMPTY_TABLE_FILTERS
        : filteredSectionStillExists
        ? tableFilters
        : { ...tableFilters, sectionId: '' }
    setTableFilters(nextFilters)
    setTablePage(1)
    await refreshSegmentsPage(1, nextFilters, tableSort)
    await refreshSummary()
    await refreshLaneCounts()
    if (freshRoads.length === 0) {
      setUploadMeta(null)
      writeUploadMeta(null)
    }
    showToast({ variant: 'success', message: `Section ${sectionId} deleted` })
  }

  function handleGenerate() {
    if (!roadDetail) return
    const startM = parseDpwhStation(range.startRaw)
    const endM = parseDpwhStation(range.endRaw)
    if (startM === null || endM === null || startM >= endM) return
    // startText/endText carry the literal typed-or-defaulted text through to
    // the diagram -- range labels (progress bar, print header, fullscreen
    // chip, export filename) show this verbatim rather than re-deriving a
    // km post from startM/endM, which would silently drop a negative
    // offset's reference point (see formatStationRange's doc comment).
    setGeneratedRange({ startM, endM, startText: range.startRaw.trim(), endText: range.endRaw.trim() })
    setHasGenerated(true)
    setDiagramVersion((v) => v + 1)
  }

  const selectedRoadName = roadDetail?.road_name || ''
  const districts = useMemo(() => buildDistricts(roads), [roads])
  const classifications = useMemo(() => buildClassifications(roads), [roads])
  const sectionsInSelectedDistrict = useMemo(
    () => (selectedDistrict ? roads.filter((r) => (r.deo || '') === selectedDistrict) : []),
    [roads, selectedDistrict]
  )
  // Pure UI affordance (disable/hide + a "View-only access" tooltip) -- the
  // real enforcement is server-side (require_editor/require_owner on every
  // write route), so defaulting to true before context loads or for a
  // guest is safe either way.
  const canEdit = !workspaceContext || workspaceContext.mode === 'own' || workspaceContext.role === 'editor'

  return (
    <div className="app-shell">
      <Header
        ref={headerRef}
        summary={networkSummary}
        onOpenNetworkBreakdown={() => setNetworkBreakdownOpen(true)}
        authUser={authUser}
        authChecked={authChecked}
        onGoogleCredential={handleGoogleCredential}
        onSignOut={handleSignOut}
        onOpenHistory={handleOpenHistoryFromHeader}
        workspaceContext={workspaceContext}
        onSwitchWorkspace={handleSwitchWorkspace}
        onOpenShare={() => setShareModalOpen(true)}
        notifications={notifications}
        onDropdownClose={handleDropdownClose}
      />
      <GuestNotice
        isGuest={authChecked && !authUser}
        onSignInClick={() => headerRef.current?.openSignIn()}
      />
      <WorkspaceBanner context={workspaceContext} onBackToMine={() => handleSwitchWorkspace(null)} />
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
            canEdit={canEdit}
          />
          <SectionSelectPanel
            districts={districts}
            sections={sectionsInSelectedDistrict}
            selectedDistrict={selectedDistrict}
            onSelectDistrict={handleSelectDistrict}
            selectedSectionId={selectedSectionId}
            onSelectSection={handleSelectSection}
            roadName={selectedRoadName}
            classification={roadDetail?.classification || ''}
            deo={roadDetail?.deo || ''}
            ld={roadDetail?.ld || ''}
            onDelete={handleDeleteRoad}
            collapsed={sidebarCollapsed}
            onExpand={() => setSidebarCollapsed(false)}
            canEdit={canEdit}
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
          <RoadInventoryTable
            segmentsPage={segmentsPage}
            onPageChange={setTablePage}
            roads={roads}
            districts={districts}
            classifications={classifications}
            laneCounts={laneCounts}
            networkSummary={networkSummary}
            filters={tableFilters}
            onFilterChange={handleFilterChange}
            sort={tableSort}
            onSortChange={handleSortChange}
            onSegmentEdited={handleSegmentEdited}
            canEdit={canEdit}
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
      {networkBreakdownOpen && (
        <NetworkBreakdownModal
          summary={networkSummary}
          roads={roads}
          onClose={() => setNetworkBreakdownOpen(false)}
          onSelectSection={(sectionId) => {
            setNetworkBreakdownOpen(false)
            handleSelectSection(sectionId)
          }}
        />
      )}
      {shareModalOpen && (
        <ShareModal
          ownerName={authUser?.name}
          ownerEmail={authUser?.email}
          onClose={() => setShareModalOpen(false)}
        />
      )}
    </div>
  )
}
