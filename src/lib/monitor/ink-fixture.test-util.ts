/**
 * A synthetic "tattooed source person" for the Wan reference tests: a skin-tone
 * subject with blue ink line work and a thin inked "finger", moving across a
 * grey animated scene, plus what WaveSpeed's background remover would make of
 * it. Blue ink on an otherwise colourless frame makes "did the source person's
 * marks get through?" a pixel count instead of a judgement call.
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export const FIXTURE = { width: 360, height: 640, fps: 24, seconds: 2 } as const

/** Subject box: 120×240, top at y=240, left edge at 40 + 80·t px; a 2px inked
 * finger sticks 40px out of its right side at y+100. */
export const SUBJECT = { w: 120, h: 240, y: 240, x0: 40, speed: 80 } as const
export const subjectX = (t: number) => SUBJECT.x0 + SUBJECT.speed * t

const SKIN = '0xD09878'
const INK = '0x1E28AA'
const { width: W, height: H, fps: FPS, seconds: D } = FIXTURE

const skin = `color=c=${SKIN}:s=${SUBJECT.w}x${SUBJECT.h}:r=${FPS}:d=${D}`
const FINGER = 40
/** RGBA: the inked subject, transparent around the finger. */
const inked = [
  `color=c=${SKIN}:s=${SUBJECT.w + FINGER}x${SUBJECT.h}:r=${FPS}:d=${D}`,
  `drawbox=x=${SUBJECT.w}:y=0:w=${FINGER}:h=${SUBJECT.h}:color=black:t=fill`,
  ...[40, 58, 76].map(x => `drawbox=x=${x}:y=50:w=3:h=140:color=${INK}:t=fill`),
  `drawbox=x=36:y=110:w=48:h=4:color=${INK}:t=fill`,
  `drawbox=x=${SUBJECT.w}:y=100:w=${FINGER}:h=2:color=${INK}:t=fill`,
  'format=rgba,colorkey=0x000000:0.01:0',
].join(',')
const scene = `testsrc2=s=${W}x${H}:r=${FPS}:d=${D},hue=s=0`
const placeAt = (speed: number) => `overlay=x='${SUBJECT.x0}+${speed}*t':y=${SUBJECT.y}`

function ffmpeg(args: string[]) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args])
}

export interface InkFixtures {
  /** The source reel: inked subject over the scene, with a sound track. */
  source: string
  /** The same scene with nobody in it — where the subject is, by difference. */
  sceneOnly: string
  /** Remover output as a composite: the subject over pure key green. */
  matte: string
  /** Remover output as an alpha video: the subject on a transparent background. */
  alphaMatte: string
  /** A remover output that found nobody. */
  emptyMatte: string
  /** Character reference / characterized still: clean skin, no ink. */
  cleanImage: string
}

/** `speed` in px/s; only the default matches SUBJECT and subjectX. */
export function renderInkFixtures(dir: string, speed: number = SUBJECT.speed): InkFixtures {
  const place = placeAt(speed)
  const f: InkFixtures = {
    source: join(dir, 'source.mp4'),
    sceneOnly: join(dir, 'scene.mp4'),
    matte: join(dir, 'matte.mp4'),
    alphaMatte: join(dir, 'matte-alpha.mov'),
    emptyMatte: join(dir, 'matte-empty.mp4'),
    cleanImage: join(dir, 'clean.jpg'),
  }
  const h264 = ['-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p']
  ffmpeg(['-filter_complex', `${scene}[bg];${inked}[s];[bg][s]${place}[v];sine=frequency=330:duration=${D}[a]`,
    '-map', '[v]', '-map', '[a]', ...h264, '-c:a', 'aac', f.source])
  ffmpeg(['-filter_complex', `${scene}[v]`, '-map', '[v]', ...h264, f.sceneOnly])
  ffmpeg(['-filter_complex', `color=c=0x00FF00:s=${W}x${H}:r=${FPS}:d=${D}[g];${inked}[s];[g][s]${place}[v]`,
    '-map', '[v]', ...h264, f.matte])
  // Overlaid in yuv like the source, so the subject lands on the same (even) pixel grid.
  ffmpeg(['-filter_complex', `color=c=black@0:s=${W}x${H}:r=${FPS}:d=${D},format=yuva420p[g];${inked}[s];[g][s]${place}[v]`,
    '-map', '[v]', '-c:v', 'png', '-pix_fmt', 'rgba', f.alphaMatte])
  ffmpeg(['-f', 'lavfi', '-i', `color=c=0x00FF00:s=${W}x${H}:r=${FPS}:d=${D}`, ...h264, f.emptyMatte])
  ffmpeg(['-filter_complex', `${scene}[bg];${skin}[s];[bg][s]overlay=x=120:y=${SUBJECT.y}`, '-frames:v', '1', '-q:v', '2', f.cleanImage])
  return f
}

export interface RgbFrames {
  width: number
  height: number
  frames: Buffer[]
}

/** Every frame of a video (or the one frame of an image), decoded to rgb24 at its own size. */
export function readRgbFrames(source: string): RgbFrames {
  const [width, height] = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', source,
  ]).toString().trim().split(',').map(Number)
  const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', source, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    maxBuffer: 512 * 1024 * 1024,
  })
  const size = width * height * 3
  const frames: Buffer[] = []
  for (let o = 0; o + size <= raw.length; o += size) frames.push(raw.subarray(o, o + size))
  return { width, height, frames }
}

/** Pixels whose blue clearly dominates — the fixture's ink, and nothing else in it. */
export function inkPixels(frame: Buffer): number {
  let n = 0
  for (let i = 0; i < frame.length; i += 3) {
    const r = frame[i], g = frame[i + 1], b = frame[i + 2]
    if (b - Math.max(r, g) > 60) n++
  }
  return n
}

/** Ink pixels over a whole video or image. */
export function inkIn(source: string): number {
  return readRgbFrames(source).frames.reduce((n, f) => n + inkPixels(f), 0)
}

/** Probed frame count, duration and audio of a video, for "timing unchanged" checks. */
export function streamFacts(source: string) {
  const out = (args: string[]) => execFileSync('ffprobe', ['-v', 'error', ...args, source]).toString().trim()
  return {
    frames: Number(out(['-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0'])),
    fps: out(['-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0']),
    duration: Number(out(['-show_entries', 'format=duration', '-of', 'csv=p=0'])),
    audio: out(['-select_streams', 'a', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0']),
  }
}
