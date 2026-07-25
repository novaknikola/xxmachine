export interface EffectRange {
  enabled: boolean
  min: number
  max: number
}

export interface ReproduceSettings {
  count: number
  crop: EffectRange
  zoom: EffectRange
  rotation: EffectRange
  brightness: EffectRange
  contrast: EffectRange
  saturation: EffectRange
  hue: EffectRange
  grain: EffectRange
  vignette: EffectRange
  flipH: boolean
}

export interface ReproduceVariant {
  id: string
  sourceId: string
  sourceName: string
  url: string
  seed: number
}

export const DEFAULT_REPRODUCE: ReproduceSettings = {
  count: 4,
  crop:       { enabled: true,  min: 0,   max: 8   },
  zoom:       { enabled: true,  min: 100, max: 115  },
  rotation:   { enabled: true,  min: -3,  max: 3    },
  brightness: { enabled: true,  min: -15, max: 15   },
  contrast:   { enabled: true,  min: -10, max: 15   },
  saturation: { enabled: true,  min: -20, max: 25   },
  hue:        { enabled: false, min: -10, max: 10   },
  grain:      { enabled: true,  min: 2,   max: 10   },
  vignette:   { enabled: true,  min: 0,   max: 30   },
  flipH: false,
}

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

export function applyReproduceTransforms(
  file: File,
  settings: ReproduceSettings,
  seed: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const rng = seededRng(seed)
      const W = img.naturalWidth
      const H = img.naturalHeight

      // Output always = original W × H (preserves aspect ratio, strips EXIF via canvas)
      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = H
      const ctx = canvas.getContext('2d')!

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
      const rotCompensate = deg !== 0
        ? 1 / (Math.abs(Math.cos(rad)) + Math.abs(Math.sin(rad)) * (H / W))
        : 1

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
      ctx.drawImage(img, srcX, srcY, srcW, srcH, -W / 2, -H / 2, W, H)
      ctx.restore()
      ctx.filter = 'none'

      if (settings.grain.enabled) {
        const grainOpacity = lerp(rng, settings.grain.min, settings.grain.max) / 100
        const grainCanvas = document.createElement('canvas')
        grainCanvas.width = W
        grainCanvas.height = H
        const gc = grainCanvas.getContext('2d')!
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

      canvas.toBlob(b => {
        if (!b) { reject(new Error('Canvas export failed')); return }
        resolve(URL.createObjectURL(b))
      }, 'image/jpeg', 0.92)
    }
    img.onerror = () => reject(new Error('Image load failed'))
    img.src = URL.createObjectURL(file)
  })
}
