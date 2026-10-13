// While the diagram's fullscreen view is active via the real browser
// Fullscreen API, anything portaled to document.body (modals, dropdowns,
// toasts) would render OUTSIDE the fullscreen element and simply not be
// visible -- the browser only paints the fullscreen element's own subtree.
// Portal targets should resolve through this instead of a bare
// document.body so they land inside whatever is actually fullscreen, and
// fall back to document.body the rest of the time (same behavior as before).
export function getFullscreenPortalRoot() {
  return document.fullscreenElement || document.webkitFullscreenElement || document.body
}
