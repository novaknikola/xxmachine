// Shared caption+thumbnail generation for facebook_queue rows, used both by
// the upload route (already has the file in memory) and by anything that
// discovers rows after the fact — Drive sync, and the one-off backfill
// script — which only has a drive_file_id and has to download first.
import { rows, one, query } from '@/lib/db'
import { getGoogleAccessToken } from '@/lib/google-auth'
import { callGrok, base64ImageContent, GROK_FAST } from '@/lib/grok'
import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import os from 'os'
import fs from 'fs'
import crypto from 'crypto'
import sharp from 'sharp'

const execFileAsync = promisify(execFile)

// Resolved lazily (not as a module-level const) — a standalone script that
// loads .env.local at its own top-level runs that load AFTER this module's
// imports are already evaluated (ESM hoists imports above the loadEnv()
// call textually before it), so a top-level constant here would freeze in
// the fallback path before the env var was ever read. Reading it inside
// the function that actually spawns ffmpeg sidesteps that entirely.
function ffmpegBin(): string {
  return process.env.FFMPEG_PATH || 'C:\\Users\\naeem\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe'
}

const CAPTION_PROMPT = `This is the first frame of a short vertical Reel video for a Facebook Page. Write a short, catchy Facebook caption (1-2 sentences, can include 1-2 relevant emojis, max 2 hashtags) based on what you see in this image. Return ONLY the caption text, nothing else.`

export async function extractFirstFrame(videoPath: string): Promise<Buffer> {
  const framePath = path.join(os.tmpdir(), `fb_frame_${crypto.randomUUID()}.jpg`)
  try {
    await execFileAsync(ffmpegBin(), ['-y', '-i', videoPath, '-vframes', '1', '-q:v', '2', framePath])
    return fs.readFileSync(framePath)
  } finally {
    if (fs.existsSync(framePath)) fs.unlinkSync(framePath)
  }
}

// Small (240px-wide) copy of the frame, inlined as a data URI directly on
// the queue row — no separate serving route needed at this queue size
// (tens of items, not thousands).
export async function makeThumbnailDataUri(frame: Buffer): Promise<string> {
  const resized = await sharp(frame).resize({ width: 240 }).jpeg({ quality: 70 }).toBuffer()
  return `data:image/jpeg;base64,${resized.toString('base64')}`
}

export async function generateCaptionFromFrame(frame: Buffer): Promise<string> {
  try {
    const caption = await callGrok({
      model: GROK_FAST,
      messages: [{ role: 'user', content: [{ type: 'text', text: CAPTION_PROMPT }, base64ImageContent(frame.toString('base64'))] }],
      maxTokens: 200,
      temperature: 0.8,
    })
    return caption.trim()
  } catch (err) {
    console.error('[facebook enrich] caption generation failed:', err)
    return ''
  }
}

async function downloadDriveVideo(driveFileId: string): Promise<Buffer> {
  const accessToken = await getGoogleAccessToken()
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) throw new Error(`Drive download failed: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * Downloads a queue row's video from Drive, extracts its first frame, and
 * fills in whichever of caption/thumbnail_url is still missing — never
 * overwrites a caption someone already typed or a thumbnail already set.
 */
export async function enrichQueueItemFromDrive(itemId: string, driveFileId: string): Promise<void> {
  let videoPath: string | null = null
  try {
    const buffer = await downloadDriveVideo(driveFileId)
    videoPath = path.join(os.tmpdir(), `fb_enrich_${crypto.randomUUID()}.mp4`)
    fs.writeFileSync(videoPath, buffer)

    const frame = await extractFirstFrame(videoPath)
    const [caption, thumbnailUrl] = await Promise.all([
      generateCaptionFromFrame(frame),
      makeThumbnailDataUri(frame),
    ])

    await query(
      `UPDATE facebook_queue SET
         caption = CASE WHEN caption IS NULL OR caption = '' THEN $1 ELSE caption END,
         thumbnail_url = COALESCE(thumbnail_url, $2)
       WHERE id = $3`,
      [caption, thumbnailUrl, itemId],
    )
  } finally {
    if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath)
  }
}

/**
 * Background catch-up for every pending row of a page still missing a
 * caption or thumbnail — e.g. everything Sync Drive just queued. Bounded
 * concurrency so a 60+ video folder doesn't open that many ffmpeg
 * processes / Grok calls at once.
 */
export async function enrichPendingFacebookQueueItems(pageId: string, concurrency = 3): Promise<{ processed: number; failed: number }> {
  const items = await rows<{ id: string; drive_file_id: string }>(
    `SELECT id, drive_file_id FROM facebook_queue
     WHERE page_id=$1 AND status='pending' AND drive_file_id IS NOT NULL
       AND (caption IS NULL OR caption = '' OR thumbnail_url IS NULL)`,
    [pageId],
  )
  let processed = 0
  let failed = 0
  let cursor = 0

  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor++]
      try {
        await enrichQueueItemFromDrive(item.id, item.drive_file_id)
        processed++
      } catch (err) {
        failed++
        console.error('[facebook enrich]', item.id, err instanceof Error ? err.message : err)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  console.log(`[facebook enrich] page ${pageId}: ${processed} enriched, ${failed} failed`)
  return { processed, failed }
}

// Re-exported so callers only need one import for "does this page have
// anything left to enrich" without duplicating the WHERE clause above.
export async function pendingEnrichmentCount(pageId: string): Promise<number> {
  const r = await one<{ count: number }>(
    `SELECT count(*)::int AS count FROM facebook_queue
     WHERE page_id=$1 AND status='pending' AND drive_file_id IS NOT NULL
       AND (caption IS NULL OR caption = '' OR thumbnail_url IS NULL)`,
    [pageId],
  )
  return r?.count ?? 0
}
