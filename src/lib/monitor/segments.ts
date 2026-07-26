import { execFile } from 'child_process'
import { promisify } from 'util'
import { writeFileSync, existsSync, unlinkSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { uploadBuffer } from '@/lib/supabase-storage'

const execFileAsync = promisify(execFile)

/**
 * Shots shorter than this are folded into the neighbouring one. A quarter-second
 * flash is a transition artefact, not a shot, and no video model can produce it.
 */
const MIN_SEGMENT_SECONDS = 0.8
/**
 * Kling motion-control rejects reference clips shorter than 3s. We target 3.5s
 * so re-encoding / keyframe snap cannot land just under the hard floor.
 */
export const MIN_MOTION_REF_SECONDS = 3.5
/** Cost ceiling: every segment is a separate paid generation. */
export const MAX_SEGMENTS = 6
const TARGET_WIDTH = 1080
const TARGET_HEIGHT = 1920
const TARGET_FPS = 30
const MAX_VIDEO_BYTES = 60_000_000

export interface SourceSegment {
  index: number
  start: number
  end: number
  duration: number
}

/**
 * Turns cut positions into the shot list to reproduce. Cuts that would leave a
 * sliver at either end are dropped rather than emitted as unusable segments.
 */
export function planSegments(cutTimes: number[], duration: number): SourceSegment[] {
  if (!Number.isFinite(duration) || duration <= 0) return []

  const boundaries = [0]
  for (const t of [...cutTimes].sort((a, b) => a - b)) {
    if (!Number.isFinite(t)) continue
    if (t - boundaries[boundaries.length - 1] < MIN_SEGMENT_SECONDS) continue
    if (duration - t < MIN_SEGMENT_SECONDS) continue
    boundaries.push(t)
  }
  boundaries.push(duration)

  const segments: SourceSegment[] = []
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i]
    const end = boundaries[i + 1]
    segments.push({
      index: segments.length,
      start,
      end,
      duration: Number((end - start).toFixed(3)),
    })
  }
  return segments
}

/**
 * Merges adjacent shots until each meets the motion-control minimum length.
 * Prefer merging a short shot into the previous one so later cuts keep their
 * start times when possible.
 */
export function enforceMinSegmentDuration(
  segments: SourceSegment[],
  minSeconds = MIN_MOTION_REF_SECONDS,
): SourceSegment[] {
  if (segments.length <= 1) return segments.map((s, i) => ({ ...s, index: i }))

  const merged: SourceSegment[] = []
  for (const seg of segments) {
    if (
      merged.length > 0 &&
      (seg.duration < minSeconds || merged[merged.length - 1].duration < minSeconds)
    ) {
      const prev = merged[merged.length - 1]
      const end = seg.end
      const start = prev.start
      merged[merged.length - 1] = {
        index: prev.index,
        start,
        end,
        duration: Number((end - start).toFixed(3)),
      }
    } else {
      merged.push({ ...seg })
    }
  }

  // Trailing short leftover: fold into the previous segment.
  if (merged.length >= 2 && merged[merged.length - 1].duration < minSeconds) {
    const last = merged.pop()!
    const prev = merged[merged.length - 1]
    merged[merged.length - 1] = {
      ...prev,
      end: last.end,
      duration: Number((last.end - prev.start).toFixed(3)),
    }
  }

  return merged.map((s, i) => ({ ...s, index: i }))
}

export interface MotionRefSegment {
  /** Window fed to the motion model (≥ minSeconds when the source allows it). */
  reference: SourceSegment
  /** Original shot length — used when trimming the generated clip for stitch. */
  trim: SourceSegment
}

/**
 * Expands each shot's reference window to satisfy Kling's ≥3s rule by borrowing
 * neighbouring frames, while keeping the stitch trim on the true cut boundaries.
 * Shots that still cannot reach the floor (source shorter than the floor) are
 * left as-is for the caller to collapse.
 */
export function expandRefsForMotion(
  segments: SourceSegment[],
  totalDuration: number,
  minSeconds = MIN_MOTION_REF_SECONDS,
): MotionRefSegment[] {
  return segments.map((trim, i) => {
    if (trim.duration >= minSeconds || totalDuration < minSeconds) {
      return {
        reference: { ...trim, index: i },
        trim: { ...trim, index: i },
      }
    }

    const need = minSeconds - trim.duration
    let start = trim.start
    let end = trim.end

    // Prefer borrowing from the side that has more room.
    const roomBefore = start
    const roomAfter = Math.max(0, totalDuration - end)
    let takeBefore = Math.min(roomBefore, need / 2)
    let takeAfter = Math.min(roomAfter, need - takeBefore)
    if (takeBefore + takeAfter < need) {
      takeBefore = Math.min(roomBefore, need - takeAfter)
    }

    start = Number((start - takeBefore).toFixed(3))
    end = Number((end + takeAfter).toFixed(3))

    return {
      reference: {
        index: i,
        start,
        end,
        duration: Number((end - start).toFixed(3)),
      },
      trim: { ...trim, index: i },
    }
  })
}

export async function downloadToFile(url: string, path: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url.slice(0, 80)}`)

  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.byteLength === 0) throw new Error('Downloaded file is empty')
  if (buffer.byteLength > MAX_VIDEO_BYTES) throw new Error('Downloaded file too large')

  writeFileSync(path, buffer)
}

/**
 * Cuts the source into its shots and publishes each one, because the motion
 * model reads its reference over HTTP rather than accepting an upload.
 *
 * Segments are re-encoded instead of stream-copied: a copy can only cut on
 * keyframes, which would drift the boundaries away from the detected cuts.
 */
export async function splitAndUploadSegments(
  sourcePath: string,
  segments: SourceSegment[],
  storagePrefix: string,
): Promise<string[]> {
  const urls: string[] = []

  for (const segment of segments) {
    const partPath = join(tmpdir(), `mon_seg_${randomUUID()}.mp4`)
    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-ss', segment.start.toFixed(3),
        '-i', sourcePath,
        '-t', segment.duration.toFixed(3),
        '-an',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        partPath,
      ], { maxBuffer: 20_000_000 })

      if (!existsSync(partPath)) throw new Error(`Segment ${segment.index} produced no file`)
      const url = await uploadBuffer(
        readFileSync(partPath),
        `${storagePrefix}/src_${segment.index + 1}.mp4`,
        'video/mp4',
      )
      urls.push(url)
    } finally {
      try { if (existsSync(partPath)) unlinkSync(partPath) } catch {}
    }
  }

  return urls
}

/**
 * Builds one filter graph that trims every generated clip back to the length of
 * the shot it replaces, normalises them to identical geometry, and concatenates
 * them. Normalising is what makes concat safe — the clips come back from the
 * model at whatever size and frame rate it chose.
 */
function buildConcatFilter(count: number, durations: number[]): string {
  const parts: string[] = []
  for (let i = 0; i < count; i++) {
    parts.push(
      `[${i}:v]trim=0:${durations[i].toFixed(3)},setpts=PTS-STARTPTS,` +
      `scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=increase,` +
      `crop=${TARGET_WIDTH}:${TARGET_HEIGHT},fps=${TARGET_FPS},setsar=1[v${i}]`,
    )
  }
  parts.push(
    `${Array.from({ length: count }, (_, i) => `[v${i}]`).join('')}concat=n=${count}:v=1:a=0[out]`,
  )
  return parts.join(';')
}

export interface StitchInput {
  /** Generated clips in shot order. */
  clipPaths: string[]
  /** Source shots, used to trim each clip back to the original rhythm. */
  segments: SourceSegment[]
  /** Original reel, used only for its audio track. */
  audioSourcePath?: string | null
  outputPath: string
}

/**
 * The generated clips come back at the model's fixed lengths (5s or 10s) while
 * the shots they replace are often 1-3s, so each is trimmed back before joining.
 * The original audio is laid over the result — for a Reel the sound is usually
 * the whole point, and generated clips carry none.
 */
export async function stitchSegments(input: StitchInput): Promise<void> {
  const { clipPaths, segments, audioSourcePath, outputPath } = input
  if (clipPaths.length === 0) throw new Error('Nothing to stitch')
  if (clipPaths.length !== segments.length) {
    throw new Error(`Have ${clipPaths.length} clips for ${segments.length} segments`)
  }

  const durations = segments.map(s => s.duration)
  const withAudio = Boolean(audioSourcePath && existsSync(audioSourcePath))

  const args = ['-y']
  for (const path of clipPaths) args.push('-i', path)
  if (withAudio) args.push('-i', audioSourcePath!)

  args.push('-filter_complex', buildConcatFilter(clipPaths.length, durations))
  args.push('-map', '[out]')
  if (withAudio) {
    args.push('-map', `${clipPaths.length}:a?`, '-c:a', 'aac', '-b:a', '128k', '-shortest')
  }
  args.push(
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
    '-pix_fmt', 'yuv420p', '-map_metadata', '-1', '-movflags', '+faststart',
    outputPath,
  )

  await execFileAsync('ffmpeg', args, { maxBuffer: 40_000_000 })
  if (!existsSync(outputPath)) throw new Error('Stitching produced no output file')
}
