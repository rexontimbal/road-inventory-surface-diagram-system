export const SURFACE_COLORS = {
  unpaved: '#FFFFFF',
  paved: '#9E9E9E',
  asphalt: '#000000',
}

let cachedGravelPattern = null

export function getGravelPattern(ctx) {
  if (cachedGravelPattern) return cachedGravelPattern
  const tile = document.createElement('canvas')
  tile.width = 8
  tile.height = 8
  const tctx = tile.getContext('2d')
  tctx.fillStyle = '#FFFFFF'
  tctx.fillRect(0, 0, 8, 8)
  tctx.strokeStyle = '#000000'
  tctx.lineWidth = 1
  tctx.beginPath()
  tctx.moveTo(0, 8)
  tctx.lineTo(8, 0)
  tctx.moveTo(-2, 2)
  tctx.lineTo(2, -2)
  tctx.moveTo(6, 10)
  tctx.lineTo(10, 6)
  tctx.stroke()
  cachedGravelPattern = ctx.createPattern(tile, 'repeat')
  return cachedGravelPattern
}

export function fillForSurface(ctx, surfaceType) {
  if (surfaceType === 'gravel') return getGravelPattern(ctx)
  return SURFACE_COLORS[surfaceType] || '#FF00FF' // magenta = unrecognized value, should never happen post-validation
}

// Subtle top-lit gradient for asphalt/paved cells only -- stays visually the
// same hue as the flat legend swatch (so it still reads as "the same color"),
// just with a light bevel for depth instead of a flat CAD fill. Unpaved and
// gravel stay as their flat/pattern fill (matte dirt has no such sheen).
const GRADIENT_STOPS = {
  asphalt: ['#3a3a3a', '#000000'],
  paved: ['#c4c4c4', '#9E9E9E'],
}

export function fillForCell(ctx, surfaceType, x, y, w, h) {
  const stops = GRADIENT_STOPS[surfaceType]
  if (!stops) return fillForSurface(ctx, surfaceType)
  const gradient = ctx.createLinearGradient(x, y, x, y + h)
  gradient.addColorStop(0, stops[0])
  gradient.addColorStop(1, stops[1])
  return gradient
}
