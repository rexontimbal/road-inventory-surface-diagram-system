import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import CustomSelect from '../common/CustomSelect'
import ProgressBar from '../common/ProgressBar'
import { useModalLayer } from '../common/useModalLayer'
import { getFullscreenPortalRoot } from '../../utils/fullscreenPortal'

const SORT_OPTIONS = [
  { value: 'pct_asc', label: '% asphalted (low → high)' },
  { value: 'pct_desc', label: '% asphalted (high → low)' },
  { value: 'length_desc', label: 'Length (longest first)' },
  { value: 'section_id', label: 'Section ID' },
]

function pctTier(pct) {
  if (pct >= 100) return 'complete'
  if (pct >= 50) return 'mid'
  return 'low'
}

function sortSections(sections, sortBy) {
  const arr = [...sections]
  if (sortBy === 'pct_desc') return arr.sort((a, b) => b.pct - a.pct)
  if (sortBy === 'length_desc') return arr.sort((a, b) => b.total_length_m - a.total_length_m)
  if (sortBy === 'section_id') return arr.sort((a, b) => a.section_id.localeCompare(b.section_id))
  return arr.sort((a, b) => a.pct - b.pct) // pct_asc, the default
}

/**
 * Network Breakdown modal, opened from the header's "% asphalted" chip.
 * Replaces the old inline NetworkSummaryBar card -- with 131 real sections
 * across 9 Districts, the inline card's nested scrollbars and chips hidden
 * behind the progress bar made it unusable; this is one modal with one
 * scroll area and a District accordion.
 */
export default function NetworkBreakdownModal({ summary, roads, onClose, onSelectSection }) {
  const [search, setSearch] = useState('')
  const [district, setDistrict] = useState('')
  const [sortBy, setSortBy] = useState('pct_asc')
  const [expandedKeys, setExpandedKeys] = useState(null) // null = not yet initialized
  const cardRef = useRef(null)
  const firstFocusableRef = useRef(null)
  const { zIndex, isTop } = useModalLayer()

  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    firstFocusableRef.current?.focus()

    function handleKeyDown(e) {
      if (!isTop()) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key === 'Tab') {
        const focusable = cardRef.current?.querySelectorAll(
          'button, a[href], input, [tabindex]:not([tabindex="-1"])'
        )
        if (!focusable || focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = prevOverflow
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Merges the per-section asphalt stats (/api/roads/summary, which doesn't
  // carry district/LD/classification) with the full section list
  // (/api/roads, which does) -- cheaper than duplicating the %/km math here.
  const mergedSections = useMemo(() => {
    if (!summary) return []
    const statsBySection = new Map(summary.roads.map((r) => [r.section_id, r]))
    return roads
      .map((r) => {
        const stats = statsBySection.get(r.section_id)
        return stats ? { ...r, ...stats } : null
      })
      .filter(Boolean)
  }, [summary, roads])

  const districtOptions = useMemo(() => {
    const seen = new Set(mergedSections.map((s) => s.deo || '(No District)'))
    return [
      { value: '', label: 'All Districts' },
      ...[...seen].sort((a, b) => a.localeCompare(b)).map((deo) => ({ value: deo, label: deo })),
    ]
  }, [mergedSections])

  const searchLower = search.trim().toLowerCase()
  const filteredSections = useMemo(
    () =>
      mergedSections.filter((s) => {
        if (district && (s.deo || '(No District)') !== district) return false
        if (searchLower) {
          const haystack = `${s.section_id} ${s.road_name}`.toLowerCase()
          if (!haystack.includes(searchLower)) return false
        }
        return true
      }),
    [mergedSections, district, searchLower]
  )

  const groups = useMemo(() => {
    const map = new Map()
    for (const s of filteredSections) {
      const key = s.deo || '(No District)'
      if (!map.has(key)) map.set(key, { deo: key, ld: s.ld, total: 0, asphalt: 0, sections: [] })
      const g = map.get(key)
      g.total += s.total_length_m
      g.asphalt += s.asphalt_length_m
      g.sections.push(s)
    }
    const list = [...map.values()].map((g) => ({
      ...g,
      pct: g.total > 0 ? Math.round((g.asphalt / g.total) * 100) : 0,
      sections: sortSections(g.sections, sortBy),
    }))
    if (sortBy === 'pct_desc') list.sort((a, b) => b.pct - a.pct)
    else if (sortBy === 'length_desc') list.sort((a, b) => b.total - a.total)
    else if (sortBy === 'section_id') list.sort((a, b) => a.deo.localeCompare(b.deo))
    else list.sort((a, b) => a.pct - b.pct) // pct_asc, the default
    return list
  }, [filteredSections, sortBy])

  // Collapsed by default except the first group -- initialized once groups
  // are first known, not re-derived on every filter change, so a user's
  // manual expand/collapse choices survive typing in search.
  useEffect(() => {
    if (expandedKeys === null && groups.length > 0) {
      setExpandedKeys(new Set([groups[0].deo]))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups])

  // While actively searching, every matching group auto-expands -- otherwise
  // a hit could sit inside a collapsed group with no visible sign it's
  // there, which defeats the point of searching. Clearing the search
  // reverts to whatever expand/collapse state the user had before.
  const isSearching = searchLower.length > 0
  const expanded = isSearching ? new Set(groups.map((g) => g.deo)) : expandedKeys || new Set()
  const allExpanded = groups.length > 0 && groups.every((g) => expanded.has(g.deo))

  function toggleGroup(deo) {
    setExpandedKeys((prev) => {
      const next = new Set(prev || [])
      if (next.has(deo)) next.delete(deo)
      else next.add(deo)
      return next
    })
  }

  function expandAll() {
    setExpandedKeys(new Set(groups.map((g) => g.deo)))
  }
  function collapseAll() {
    setExpandedKeys(new Set())
  }

  if (!summary) return null
  if (zIndex == null) return null

  const totalSections = summary.roads.length
  const totalKm = (summary.total_length_m / 1000).toFixed(1)
  const asphaltKm = (summary.asphalt_length_m / 1000).toFixed(1)

  return createPortal(
    <div
      className="modal-backdrop no-print"
      style={{ zIndex }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="modal-card network-modal-card"
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="network-modal-title"
      >
        <div className="modal-header">
          <div className="modal-icon modal-icon-info" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M4 19h16M7 19V9m5 10V5m5 14v-7"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h3 id="network-modal-title" className="modal-title">
            Network Breakdown
          </h3>
          <button
            type="button"
            ref={firstFocusableRef}
            className="history-modal-close"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            ×
          </button>
        </div>
        <p className="network-modal-subtitle">
          {summary.pct}% asphalted · {asphaltKm} km of {totalKm} km · {totalSections} section
          {totalSections !== 1 ? 's' : ''}
        </p>
        <ProgressBar pct={summary.pct} height={8} className="network-modal-progress" />

        <div className="network-modal-toolbar">
          <div className="history-search-wrap">
            <svg className="history-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
              <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <input
              type="text"
              className="history-search"
              placeholder="Search Section ID or road name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <CustomSelect
            size="sm"
            value={district}
            onChange={setDistrict}
            options={districtOptions}
            ariaLabel="Filter by district"
            triggerClassName="network-district-select"
            searchable
            searchPlaceholder="Search district…"
          />
          <CustomSelect
            size="sm"
            value={sortBy}
            onChange={setSortBy}
            options={SORT_OPTIONS}
            ariaLabel="Sort"
            triggerClassName="network-sort-select"
          />
          {groups.length > 0 && (
            <button type="button" className="network-expand-all" onClick={allExpanded ? collapseAll : expandAll}>
              {allExpanded ? 'Collapse all' : 'Expand all'}
            </button>
          )}
        </div>

        <div className="network-modal-body thin-scroll">
          {groups.length === 0 && <div className="network-empty">No sections match your search.</div>}
          {groups.map((g) => {
            const isOpen = expanded.has(g.deo)
            return (
              <div className="network-group" key={g.deo}>
                <button
                  type="button"
                  className="network-group-header"
                  onClick={() => toggleGroup(g.deo)}
                  aria-expanded={isOpen}
                >
                  <div className="network-group-head-text">
                    <div className="network-group-name">{g.deo}</div>
                    {g.ld && <div className="network-group-ld">{g.ld}</div>}
                  </div>
                  <div className="network-group-stats">
                    <span className="network-group-stats-text">
                      {g.pct}% · {(g.total / 1000).toFixed(1)} km · {g.sections.length} section
                      {g.sections.length !== 1 ? 's' : ''}
                    </span>
                    <ProgressBar pct={g.pct} height={6} tiered className="network-group-bar" />
                  </div>
                  <svg
                    className={`network-group-chevron${isOpen ? ' network-group-chevron-open' : ''}`}
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                {isOpen && (
                  <div className="network-group-body">
                    {g.sections.map((s) => (
                      <button
                        type="button"
                        key={s.section_id}
                        className={`network-chip network-chip-${pctTier(s.pct)}`}
                        title={`${s.road_name} — ${(s.total_length_m / 1000).toFixed(1)} km`}
                        onClick={() => onSelectSection(s.section_id)}
                      >
                        {s.section_id} · {s.pct}%
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>,
    getFullscreenPortalRoot()
  )
}
