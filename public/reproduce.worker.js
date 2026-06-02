// Web Worker for canvas-based image reproduction
// Runs in a separate thread to avoid blocking the UI

function seededRng(seed) {
  let s = seed >>> 0
  return () => {
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b)
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b)
    s ^= s >>> 16
    return (s >>> 0) / 0xffffffff
  }
}

function lerp(rng, min, max) {
  return min + rng() * (max - min)
}

async function processImage(fileData, settings, seed) {
  const blob = new Blob([fileData.buffer], { type: fileData.type })
  const bitmap = await createImageBitmap(blob)

  const W = bitmap.width
  const H = bitmap.height

  const canvas = new OffscreenCanvas(W, H)
  const ctx = canvas.getContext('2d')

  const rng = seededRng(seed)

  const scale = settings.zoom.enabled ? lerp(rng, settings.zoom.min, settings.zoom.max) / 100 : 1
  const srcW = W / scale
  const srcH = H / scale
  const availX = W - srcW
  const availY = H - srcH
  const cropBias = settings.crop.enabled ? lerp(rng, settings.crop.min, settings.crop.max) / 100 : 0
  const srcX = Math.max(0, Math.min(availX * (0.5 + (rng() - 0.5) * (1 + cropBias * 4)), availX))
  const srcY = Math.max(0, Math.min(availY * (0.5 + (rng() - 0.5) * (1 + cropBias * 4)), availY))

  const deg = settings.rotation.enabled ? lerp(rng, settings.rotation.min, settings.rotation.max) : 0
  const rad = (deg * Math.PI) / 180
  const rotCompensate = deg !== 0 ? 1 / (Math.abs(Math.cos(rad)) + Math.abs(Math.sin(rad)) * (H / W)) : 1

  const br = settings.brightness.enabled ? lerp(rng, settings.brightness.min, settings.brightness.max) : 0
  const co = settings.contrast.enabled ? lerp(rng, settings.contrast.min, settings.contrast.max) : 0
  const sa = settings.saturation.enabled ? lerp(rng, settings.saturation.min, settings.saturation.max) : 0
  const hu = settings.hue.enabled ? lerp(rng, settings.hue.min, settings.hue.max) : 0

  ctx.filter = [
    `brightness(${(100 + br) / 100})`,
    `contrast(${(100 + co) / 100})`,
    `saturate(${(100 + sa) / 100})`,
    `hue-rotate(${hu}deg)`,
  ].join(' ')

  ctx.save()
  ctx.translate(W / 2, H / 2)
  ctx.rotate(rad)
  if (rotCompensate !== 1) ctx.scale(1 / rotCompensate, 1 / rotCompensate)
  if (settings.flipH && rng() > 0.5) ctx.scale(-1, 1)
  ctx.drawImage(bitmap, srcX, srcY, srcW, srcH, -W / 2, -H / 2, W, H)
  ctx.restore()
  ctx.filter = 'none'

  if (settings.grain.enabled) {
    const grainOpacity = lerp(rng, settings.grain.min, settings.grain.max) / 100
    const grainCanvas = new OffscreenCanvas(W, H)
    const gc = grainCanvas.getContext('2d')
    const imageData = gc.createImageData(W, H)
    for (let i = 0; i < imageData.data.length; i += 4) {
      const v = Math.round((rng() - 0.5) * 255)
      imageData.data[i] = 128 + v
      imageData.data[i + 1] = 128 + v
      imageData.data[i + 2] = 128 + v
      imageData.data[i + 3] = 255
    }
    gc.putImageData(imageData, 0, 0)
    ctx.globalAlpha = grainOpacity
    ctx.globalCompositeOperation = 'overlay'
    ctx.drawImage(grainCanvas, 0, 0)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }

  if (settings.vignette.enabled) {
    const vigOpacity = lerp(rng, settings.vignette.min, settings.vignette.max) / 100
    const grad = ctx.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, H * 0.85)
    grad.addColorStop(0, 'rgba(0,0,0,0)')
    grad.addColorStop(1, `rgba(0,0,0,${vigOpacity})`)
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, W, H)
  }

  // Steganographic watermark destruction:
  // Inject imperceptible per-pixel noise (±1 LSB) that disrupts
  // frequency-domain watermarks (Stable Signature, C2PA) without
  // visible quality loss. Applied after all visual effects.
  const pixelData = ctx.getImageData(0, 0, W, H)
  const d = pixelData.data
  for (let i = 0; i < d.length; i += 4) {
    // ±1 on each channel — invisible but breaks steganographic patterns
    d[i]     = Math.max(0, Math.min(255, d[i]     + (rng() > 0.5 ? 1 : -1)))
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + (rng() > 0.5 ? 1 : -1)))
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + (rng() > 0.5 ? 1 : -1)))
  }
  ctx.putImageData(pixelData, 0, 0)

  bitmap.close()
  const outputBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
  return outputBlob
}

self.onmessage = async (e) => {
  const { taskId, fileData, settings, seed } = e.data
  try {
    const blob = await processImage(fileData, settings, seed)
    const arrayBuffer = await blob.arrayBuffer()
    self.postMessage({ taskId, ok: true, buffer: arrayBuffer, type: 'image/jpeg' }, [arrayBuffer])
  } catch (err) {
    self.postMessage({ taskId, ok: false, error: err.message ?? 'Worker error' })
  }
}
