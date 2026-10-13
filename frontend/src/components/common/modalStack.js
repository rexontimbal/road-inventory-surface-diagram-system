// Shared stacking order for every portaled modal in the app (confirm/alert,
// upload-conflict, upload-history, restore-backup, and any confirm opened
// from inside one of those). Without this, every modal used the same fixed
// z-index and its own independent document-level keydown listener, so a
// modal opened on top of another could render BEHIND it (whichever modal's
// DOM node happened to come later in document.body won the tie), and
// pressing Esc closed every open modal at once instead of just the top one.
let stack = []

const BASE_Z = 1000
const Z_STEP = 10

export function pushModal(id) {
  stack.push(id)
  return BASE_Z + (stack.length - 1) * Z_STEP
}

export function popModal(id) {
  stack = stack.filter((x) => x !== id)
}

export function isTopModal(id) {
  return stack.length > 0 && stack[stack.length - 1] === id
}
