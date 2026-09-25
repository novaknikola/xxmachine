/**
 * Instagram serves a reel as separate DASH tracks, and Apify's `videoUrl` is the
 * VIDEO-ONLY track (VP9, no audio stream) with the sound in a sibling `audioUrl`.
 * Anything that took `videoUrl` alone got a silent clip — confirmed live
 * 2026-09-24: a Wan 3.0 Copy-Paste run had no source audio and invented its own
 * speech (audible as mumbling). These helpers detect that and rejoin the tracks.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { writeFile, readFile, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { uploadBuffer } from '@/lib/supabase-storage'

const execFileAsync = promisify(execFile)

const PROBE_TIMEOUT_MS = 25_000
const DOWNLOAD_TIMEOUT_MS = 60_000
const MUX_TIMEOUT_MS = 60_000
const MAX_TRACK_BYTES = 150 * 1024 * 1024
/** Below this a "track" is an error page, not media. */
const MIN_TRACK_BYTES = 1_000

/** Only definite answers are remembered — a failed probe should be retried. */
const audioMemo = new Map<string, boolean>()
const MEMO_MAX = 300

/**
 * Does this file/URL carry an audio stream? `null` when it could not be probed
 * (expired link, network error) — callers treat that as "unknown", never as
 * "silent", so a probe failure can't block a reel that would have worked.
 */
export async function videoHasAudio(source: string): Promise<boolean | null> {
  const known = audioMemo.get(source)
  if (known !== undefined) return known
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', source],
      { timeout: PROBE_TIMEOUT_MS },
    )
    const has = stdout.trim().length > 0
    if (audioMemo.size >= MEMO_MAX) audioMemo.delete(audioMemo.keys().next().value as string)
    audioMemo.set(source, has)
    return has
  } catch {
    return null
  }
}

/** Stream-copies one video track and one audio track into a single mp4. */
export async function muxTracks(videoPath: string, audioPath: string, outPath: string): Promise<void> {
  await execFileAsync(
    'ffmpeg',
    [
      '-y', '-v', 'error',
      '-i', videoPath, '-i', audioPath,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c', 'copy', '-movflags', '+faststart', '-shortest',
      outPath,
    ],
    { timeout: MUX_TIMEOUT_MS },
  )
}

async function downloadTrack(url: string, path: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`track fetch failed: ${res.status}`)
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > MAX_TRACK_BYTES) throw new Error(`track too large: ${declared} bytes`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength < MIN_TRACK_BYTES) throw new Error('track download too small to be media')
  if (buf.byteLength > MAX_TRACK_BYTES) throw new Error('track too large')
  await writeFile(path, buf)
}

/** Downloads both tracks, joins them, and returns a public URL of the result. */
export async function muxAudioIntoVideo(videoUrl: string, audioUrl: string): Promise<string> {
  const id = randomUUID()
  const dir = tmpdir()
  const v = join(dir, `mux_v_${id}.bin`)
  const a = join(dir, `mux_a_${id}.bin`)
  const out = join(dir, `mux_out_${id}.mp4`)
  try {
    await Promise.all([downloadTrack(videoUrl, v), downloadTrack(audioUrl, a)])
    await muxTracks(v, a, out)
    return await uploadBuffer(await readFile(out), `monitor/audio-mux/${id}.mp4`, 'video/mp4')
  } finally {
    await Promise.all([v, a, out].map(p => unlink(p).catch(() => {})))
  }
}

/**
 * The URL to actually use for a reel: the original when it already has sound
 * (or can't be probed), otherwise the video re-joined with its audio track.
 * Never throws — a failed join falls back to the original URL, i.e. exactly the
 * pre-fix behaviour, so it can only ever improve on what used to happen.
 */
export async function ensureVideoHasAudio(
  videoUrl: string,
  audioUrl: string | null | undefined,
): Promise<string> {
  if (!audioUrl) return videoUrl
  if ((await videoHasAudio(videoUrl)) !== false) return videoUrl
  try {
    return await muxAudioIntoVideo(videoUrl, audioUrl)
  } catch (err) {
    console.warn('[video-audio] could not re-join audio track:', err instanceof Error ? err.message : err)
    return videoUrl
  }
}
