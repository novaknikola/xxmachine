import sharp from 'sharp'
import { uploadBuffer } from '@/lib/supabase-storage'

const JPEG_TYPE = 'image/jpeg'

/**
 * These constraints were originally Kling 3.0's own limits; kept as-is for
 * the character-still prep step even after the Seedance swap (see plan doc)
 * since they're a reasonably conservative, already-battle-tested target and
 * Seedance's own image-input limits aren't documented precisely enough here
 * to safely replace them with different numbers.
 */
const IMAGE_MAX_BYTES = 10 * 1024 * 1024
const IMAGE_MIN_SIDE = 300
const IMAGE_MAX_ASPECT = 2.5

export interface KlingImageMeta {
  contentType?: string | null
  byteLength?: number | null
  width?: number | null
  height?: number | null
}

export interface PreparedKlingImage {
  url: string
  meta: KlingImageMeta
  resized: boolean
}

/**
 * Download a character still and force it into Kling 3.0 i2v constraints:
 * jpg/png, ≤10MB, ≥300px each side, aspect between 1:2.5 and 2.5:1.
 * Upscales, crops extreme aspect, and recompresses rather than sending a
 * still WaveSpeed would reject.
 */
export async function prepareKlingImage(
  imageUrl: string,
  storagePath: string,
): Promise<PreparedKlingImage> {
  const res = await fetch(imageUrl, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`Failed to download character still (${res.status})`)
  const input = Buffer.from(await res.arrayBuffer())
  if (!input.byteLength) throw new Error('Character still is empty')

  let pipeline = sharp(input, { failOn: 'none' }).rotate()
  const meta = await pipeline.metadata()
  let width = meta.width ?? 0
  let height = meta.height ?? 0
  if (!width || !height) throw new Error('Could not read character still dimensions')

  let resized = false

  if (width < IMAGE_MIN_SIDE || height < IMAGE_MIN_SIDE) {
    const scale = Math.max(IMAGE_MIN_SIDE / width, IMAGE_MIN_SIDE / height)
    width = Math.max(IMAGE_MIN_SIDE, Math.round(width * scale))
    height = Math.max(IMAGE_MIN_SIDE, Math.round(height * scale))
    pipeline = pipeline.resize(width, height, { fit: 'fill' })
    resized = true
  }

  const aspect = width / height
  if (aspect > IMAGE_MAX_ASPECT) {
    const newWidth = Math.round(height * IMAGE_MAX_ASPECT)
    const left = Math.max(0, Math.round((width - newWidth) / 2))
    pipeline = pipeline.extract({ left, top: 0, width: newWidth, height })
    width = newWidth
    resized = true
  } else if (aspect < 1 / IMAGE_MAX_ASPECT) {
    const newHeight = Math.round(width * IMAGE_MAX_ASPECT)
    const top = Math.max(0, Math.round((height - newHeight) / 2))
    pipeline = pipeline.extract({ left: 0, top, width, height: newHeight })
    height = newHeight
    resized = true
  }

  let quality = 90
  let output = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer()
  while (output.byteLength > IMAGE_MAX_BYTES && quality > 50) {
    quality -= 10
    output = await sharp(output).jpeg({ quality, mozjpeg: true }).toBuffer()
    resized = true
  }
  if (output.byteLength > IMAGE_MAX_BYTES) {
    throw new Error('Character still is still over 10MB after recompress')
  }

  const finalMeta = await sharp(output).metadata()
  const prepared: KlingImageMeta = {
    contentType: JPEG_TYPE,
    byteLength: output.byteLength,
    width: finalMeta.width ?? width,
    height: finalMeta.height ?? height,
  }

  const url = resized || !/\.jpe?g(\?|$)/i.test(imageUrl)
    ? await uploadBuffer(output, storagePath, JPEG_TYPE)
    : imageUrl

  return { url, meta: prepared, resized }
}
