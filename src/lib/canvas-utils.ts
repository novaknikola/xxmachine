export type TextPosition = 'top' | 'center' | 'bottom'
export type TextStyle = 'white-black' | 'black-white' | 'gold-black'

export interface AugTransform {
  flipH: boolean
  zoom: number
  zoomOffX: number
  zoomOffY: number
  brightness: number
  contrast: number
  saturate: number
  hueRotate: number
  sepia: number
  blur: number
}

export const TEXT_STYLE_OPTIONS: { value: TextStyle; label: string }[] = [
  { value: 'white-black', label: 'White + Black stroke' },
  { value: 'black-white', label: 'Black + White stroke' },
  { value: 'gold-black',  label: 'Gold + Black stroke' },
]

export const POSITION_OPTIONS: { value: TextPosition; label: string }[] = [
  { value: 'top',    label: 'Top' },
  { value: 'center', label: 'Center' },
  { value: 'bottom', label: 'Bottom' },
]

export const SLIDE_VARIATIONS = [
  'front camera selfie, natural expression',
  'slightly different angle, different pose, candid',
  'looking away, soft candid moment',
  'close-up, intimate framing',
  'three quarter view, relaxed pose',
  'mirror selfie, full body',
  'overhead angle, artistic framing',
]

const CAPTION_FONT = `'Playfair Display', Georgia, serif`

export async function ensureCaptionFont(sizePx: number) {
  if (typeof document === 'undefined') return
  try {
    await document.fonts.load(`800 ${sizePx}px 'Playfair Display'`)
  } catch { /* fallback to system fonts */ }
}

export function applyText(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  caption: string,
  position: TextPosition,
  style: TextStyle,
  fontSizePx: number,
) {
  if (!caption.trim()) return

  const styleMap: Record<TextStyle, { fill: string; stroke: string }> = {
    'white-black': { fill: '#ffffff', stroke: '#000000' },
    'black-white': { fill: '#000000', stroke: '#ffffff' },
    'gold-black':  { fill: '#FFD700', stroke: '#000000' },
  }
  const { fill, stroke } = styleMap[style]
  const px = fontSizePx
  const strokeW = Math.max(2, Math.round(px * 0.06))

  ctx.font = `900 ${px}px ${CAPTION_FONT}`
  ctx.textAlign = 'center'
  ctx.lineJoin = 'round'

  const allLines: string[] = []
  for (const rawLine of caption.split('\n')) {
    const words = rawLine.split(' ')
    let line = ''
    for (const word of words) {
      const test = line ? `${line} ${word}` : word
      if (ctx.measureText(test).width > w * 0.88) {
        if (line) allLines.push(line)
        line = word
      } else {
        line = test
      }
    }
    if (line) allLines.push(line)
    else allLines.push('')
  }

  const lineH = px * 1.3
  const totalH = allLines.length * lineH
  const yMap: Record<TextPosition, number> = {
    top:    h * 0.12,
    center: h * 0.50 - totalH / 2 + lineH,
    bottom: h * 0.88 - totalH + lineH,
  }
  const x = w / 2
  let y = yMap[position]

  for (const ln of allLines) {
    if (ln.trim()) {
      ctx.lineWidth = strokeW
      ctx.strokeStyle = stroke
      ctx.strokeText(ln, x, y)
      ctx.fillStyle = fill
      ctx.fillText(ln, x, y)
    }
    y += lineH
  }
}

export async function renderToBlob(
  imageUrl: string,
  caption: string,
  position: TextPosition,
  style: TextStyle,
  fontSizePx: number,
): Promise<Blob> {
  await ensureCaptionFont(fontSizePx)
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      applyText(ctx, canvas.width, canvas.height, caption, position, style, fontSizePx)
      canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error('toBlob failed')),
        'image/jpeg', 0.95,
      )
    }
    img.onerror = () => reject(new Error('Load failed: ' + imageUrl.split('/').pop()))
    img.src = imageUrl
  })
}

export function randomTransform(): AugTransform {
  const r = (a: number, b: number) => a + Math.random() * (b - a)
  const isGrayscale = Math.random() < 0.15
  return {
    flipH:      Math.random() < 0.5,
    zoom:       r(1.0, 1.08),
    zoomOffX:   Math.random(),
    zoomOffY:   Math.random(),
    brightness: r(0.88, 1.13),
    contrast:   r(0.88, 1.13),
    saturate:   isGrayscale ? 0 : r(0.88, 1.13),
    hueRotate:  r(-12, 12),
    sepia:      isGrayscale ? 0 : r(0, 0.12),
    blur:       Math.random() < 0.15 ? r(0.2, 0.5) : 0,
  }
}

export async function renderAugmented(
  imageUrl: string,
  caption: string,
  position: TextPosition,
  style: TextStyle,
  fontSizePx: number,
  t: AugTransform,
): Promise<Blob> {
  await ensureCaptionFont(fontSizePx)
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const w = img.naturalWidth
      const h = img.naturalHeight
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')!

      const filterParts = [
        `brightness(${t.brightness.toFixed(2)})`,
        `contrast(${t.contrast.toFixed(2)})`,
        `saturate(${t.saturate.toFixed(2)})`,
        `hue-rotate(${t.hueRotate.toFixed(1)}deg)`,
        t.sepia > 0.01 ? `sepia(${t.sepia.toFixed(2)})` : '',
        t.blur   > 0.01 ? `blur(${t.blur.toFixed(1)}px)`  : '',
      ].filter(Boolean).join(' ')
      ctx.filter = filterParts

      ctx.save()
      if (t.flipH) {
        ctx.translate(w, 0)
        ctx.scale(-1, 1)
      }

      const sw = w / t.zoom
      const sh = h / t.zoom
      const sx = (w - sw) * t.zoomOffX
      const sy = (h - sh) * t.zoomOffY
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h)
      ctx.restore()

      ctx.filter = 'none'
      applyText(ctx, w, h, caption, position, style, fontSizePx)

      canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error('toBlob failed')),
        'image/jpeg', 0.92,
      )
    }
    img.onerror = () => reject(new Error('Load failed'))
    img.src = imageUrl
  })
}
