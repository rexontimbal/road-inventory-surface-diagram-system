// Lets Header (which owns the actual DOM node -- the flex gap between the
// title block and the right-side button group) hand that node to
// DialogProvider (a top-level singleton with no direct ref into Header's
// tree) so toasts can portal there instead of their own fixed position.
// Same "module-level singleton + subscribe" shape as DialogProvider's own
// showToast/showAlert/showConfirm handlers, for the same reason: the two
// components don't have a parent/child relationship DialogProvider could
// pass a ref down through.
let _slotEl = null
const _listeners = new Set()

export function registerHeaderToastSlot(el) {
  _slotEl = el
  _listeners.forEach((fn) => fn(el))
}

export function subscribeHeaderToastSlot(fn) {
  _listeners.add(fn)
  fn(_slotEl)
  return () => _listeners.delete(fn)
}
