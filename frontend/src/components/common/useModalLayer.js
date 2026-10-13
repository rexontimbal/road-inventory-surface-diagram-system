import { useLayoutEffect, useRef, useState } from 'react'
import { isTopModal, popModal, pushModal } from './modalStack'

/**
 * Registers one modal instance in the shared stack for as long as it's
 * mounted. Returns a z-index assigned once at mount (so later-opened
 * modals always render above earlier ones, regardless of DOM/portal order)
 * and a live isTop() check -- call it inside Esc/Tab-trap handlers so a
 * background modal that's still mounted underneath a nested one doesn't
 * also react to the same keypress.
 */
export function useModalLayer() {
  const idRef = useRef(null)
  if (idRef.current === null) idRef.current = `modal-${Math.random().toString(36).slice(2)}`
  const [zIndex, setZIndex] = useState(null)

  useLayoutEffect(() => {
    setZIndex(pushModal(idRef.current))
    return () => popModal(idRef.current)
  }, [])

  return {
    zIndex,
    isTop: () => isTopModal(idRef.current),
  }
}
