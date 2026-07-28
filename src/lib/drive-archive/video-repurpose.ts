import { existsSync, unlinkSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { uploadBuffer } from '@/lib/supabase-storage'
import {
  processVideoVariant,
  getVideoDuration,
  type VideoEffectOpts,
} from '@/lib/video-ffmpeg'
import type { ContentFormat } from './content-format'
import { videoOptsForFormat } from './video-repurpose-profiles'

async function downloadToTemp(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000) })
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength < 1000) throw new Error('download too small')
  const path = join(tmpdir(), `vrp_in_${randomUUID()}.mp4`)
  writeFileSync(path, buf)
  return path
}

/**
 * Apply a format-specific uniqueness pass via ffmpeg and upload to Storage.
 */
export async function repurposeAndUploadVideo(opts: {
  sourceUrl: string
  format: ContentFormat
  storagePath: string
  seed?: number
  effectOpts?: VideoEffectOpts
}): Promise<string> {
  const seed = opts.seed ?? (Math.floor(Math.random() * 0xffffffff) >>> 0)
  const effectOpts = opts.effectOpts ?? videoOptsForFormat(opts.format)
  const inPath = await downloadToTemp(opts.sourceUrl)
  let outPath: string | null = null
  try {
    const fadeDuration = effectOpts.fade
      ? (await getVideoDuration(inPath) ?? undefined)
      : undefined
    outPath = await processVideoVariant(inPath, seed, effectOpts, fadeDuration)
    if (!outPath || !existsSync(outPath)) {
      throw new Error('ffmpeg produced no video output')
    }
    const buf = readFileSync(outPath)
    return uploadBuffer(buf, opts.storagePath, 'video/mp4')
  } finally {
    try { if (existsSync(inPath)) unlinkSync(inPath) } catch { /* ignore */ }
    try { if (outPath && existsSync(outPath)) unlinkSync(outPath) } catch { /* ignore */ }
  }
}

/**
 * Repurpose each video URL with retries. Failed slots are skipped
 * (never returned as originals — ready/ must stay clean).
 */
export async function repurposeVideoUrls(opts: {
  urls: string[]
  format: ContentFormat
  basePath: string
  maxAttempts?: number
}): Promise<{ readyUrls: string[]; skipped: number }> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3)
  const readyUrls: string[] = []
  let skipped = 0

  for (let i = 0; i < opts.urls.length; i++) {
    const src = opts.urls[i]!
    let done = false
    let lastErr: unknown

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const url = await repurposeAndUploadVideo({
          sourceUrl: src,
          format: opts.format,
          storagePath: `${opts.basePath}/ready_${i + 1}.mp4`,
          seed: (Date.now() ^ (i * 2654435761) ^ (attempt * 97)) >>> 0,
        })
        readyUrls.push(url)
        done = true
        break
      } catch (err) {
        lastErr = err
        console.warn(
          `[video-repurpose] slot ${i} attempt ${attempt}/${maxAttempts} failed:`,
          err instanceof Error ? err.message : err,
        )
      }
    }

    if (!done) {
      skipped++
      console.error(
        `[video-repurpose] slot ${i} skipped after ${maxAttempts} attempts — not placing original in ready/:`,
        lastErr,
      )
    }
  }

  return { readyUrls, skipped }
}
