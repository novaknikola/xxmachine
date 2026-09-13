import sharp from 'sharp'
import { uploadBuffer } from '@/lib/supabase-storage'
import {
  KLING_IMAGE_MAX_ASPECT,
  KLING_IMAGE_MAX_BYTES,
  KLING_IMAGE_MIN_SIDE,
  type KlingImageMeta,
} from './kling-client'

const JPEG_TYPE = 'image/jpeg'

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

  if (width < KLING_IMAGE_MIN_SIDE || height < KLING_IMAGE_MIN_SIDE) {
    const scale = Math.max(KLING_IMAGE_MIN_SIDE / width, KLING_IMAGE_MIN_SIDE / height)
    width = Math.max(KLING_IMAGE_MIN_SIDE, Math.round(width * scale))
    height = Math.max(KLING_IMAGE_MIN_SIDE, Math.round(height * scale))
    pipeline = pipeline.resize(width, height, { fit: 'fill' })
    resized = true
  }

  const aspect = width / height
  if (aspect > KLING_IMAGE_MAX_ASPECT) {
    const newWidth = Math.round(height * KLING_IMAGE_MAX_ASPECT)
    const left = Math.max(0, Math.round((width - newWidth) / 2))
    pipeline = pipeline.extract({ left, top: 0, width: newWidth, height })
    width = newWidth
    resized = true
  } else if (aspect < 1 / KLING_IMAGE_MAX_ASPECT) {
    const newHeight = Math.round(width * KLING_IMAGE_MAX_ASPECT)
    const top = Math.max(0, Math.round((height - newHeight) / 2))
    pipeline = pipeline.extract({ left: 0, top, width, height: newHeight })
    height = newHeight
    resized = true
  }

  let quality = 90
  let output = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer()
  while (output.byteLength > KLING_IMAGE_MAX_BYTES && quality > 50) {
    quality -= 10
    output = await sharp(output).jpeg({ quality, mozjpeg: true }).toBuffer()
    resized = true
  }
  if (output.byteLength > KLING_IMAGE_MAX_BYTES) {
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
