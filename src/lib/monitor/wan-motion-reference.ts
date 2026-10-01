/**
 * The source reel as Wan 3.0 gets it: motion, pose, camera, framing, timing and
 * sound — never the source person's look.
 *
 * Wan 3.0 reference-to-video has no reference weight and no negative prompt,
 * and it edits the reference video rather than just reading motion from it. Sent
 * raw, the reel was the only reference showing the source person, in every
 * frame — so whatever the scene still did not cover (an arm raised later, a
 * turn) was taken from her: tattoos, piercings, makeup, jewellery, however clean
 * the character photo and the still were. No prompt wording removes pixels.
 *
 * So the person is scrubbed before Wan sees her. WaveSpeed's background remover
 * paints everything that is not her in key green; that matte marks her pixels,
 * and ffmpeg replaces exactly those with a grey, blurred copy of themselves.
 * Silhouette, pose and movement survive; marks on her skin, her colouring and
 * small accessories do not. Everything outside the matte passes through as is.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { uploadBuffer } from '@/lib/supabase-storage'
import { API_V3, pollV3 } from './replicate'
import { downloadTrack } from './video-audio'

const execFileAsync = promisify(execFile)

export const SUBJECT_MATTE_MODEL = 'wavespeed-ai/video-background-remover'

/** Background the remover paints behind the subject: everything this colour is "not her". */
export const MATTE_KEY_COLOR = '0x00FF00'
/** Catches the key green after the remover's own encode, not green clothes. */
const KEY_SIMILARITY = 0.15
const KEY_BLEND = 0.05

/** Subject blur as a share of frame height: wipes line work, piercings and small
 * marks, keeps limbs, head and body shape readable. */
const FILL_BLUR = 0.015
/** Mask growth as a share of frame height. Grown, not just blurred: a blurred
 * mask only half-covers a part thinner than its blur (a tattooed finger). */
const MASK_GROW = 0.005
/** Soft falloff outside the grown mask, as a share of frame height. */
const MASK_FEATHER = 0.01
/** Keyed alpha above this (of 255) counts as her — soft edges and spill included. */
const SUBJECT_ALPHA = 25

/** Height the matte is checked at: one pixel here (0.4% of the frame) is less
 * than the mask growth, so a misalignment too small to see is also covered. */
const CHECK_HEIGHT = 256
/** Frames compared for alignment, spread over the clip. */
const CHECK_FRAMES = 60
/** Below this share of the frame (averaged over the clip) the matte found nobody. */
export const MIN_SUBJECT_COVERAGE = 0.01
/** A composite on our key image always shows some key green. Without it the
 * background was not replaced as asked, and the matte says nothing about her. */
const MIN_KEY_BACKGROUND = 0.005
/**
 * Alignment is judged on structure, not colour: inside her, the matte's luma is
 * correlated with the reel's at the same place and frame, and at 1–2px and
 * one frame either side. A matte that lines up correlates best where it is.
 * Colour is useless here — the remover may relight her or bleed green into her
 * edges ("blending that accounts for lighting"), and correlation ignores both.
 * Calibrated 2026-10-01: aligned mattes (incl. relit, half-size, soft-edged)
 * lose to a neighbour in ≤0.6% of frames at a median correlation ≥0.99; one
 * frame late, 4–16px shifted or letterboxed mattes lose in 53–100%, or
 * correlate below 0.9.
 */
const MAX_MISALIGNED_FRAMES = 0.25
const MIN_CORRELATION = 0.9
/** A neighbour beats the matte's own position only by more than this. */
const CORRELATION_TIE = 0.01
/** Checked frames needed before alignment counts as verified. */
const MIN_CHECKED_FRAMES = 3

const MATTE_POLL_ATTEMPTS = 120  // pollV3's 5s interval × 120 = 10 min
const MATTE_ABORT_MS = 600_000
const FFMPEG_TIMEOUT_MS = 300_000

function ff(cmd: 'ffmpeg' | 'ffprobe', args: string[]) {
  return execFileAsync(cmd, args, {
    timeout: FFMPEG_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    // The check holds a whole clip decoded small: ~50MB for a 15s 9:16 reel at
    // 60fps, ~300MB for the same in 16:9. A cap is a refusal, not a leak.
    maxBuffer: 1024 * 1024 * 1024,
    encoding: 'buffer',
  })
}

export interface VideoGeometry {
  /** Size of the decoded (auto-rotated) frames. */
  width: number
  height: number
  /** ffmpeg rate, e.g. '30/1' or '30000/1001'. */
  fps: string
  /** Where the video starts inside its file (after an audio-first start), seconds. */
  start: number
}

/** Size after rotation (decodes one frame rather than trusting stream tags), rate and start. */
export async function probeGeometry(path: string): Promise<VideoGeometry> {
  const { stdout: frame } = await ff('ffmpeg', ['-v', 'error', '-i', path, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-'])
  const width = frame.readUInt32BE(16)
  const height = frame.readUInt32BE(20)
  const { stdout } = await ff('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=avg_frame_rate,r_frame_rate,start_time:format=start_time', '-of', 'json', path,
  ])
  const info = JSON.parse(stdout.toString()) as {
    streams?: { avg_frame_rate?: string; r_frame_rate?: string; start_time?: string }[]
    format?: { start_time?: string }
  }
  const stream = info.streams?.[0] ?? {}
  const avg = stream.avg_frame_rate
  const fps = avg && !avg.startsWith('0/') ? avg : stream.r_frame_rate
  const start = (Number(stream.start_time) || 0) - (Number(info.format?.start_time) || 0)
  if (!width || !height || !fps) throw new Error('Could not read the source video geometry')
  return { width, height, fps, start: Math.max(0, start) }
}

/**
 * Matte frame k is the remover's output for source frame k — that is the only
 * correspondence it promises. Timestamps are not: it may re-time a phone clip's
 * uneven frames to an even rate. So every stream here is re-stamped by frame
 * number on one shared time base, and frame k meets frame k exactly — in the
 * check and in the scrub alike.
 */
function byFrameNumber(fps: string): string {
  const [num, den = '1'] = fps.split('/')
  // fps= on stamps that are already 0,1,2… changes no frame; it only states the
  // rate, so ffmpeg's output stage does not invent one and duplicate frames.
  return `settb=${den}/${num},setpts=N,fps=${fps}`
}

/** The matte laid over key green (so an alpha matte and a composited one read the
 * same), keyed: RGBA, alpha is her. */
function keyedMatte(matte: string, w: number, h: number, fps: string): string {
  return [
    `color=c=${MATTE_KEY_COLOR}:s=${w}x${h}:r=${fps},${byFrameNumber(fps)}[key]`,
    `${matte}${byFrameNumber(fps)},scale=${w}:${h},format=rgba[matte]`,
    `[key][matte]overlay=shortest=1:format=rgb,format=rgba,colorkey=${MATTE_KEY_COLOR}:${KEY_SIMILARITY}:${KEY_BLEND}`,
  ].join(';')
}

/**
 * The scrub as one filter graph: input 0 is the source, input 1 the matte.
 * Formats are pinned to yuv420p on purpose — left to negotiation, the alpha
 * branch pulls the whole frame through RGB and the background drifts too.
 */
export function subjectScrubFilter(g: VideoGeometry, frames: number): string {
  const fill = Math.max(2, Math.round(g.height * FILL_BLUR))
  const grow = Math.max(1, Math.round(g.height * MASK_GROW))
  const feather = Math.max(1, Math.round(g.height * MASK_FEATHER))
  return [
    `${keyedMatte('[1:v]', g.width, g.height, g.fps)},alphaextract,format=gray,` +
      `lut=c0='if(gt(val,${SUBJECT_ALPHA}),255,0)',${Array(grow).fill('dilation').join(',')},split[hard][soft]`,
    `[soft]gblur=sigma=${feather}[falloff]`,
    `[hard][falloff]blend=all_mode=lighten[mask]`,
    `[0:v]${byFrameNumber(g.fps)},format=yuv420p,split[scene][subject]`,
    `[subject]hue=s=0,gblur=sigma=${fill},format=yuv420p[fill]`,
    `[fill][mask]alphamerge,format=yuva420p[scrubbed]`,
    // Exactly the source's frames, back where the video started in its file, so
    // the copied audio stays in sync.
    `[scene][scrubbed]overlay=eof_action=repeat:format=yuv420,trim=end_frame=${frames},setpts=PTS+${g.start}/TB,` +
      `crop=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p[v]`,
  ].join(';')
}

export interface MatteCheck {
  sourceFrames: number
  matteFrames: number
  /** Average share of the frame that is her. */
  coverage: number
  /** Average share of the frame that is key green. */
  keyBackground: number
  /** Frames where enough of her shows to judge alignment. */
  checkedFrames: number
  /** Share of those where a shifted position matched better than her own. */
  misaligned: number
  /** Median correlation at her own position. */
  correlation: number
}

/** Offsets the matte is also tried at: [frames, x, y] — 1–2px, and a frame either side. */
const NEIGHBOURS: [number, number, number][] = [
  [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [0, -2, 0], [0, 2, 0], [0, 0, -2], [0, 0, 2],
  [0, -1, -1], [0, 1, -1], [0, -1, 1], [0, 1, 1], [-1, 0, 0], [1, 0, 0],
]
const EDGE = 2

/**
 * Does the matte actually describe this reel? Both are decoded small and paired
 * by frame number, exactly as the scrub pairs them. The matte must have every
 * frame, show key green behind her, and line up with the reel where she is.
 * Nothing about the remover's output format, size, rate or timing is taken on trust.
 */
export async function checkMatte(sourcePath: string, mattePath: string, g: VideoGeometry): Promise<MatteCheck> {
  const h = CHECK_HEIGHT
  const w = Math.max(2, Math.round((h * g.width) / g.height / 2) * 2)
  const [{ stdout: src }, { stdout: matte }] = await Promise.all([
    ff('ffmpeg', ['-v', 'error', '-i', sourcePath, '-vf', `${byFrameNumber(g.fps)},scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-']),
    ff('ffmpeg', [
      '-v', 'error', '-i', mattePath, '-filter_complex', `${keyedMatte('[0:v]', w, h, g.fps)},format=ya8[m]`,
      '-map', '[m]', '-f', 'rawvideo', '-pix_fmt', 'ya8', '-',
    ]),
  ])
  const px = w * h
  const sourceFrames = Math.floor(src.length / px)
  const matteFrames = Math.floor(matte.length / (px * 2))
  const frames = Math.min(sourceFrames, matteFrames)

  let coverage = 0
  let keyBackground = 0
  for (let f = 0; f < frames; f++) {
    let her = 0
    let key = 0
    for (let i = 0; i < px; i++) {
      const a = matte[(f * px + i) * 2 + 1]
      if (a > SUBJECT_ALPHA) her++
      else if (a === 0) key++
    }
    coverage += her / px
    keyBackground += key / px
  }

  const correlations: number[] = []
  let misalignedFrames = 0
  const step = Math.max(1, Math.ceil((frames - 2) / CHECK_FRAMES))
  for (let f = 1; f < frames - 1; f += step) {
    const lum = (i: number) => matte[(f * px + i) * 2]
    const alpha = (i: number) => matte[(f * px + i) * 2 + 1]
    // Her interior, away from the remover's blended edge and the frame border.
    const inside: number[] = []
    for (let y = EDGE + 2; y < h - EDGE - 2; y++) {
      for (let x = EDGE + 2; x < w - EDGE - 2; x++) {
        let solid = true
        for (let d = -EDGE; d <= EDGE && solid; d++) {
          if (alpha(y * w + x + d) < 250 || alpha((y + d) * w + x) < 250) solid = false
        }
        if (solid) inside.push(y * w + x)
      }
    }
    if (inside.length < 200) continue
    let mean = 0
    for (const i of inside) mean += lum(i)
    mean /= inside.length
    let spread = 0
    for (const i of inside) spread += (lum(i) - mean) ** 2
    if (spread / inside.length < 4) continue // featureless: nothing to align on

    const correlate = (df: number, dx: number, dy: number) => {
      const base = (f + df) * px + dy * w + dx
      let sMean = 0
      for (const i of inside) sMean += src[base + i]
      sMean /= inside.length
      let cov = 0
      let sSpread = 0
      for (const i of inside) {
        const s = src[base + i] - sMean
        cov += (lum(i) - mean) * s
        sSpread += s * s
      }
      return sSpread > 0 ? cov / Math.sqrt(spread * sSpread) : 0
    }
    const own = correlate(0, 0, 0)
    correlations.push(own)
    if (NEIGHBOURS.some(([df, dx, dy]) => correlate(df, dx, dy) > own + CORRELATION_TIE)) misalignedFrames++
  }
  correlations.sort((a, b) => a - b)
  return {
    sourceFrames,
    matteFrames,
    coverage: frames ? coverage / frames : 0,
    keyBackground: frames ? keyBackground / frames : 0,
    checkedFrames: correlations.length,
    misaligned: correlations.length ? misalignedFrames / correlations.length : 1,
    correlation: correlations.length ? correlations[Math.floor(correlations.length / 2)] : 0,
  }
}

/** Throws unless the matte can be trusted as her mask for every frame of the reel. */
function assertUsableMatte(c: MatteCheck): void {
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`
  const refuse = (why: string) => {
    throw new Error(`Subject matte ${why} — not building a motion reference from it, nothing goes to Wan`)
  }
  // Every frame: a missing one would be scrubbed with its neighbour's mask.
  if (c.matteFrames < c.sourceFrames) refuse(`ends before the reel (${c.matteFrames} of ${c.sourceFrames} frames)`)
  if (c.coverage < MIN_SUBJECT_COVERAGE) refuse(`found no person (${pct(c.coverage)} of the frame)`)
  if (c.keyBackground < MIN_KEY_BACKGROUND) refuse(`has no key-green background (${pct(c.keyBackground)} of the frame)`)
  if (c.checkedFrames < MIN_CHECKED_FRAMES) refuse(`shows too little of her to check it lines up with the reel (${c.checkedFrames} frames)`)
  if (c.misaligned > MAX_MISALIGNED_FRAMES || c.correlation < MIN_CORRELATION) {
    refuse(`does not line up with the reel (matches better shifted in ${pct(c.misaligned)} of frames, correlation ${c.correlation.toFixed(3)})`)
  }
}

/**
 * Writes the scrubbed copy of `sourcePath` to `outPath`. Throws rather than
 * produce anything from a matte that fails checkMatte.
 */
export async function scrubSubjectAppearance(
  sourcePath: string,
  mattePath: string,
  outPath: string,
): Promise<MatteCheck> {
  const g = await probeGeometry(sourcePath)
  const check = await checkMatte(sourcePath, mattePath, g)
  assertUsableMatte(check)
  await ff('ffmpeg', [
    '-y', '-v', 'error',
    '-i', sourcePath, '-i', mattePath,
    '-filter_complex', subjectScrubFilter(g, check.sourceFrames),
    '-map', '[v]', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    '-c:a', 'copy', '-movflags', '+faststart',
    outPath,
  ])
  return check
}

async function requestSubjectMatte(videoUrl: string, backgroundImageUrl: string, apiKey: string): Promise<string> {
  const res = await fetch(`${API_V3}/${SUBJECT_MATTE_MODEL}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ video: videoUrl, background_image: backgroundImageUrl }),
  })
  const data = await res.json()
  if (data.code && data.code !== 200) {
    throw new Error(`Subject matte failed: ${data.message ?? JSON.stringify(data)}`)
  }
  const requestId = data?.data?.id ?? data?.id
  if (!requestId) throw new Error(`No request ID from ${SUBJECT_MATTE_MODEL}`)
  return pollV3(requestId, apiKey, AbortSignal.timeout(MATTE_ABORT_MS), 'Subject matte', MATTE_POLL_ATTEMPTS)
}

/**
 * Source reel → matte (WaveSpeed, ~$0.01/s) → scrub (local ffmpeg) → storage.
 * Returns the public URL of the copy Wan gets as its reference video.
 */
export async function buildMotionReference(opts: {
  jobId: string
  sourceVideoUrl: string
  apiKey: string
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wan-motion-'))
  try {
    const source = join(dir, 'source.mp4')
    const key = join(dir, 'key.png')
    const matte = join(dir, 'matte')
    const out = join(dir, 'motion.mp4')

    await downloadTrack(opts.sourceVideoUrl, source)
    const g = await probeGeometry(source)
    await ff('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${MATTE_KEY_COLOR}:s=${g.width}x${g.height},format=rgb24`, '-frames:v', '1', key])
    const keyUrl = await uploadBuffer(await readFile(key), `monitor/${opts.jobId}/matte-key.png`, 'image/png')

    const matteUrl = await requestSubjectMatte(opts.sourceVideoUrl, keyUrl, opts.apiKey)
    await downloadTrack(matteUrl, matte)
    await scrubSubjectAppearance(source, matte, out)

    // A fresh name per build: a re-uploaded file under the same URL can be served stale.
    return await uploadBuffer(await readFile(out), `monitor/${opts.jobId}/wan-motion-${randomUUID().slice(0, 8)}.mp4`, 'video/mp4')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
