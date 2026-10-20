export const SURFACE_COLORS = {
  concrete: '#9E9E9E',
  asphalt: '#000000',
  earth: '#C8A165',
  none: '#FFFFFF',
}

const GRAVEL_TILE_SIZE = 8 // logical px -- the hatch's on-screen spacing, unchanged at any scale

// Cached per `scale` (devicePixelRatio * zoom, or an HD-export factor) --
// the common case is many gravel cells in one render call at the same
// scale, so this still avoids rebuilding the tile per-cell while still
// producing a dense-enough bitmap for whatever resolution is being drawn.
const patternCache = new Map()

export function getGravelPattern(ctx, scale = 1) {
  const cached = patternCache.get(scale)
  if (cached) return cached

  // Built at `scale`x the logical tile size so the hatch has as much detail
  // as the destination canvas itself -- otherwise (building it once at a
  // flat 8x8px and reusing it under a scaled ctx.setTransform) the pattern
  // bitmap gets stretched by the transform like any other low-res image,
  // which is what made gravel hatching look soft versus everything else.
  const tile = document.createElement('canvas')
  tile.width = GRAVEL_TILE_SIZE * scale
  tile.height = GRAVEL_TILE_SIZE * scale
  const tctx = tile.getContext('2d')
  tctx.scale(scale, scale)
  tctx.fillStyle = '#FFFFFF'
  tctx.fillRect(0, 0, GRAVEL_TILE_SIZE, GRAVEL_TILE_SIZE)
  tctx.strokeStyle = '#000000'
  tctx.lineWidth = 1
  tctx.beginPath()
  tctx.moveTo(0, GRAVEL_TILE_SIZE)
  tctx.lineTo(GRAVEL_TILE_SIZE, 0)
  tctx.moveTo(-2, 2)
  tctx.lineTo(2, -2)
  tctx.moveTo(GRAVEL_TILE_SIZE - 2, GRAVEL_TILE_SIZE + 2)
  tctx.lineTo(GRAVEL_TILE_SIZE + 2, GRAVEL_TILE_SIZE - 2)
  tctx.stroke()

  const pattern = ctx.createPattern(tile, 'repeat')
  // The tile is now `scale`x denser than its logical size -- scale the
  // pattern's own matrix back down so it still REPEATS every 8 logical px
  // on screen (composed with the destination ctx's own transform, this
  // maps each of the tile's extra physical pixels 1:1 to a device pixel
  // instead of being stretched across one).
  if (pattern.setTransform && typeof DOMMatrix !== 'undefined') {
    pattern.setTransform(new DOMMatrix([1 / scale, 0, 0, 1 / scale, 0, 0]))
  }
  patternCache.set(scale, pattern)
  return pattern
}

export function fillForSurface(ctx, surfaceType, scale = 1) {
  if (surfaceType === 'gravel') return getGravelPattern(ctx, scale)
  return SURFACE_COLORS[surfaceType] || '#FF00FF' // magenta = unrecognized value, should never happen post-validation
}

// Subtle top-lit gradient for asphalt/concrete cells only -- stays visually
// the same hue as the flat legend swatch (so it still reads as "the same
// color"), just with a light bevel for depth instead of a flat CAD fill.
// Earth/none/gravel stay as their flat/pattern fill (matte surfaces have no
// such sheen).
const GRADIENT_STOPS = {
  asphalt: ['#3a3a3a', '#000000'],
  concrete: ['#c4c4c4', '#9E9E9E'],
}

export function fillForCell(ctx, surfaceType, x, y, w, h, scale = 1) {
  const stops = GRADIENT_STOPS[surfaceType]
  if (!stops) return fillForSurface(ctx, surfaceType, scale)
  const gradient = ctx.createLinearGradient(x, y, x, y + h)
  gradient.addColorStop(0, stops[0])
  gradient.addColorStop(1, stops[1])
  return gradient
}
