/**
 * Media URL → a checked copy in our storage. A provider only finds a reel
 * (reel-source.ts); the file it points at lives on Instagram's CDN behind a
 * signature that expires, so the copy is taken right away and everything after
 * — the still, the matte, Wan — uses ours.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { query } from '@/lib/db'
import { uploadBuffer } from '@/lib/supabase-storage'
import { downloadTrack } from './video-audio'

const execFileAsync = promisify(execFile)
const PROBE_TIMEOUT_MS = 30_000
/** Shorter than this is a broken file, not a reel. */
const MIN_DURATION_S = 0.5

/** The reel was found, but its video could not be fetched or is not a video. */
export class ReelDownloadError extends Error {
  readonly code = 'DOWNLOAD_FAILED' as const
}

/** The video was fetched and checked, but our storage would not take it. */
export class ReelStorageError extends Error {
  readonly code = 'STORAGE_FAILED' as const
}

export interface AcquiredReel {
  /** Our storage URL — what the rest of the pipeline uses. */
  url: string
  /** False when the URL was already ours and only checked. */
  copied: boolean
  durationSec: number
  width: number
  height: number
  hasAudio: boolean
}

export function isOwnStorageUrl(url: string): boolean {
  const base = process.env.SUPABASE_URL ? `${process.env.SUPABASE_URL}/storage/v1/object/public/` : null
  return !!base && url.startsWith(base)
}

async function probeVideo(source: string): Promise<Omit<AcquiredReel, 'url' | 'copied'>> {
  let info: { streams?: { codec_type?: string; width?: number; height?: number }[]; format?: { duration?: string } }
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', source,
    ], { timeout: PROBE_TIMEOUT_MS })
    info = JSON.parse(stdout)
  } catch (err) {
    throw new ReelDownloadError(`not a readable media file (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`)
  }
  const video = info.streams?.find(s => s.codec_type === 'video')
  const durationSec = Number(info.format?.duration)
  if (!video) throw new ReelDownloadError('the file has no video stream')
  if (!(durationSec >= MIN_DURATION_S)) throw new ReelDownloadError(`the video is ${Number.isFinite(durationSec) ? `${durationSec}s` : 'of unknown length'}`)
  return {
    durationSec,
    width: video.width ?? 0,
    height: video.height ?? 0,
    // Reported, not required: some sources carry none, and the caller decides.
    hasAudio: !!info.streams?.some(s => s.codec_type === 'audio'),
  }
}

/**
 * Downloads `mediaUrl`, checks it is a real video, and stores it at
 * `storagePath`. A URL that is already ours (a re-joined audio track, a cached
 * copy, a Telegram upload) is checked but not copied again.
 */
export async function acquireReelVideo(opts: { mediaUrl: string; storagePath: string }): Promise<AcquiredReel> {
  if (isOwnStorageUrl(opts.mediaUrl)) {
    return { url: opts.mediaUrl, copied: false, ...(await probeVideo(opts.mediaUrl)) }
  }
  const dir = await mkdtemp(join(tmpdir(), 'reel-'))
  try {
    const file = join(dir, 'reel.mp4')
    try {
      await downloadTrack(opts.mediaUrl, file)
    } catch (err) {
      throw new ReelDownloadError(err instanceof Error ? err.message : String(err))
    }
    const probe = await probeVideo(file)
    let url: string
    try {
      url = await uploadBuffer(await readFile(file), opts.storagePath, 'video/mp4')
    } catch (err) {
      throw new ReelStorageError(err instanceof Error ? err.message : String(err))
    }
    return { url, copied: true, ...probe }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Points the reel cache at our copy, so the next request for the same reel is
 * answered from storage instead of asking Instagram again. Best effort.
 */
export async function rememberAcquiredReel(userId: string, shortCode: string, storageUrl: string): Promise<void> {
  await query(
    `UPDATE ig_downloader_reels SET video_url = $3, scraped_at = now()
      WHERE user_id = $1 AND lower(shortcode) = lower($2)`,
    [userId, shortCode, storageUrl],
  ).catch(err => console.warn('[reel-download] cache update failed:', err instanceof Error ? err.message : err))
}
