import { useState } from 'react'
import { showConfirm } from '../common/DialogProvider'
import CustomSelect from '../common/CustomSelect'

export default function SectionSelectPanel({
  districts,
  sections,
  selectedDistrict,
  onSelectDistrict,
  selectedSectionId,
  onSelectSection,
  roadName,
  classification,
  deo,
  ld,
  onDelete,
  onExpand,
  canEdit = true,
}) {
  const [deleting, setDeleting] = useState(false)

  async function handleDeleteClick() {
    if (!selectedSectionId) return
    const confirmed = await showConfirm({
      title: 'Delete section?',
      message: (
        <>
          <strong>{selectedSectionId} — {roadName}</strong> and all its segments will be removed. This cannot be
          undone.
        </>
      ),
      confirmText: 'Delete section',
      cancelText: 'Cancel',
      variant: 'danger',
    })
    if (!confirmed) return
    setDeleting(true)
    try {
      await onDelete(selectedSectionId)
    } finally {
      setDeleting(false)
    }
  }

  const districtOptions = districts.map((d) => ({ value: d.deo, label: d.deo, ld: d.ld, count: d.count }))
  const sectionOptions = sections.map((r) => ({
    value: r.section_id,
    label: r.section_id,
    roadName: r.road_name,
    classification: r.classification,
  }))

  return (
    <div className="panel">
      <button type="button" className="panel-icon" title="Select Section" onClick={onExpand}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4 20 10 4h4l6 16M7 14h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div className="panel-body">
      <h2>2. Select Section</h2>
      <label>
        District
        <CustomSelect
          size="sm"
          value={selectedDistrict || ''}
          onChange={onSelectDistrict}
          disabled={districts.length === 0}
          placeholder={districts.length === 0 ? 'Upload Excel first' : 'Select a district'}
          ariaLabel="District"
          searchable
          searchPlaceholder="Search district (DEO)…"
          getSearchText={(o) => `${o.label} ${o.ld}`}
          options={districtOptions}
          renderOption={(o) => (
            <div className="custom-select-district-option">
              <div className="custom-select-district-main">
                <span className="custom-select-district-name">{o.label}</span>
                {o.ld && <span className="custom-select-district-ld">{o.ld}</span>}
              </div>
              <span className="custom-select-district-count">{o.count}</span>
            </div>
          )}
        />
      </label>
      <label>
        Section ID
        <CustomSelect
          size="sm"
          value={selectedSectionId || ''}
          onChange={onSelectSection}
          disabled={!selectedDistrict || sections.length === 0}
          placeholder={!selectedDistrict ? 'Select a district first' : 'Select a section'}
          ariaLabel="Section ID"
          searchable
          searchPlaceholder="Search section ID or name…"
          getSearchText={(o) => `${o.value} ${o.roadName}`}
          options={sectionOptions}
          renderOption={(o) => (
            <div className="custom-select-road-option">
              <div className="custom-select-road-option-head">
                <span className="custom-select-road-id">{o.value}</span>
                {o.classification && <span className="classification-badge">{o.classification}</span>}
              </div>
              <span className="custom-select-road-name">{o.roadName}</span>
            </div>
          )}
        />
      </label>
      <label>
        Road Name
        <div className="readonly-display">
          {roadName || <span className="readonly-placeholder">Auto-filled after selecting a section</span>}
        </div>
      </label>
      <label>
        Classification
        <div className="readonly-display">
          {classification ? (
            <span className="classification-badge">{classification}</span>
          ) : (
            <span className="readonly-placeholder">—</span>
          )}
        </div>
      </label>
      <label>
        DEO
        <div className="readonly-display">
          {deo || <span className="readonly-placeholder">—</span>}
        </div>
      </label>
      <label>
        LD
        <div className="readonly-display">
          {ld || <span className="readonly-placeholder">—</span>}
        </div>
      </label>
      {selectedSectionId && canEdit && (
        <button type="button" className="delete-road-link" onClick={handleDeleteClick} disabled={deleting}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {deleting ? 'Deleting…' : 'Delete this section'}
        </button>
      )}
      </div>
    </div>
  )
}
