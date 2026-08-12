import sharp, { type OverlayOptions } from 'sharp'
import type { ReproduceSettings } from '@/app/(dashboard)/repurpose/reproduce-logic'

function seededRng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b)
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b)
    s ^= s >>> 16
    return (s >>> 0) / 0xffffffff
  }
}

function lerp(rng: () => number, min: number, max: number) {
  return min + rng() * (max - min)
}

/** sharp has no direct CSS contrast() — this is the same linear transform canvas uses. */
function contrastLinear(factor: number): { a: number; b: number } {
  return { a: factor, b: 128 * (1 - factor) }
}

function vignetteSvg(w: number, h: number, opacity: number): Buffer {
  const cx = w / 2
  const cy = h / 2
  const r0 = h * 0.25
  const r1 = h * 0.85
  return Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="v" cx="${cx}" cy="${cy}" r="${r1}" gradientUnits="userSpaceOnUse">
          <stop offset="${(r0 / r1).toFixed(4)}" stop-color="black" stop-opacity="0"/>
          <stop offset="1" stop-color="black" stop-opacity="${opacity.toFixed(3)}"/>
        </radialGradient>
      </defs>
      <rect width="${w}" height="${h}" fill="url(#v)"/>
    </svg>`,
  )
}

/**
 * Server-side port of public/reproduce.worker.js — same seeded-RNG algorithm
 * and effect order (crop/zoom/rotate -> color -> grain -> vignette -> LSB
 * anti-watermark noise), so variant output looks the same. Pure CPU (sharp/
 * libvips), no GPU/canvas involved — that's what removes the OffscreenCanvas
 * readback failure structurally, not just papers over it.
 */
export async function processImageVariant(
  inputBuffer: Buffer,
  seed: number,
  settings: ReproduceSettings,
): Promise<Buffer> {
  const rng = seededRng(seed)
  const src = sharp(inputBuffer, { failOn: 'none' }).rotate() // .rotate() with no args: auto-orient from EXIF, matches Image() in-browser decode
  const meta = await src.metadata()
  const W = meta.width ?? 0
  const H = meta.height ?? 0
  if (!W || !H) throw new Error('Could not read image dimensions')

  const scale = settings.zoom.enabled ? lerp(rng, settings.zoom.min, settings.zoom.max) / 100 : 1
  const srcW = Math.max(1, Math.round(W / scale))
  const srcH = Math.max(1, Math.round(H / scale))
  const availX = W - srcW
  const availY = H - srcH
  const cropBias = settings.crop.enabled ? lerp(rng, settings.crop.min, settings.crop.max) / 100 : 0
  const srcX = Math.round(Math.max(0, Math.min(availX * (0.5 + (rng() - 0.5) * (1 + cropBias * 4)), availX)))
  const srcY = Math.round(Math.max(0, Math.min(availY * (0.5 + (rng() - 0.5) * (1 + cropBias * 4)), availY)))

  const deg = settings.rotation.enabled ? lerp(rng, settings.rotation.min, settings.rotation.max) : 0
  const rad = (deg * Math.PI) / 180
  // Same compensation as the canvas version: enlarge before rotating so the
  // rotated frame has no transparent corners, then crop back to W x H.
  const rotCompensate = deg !== 0
    ? 1 / (Math.abs(Math.cos(rad)) + Math.abs(Math.sin(rad)) * (H / W))
    : 1
  const preW = Math.round(W / rotCompensate)
  const preH = Math.round(H / rotCompensate)

  const br = settings.brightness.enabled ? lerp(rng, settings.brightness.min, settings.brightness.max) : 0
  const co = settings.contrast.enabled ? lerp(rng, settings.contrast.min, settings.contrast.max) : 0
  const sa = settings.saturation.enabled ? lerp(rng, settings.saturation.min, settings.saturation.max) : 0
  const hu = settings.hue.enabled ? lerp(rng, settings.hue.min, settings.hue.max) : 0
  const flip = settings.flipH && rng() > 0.5

  let pipeline = sharp(inputBuffer, { failOn: 'none' })
    .rotate()
    .extract({ left: srcX, top: srcY, width: srcW, height: srcH })
    .resize(preW, preH) // zoom, and rotation headroom in the same step
    .modulate({
      brightness: (100 + br) / 100,
      saturation: (100 + sa) / 100,
      hue: Math.round(hu),
    })

  const { a, b } = contrastLinear((100 + co) / 100)
  pipeline = pipeline.linear(a, b)

  if (flip) pipeline = pipeline.flop()
  if (deg !== 0) pipeline = pipeline.rotate(deg, { background: { r: 0, g: 0, b: 0, alpha: 0 } })

  // Rotation expands the canvas to fit (libvips, standard bounding-box
  // formula) — center-crop back to the original W x H, which rotCompensate
  // already sized to have no transparent gaps. The explicit width/height
  // below already pin this to exactly W x H (Math.min caps it), so no
  // separate "pin resize" afterward — a resize(W, H) on an already-W×H
  // image trips a libvips "bad extract area" edge case in its own cover-fit
  // crop internals.
  if (deg !== 0) {
    const rw = Math.round(preW * Math.abs(Math.cos(rad)) + preH * Math.abs(Math.sin(rad)))
    const rh = Math.round(preW * Math.abs(Math.sin(rad)) + preH * Math.abs(Math.cos(rad)))
    pipeline = pipeline.extract({
      left: Math.max(0, Math.round((rw - W) / 2)),
      top: Math.max(0, Math.round((rh - H) / 2)),
      width: Math.min(W, rw),
      height: Math.min(H, rh),
    })
  }

  const composites: OverlayOptions[] = []

  if (settings.grain.enabled) {
    const grainOpacity = lerp(rng, settings.grain.min, settings.grain.max) / 100
    const grainRaw = Buffer.alloc(W * H * 4)
    for (let i = 0; i < grainRaw.length; i += 4) {
      const v = 128 + Math.round((rng() - 0.5) * 255)
      grainRaw[i] = v
      grainRaw[i + 1] = v
      grainRaw[i + 2] = v
      grainRaw[i + 3] = Math.round(grainOpacity * 255)
    }
    const grainPng = await sharp(grainRaw, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()
    composites.push({ input: grainPng, blend: 'overlay' })
  }

  if (settings.vignette.enabled) {
    const vigOpacity = lerp(rng, settings.vignette.min, settings.vignette.max) / 100
    composites.push({ input: vignetteSvg(W, H, vigOpacity), blend: 'multiply' })
  }

  if (composites.length) pipeline = pipeline.composite(composites)

  // Steganographic watermark destruction: imperceptible ±1 LSB noise per
  // channel, same as the worker — breaks frequency-domain watermarks
  // (Stable Signature, C2PA) without visible quality loss.
  // removeAlpha() pins this to 3 channels regardless of source format or
  // whether grain/vignette compositing above promoted it to RGBA.
  const { data, info } = await pipeline.removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const channels = info.channels
  for (let i = 0; i < data.length; i += channels) {
    data[i] = Math.max(0, Math.min(255, data[i] + (rng() > 0.5 ? 1 : -1)))
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + (rng() > 0.5 ? 1 : -1)))
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + (rng() > 0.5 ? 1 : -1)))
  }

  return sharp(data, { raw: { width: info.width, height: info.height, channels } })
    .jpeg({ quality: 92 })
    .toBuffer()
}
