import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const OPEN_EVENT = 'customselect:open'

/**
 * Accessible, portal-rendered dropdown replacing native <select>, styled to
 * match the system and reusable across simple option lists and "rich"
 * options (status pills, surface swatches, 2-line road entries).
 *
 * options: [{ value, label, disabled? }]
 * renderOption(option, { active, selected }): optional custom option body
 * getSearchText(option): optional string used for search filtering (defaults to label)
 */
export default function CustomSelect({
  options,
  value,
  onChange,
  placeholder = 'Select…',
  searchable = false,
  searchPlaceholder = 'Search…',
  disabled = false,
  size = 'md',
  renderOption,
  getSearchText,
  triggerClassName = '',
  ariaLabel,
}) {
  const instanceId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)
  const [placement, setPlacement] = useState(null) // { top, left, width, maxWidth, flip }
  const [ready, setReady] = useState(false)

  const triggerRef = useRef(null)
  const panelRef = useRef(null)
  const searchInputRef = useRef(null)
  const listRef = useRef(null)
  const typeaheadRef = useRef({ buffer: '', timer: null })

  const selected = options.find((o) => String(o.value) === String(value)) || null

  const filtered = !searchable || !query.trim()
    ? options
    : options.filter((o) => {
        const text = (getSearchText ? getSearchText(o) : o.label) || ''
        return text.toLowerCase().includes(query.trim().toLowerCase())
      })

  function close() {
    setOpen(false)
    setQuery('')
    setActiveIndex(-1)
    setReady(false)
  }

  function openPanel() {
    if (disabled) return
    document.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: instanceId }))
    setOpen(true)
    const initialIdx = filtered.findIndex((o) => String(o.value) === String(value))
    setActiveIndex(initialIdx >= 0 ? initialIdx : 0)
  }

  function toggle() {
    if (open) close()
    else openPanel()
  }

  function selectOption(opt) {
    if (opt.disabled) return
    onChange(opt.value)
    close()
    triggerRef.current?.focus()
  }

  // Only one dropdown open at a time: close if another instance announces it opened.
  useEffect(() => {
    function handleOtherOpen(e) {
      if (e.detail !== instanceId) close()
    }
    document.addEventListener(OPEN_EVENT, handleOtherOpen)
    return () => document.removeEventListener(OPEN_EVENT, handleOtherOpen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId])

  // Outside click + Escape.
  useEffect(() => {
    if (!open) return
    function handlePointerDown(e) {
      if (triggerRef.current?.contains(e.target)) return
      if (panelRef.current?.contains(e.target)) return
      close()
    }
    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
        triggerRef.current?.focus()
      }
    }
    // Close on outer-page scroll (stale position otherwise); scrolling
    // inside the panel's own option list must NOT close it.
    function handleScroll(e) {
      if (panelRef.current?.contains(e.target)) return
      close()
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('scroll', handleScroll, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Position the portal panel against the trigger, flipping up if there's
  // not enough room below the viewport, then fade it in.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const estimatedHeight = (searchable ? 44 : 0) + 260 + 16
    const spaceBelow = window.innerHeight - rect.bottom
    const flip = spaceBelow < estimatedHeight && rect.top > estimatedHeight
    const maxWidth = 280
    const left = Math.min(rect.left, window.innerWidth - maxWidth - 8)
    setPlacement({
      left: Math.max(8, left),
      top: flip ? null : rect.bottom + 4,
      bottom: flip ? window.innerHeight - rect.top + 4 : null,
      minWidth: rect.width,
      maxWidth,
    })
    setReady(true)
    if (searchable) {
      searchInputRef.current?.focus()
    } else {
      panelRef.current?.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector(`[data-idx="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  function handleTriggerKeyDown(e) {
    if (disabled) return
    if (!open && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      openPanel()
    }
  }

  function moveActive(delta) {
    setActiveIndex((prev) => {
      if (filtered.length === 0) return -1
      let next = prev + delta
      if (next < 0) next = filtered.length - 1
      if (next >= filtered.length) next = 0
      return next
    })
  }

  function handlePanelKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveActive(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveActive(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const opt = filtered[activeIndex]
      if (opt) selectOption(opt)
    } else if (e.key === 'Tab') {
      close()
    } else if (!searchable && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Type-ahead: jump to the first option whose label starts with the
      // typed buffer (reset after a short pause between keystrokes).
      const t = typeaheadRef.current
      clearTimeout(t.timer)
      t.buffer += e.key.toLowerCase()
      t.timer = setTimeout(() => {
        t.buffer = ''
      }, 600)
      const match = filtered.findIndex((o) =>
        (o.label || '').toLowerCase().startsWith(t.buffer)
      )
      if (match >= 0) setActiveIndex(match)
    }
  }

  const listboxId = `customselect-listbox-${instanceId}`

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={`custom-select-trigger custom-select-${size}${disabled ? ' custom-select-disabled' : ''}${open ? ' custom-select-open' : ''} ${triggerClassName}`}
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        disabled={disabled}
        title={selected ? selected.label : undefined}
        onClick={toggle}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className={`custom-select-value${!selected ? ' custom-select-placeholder' : ''}`}>
          {selected ? selected.label : placeholder}
        </span>
        <svg
          className="custom-select-chevron"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={listboxId}
            role="listbox"
            tabIndex={-1}
            className={`custom-select-panel${ready ? ' custom-select-panel-ready' : ''}`}
            style={{
              position: 'fixed',
              left: placement?.left ?? -9999,
              top: placement?.top ?? undefined,
              bottom: placement?.bottom ?? undefined,
              minWidth: placement?.minWidth,
              maxWidth: placement?.maxWidth,
            }}
            onKeyDown={handlePanelKeyDown}
          >
            {searchable && (
              <div className="custom-select-search-wrap">
                <input
                  ref={searchInputRef}
                  type="text"
                  className="custom-select-search"
                  placeholder={searchPlaceholder}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setActiveIndex(0)
                  }}
                />
              </div>
            )}
            <div className={`custom-select-options thin-scroll custom-select-options-${size}`} ref={listRef}>
              {filtered.length === 0 && <div className="custom-select-empty">No results</div>}
              {filtered.map((opt, idx) => {
                const isSelected = String(opt.value) === String(value)
                const isActive = idx === activeIndex
                return (
                  <div
                    key={opt.value}
                    data-idx={idx}
                    role="option"
                    aria-selected={isSelected}
                    className={`custom-select-option${isActive ? ' custom-select-option-active' : ''}${isSelected ? ' custom-select-option-selected' : ''}${opt.disabled ? ' custom-select-option-disabled' : ''}`}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => selectOption(opt)}
                  >
                    <div className="custom-select-option-body">
                      {renderOption ? renderOption(opt, { active: isActive, selected: isSelected }) : opt.label}
                    </div>
                    {isSelected && (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="custom-select-check">
                        <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </div>
                )
              })}
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
