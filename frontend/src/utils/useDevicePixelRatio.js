import { useEffect, useState } from 'react'

// window.devicePixelRatio has no native "change" event -- the standard way
// to watch it is a matchMedia query tied to its current value, which fires
// once when the ratio stops matching (e.g. the window moves to a monitor
// with different scaling) and must be re-subscribed at the new value each
// time, since the old query is now permanently stale.
export function useDevicePixelRatio() {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1)

  useEffect(() => {
    const mql = window.matchMedia(`(resolution: ${dpr}dppx)`)
    function handleChange() {
      setDpr(window.devicePixelRatio || 1)
    }
    mql.addEventListener('change', handleChange)
    return () => mql.removeEventListener('change', handleChange)
  }, [dpr])

  return dpr
}
