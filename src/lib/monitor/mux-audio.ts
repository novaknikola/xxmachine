import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, unlinkSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { uploadBuffer } from '@/lib/supabase-storage'

const execFileAsync = promisify(execFile)

async function downloadToPath(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength < 1000) throw new Error('download too small')
  writeFileSync(dest, buf)
}

async function hasAudioStream(path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_streams', path,
    ], { timeout: 20_000 })
    const json = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string }> }
    return (json.streams ?? []).some(s => s.codec_type === 'audio')
  } catch {
    return false
  }
}

export interface MuxSourceAudioResult {
  /** Final video URL (muxed, or original if skipped). */
  url: string
  /** Set when we kept the silent generated video. */
  skippedReason?: string
}

/**
 * Replace the generated clip's audio with the original reel track.
 * Hard-fails on ffmpeg/upload errors so callers know audio did not attach.
 */
export async function muxSourceAudioOntoVideo(opts: {
  generatedVideoUrl: string
  sourceVideoUrl: string
  storagePath: string
}): Promise<MuxSourceAudioResult> {
  const id = randomUUID()
  const genPath = join(tmpdir(), `mux_gen_${id}.mp4`)
  const srcPath = join(tmpdir(), `mux_src_${id}.mp4`)
  const outPath = join(tmpdir(), `mux_out_${id}.mp4`)

  try {
    await downloadToPath(opts.generatedVideoUrl, genPath)
    await downloadToPath(opts.sourceVideoUrl, srcPath)

    if (!(await hasAudioStream(srcPath))) {
      return {
        url: opts.generatedVideoUrl,
        skippedReason: 'Source video has no audio track — kept silent output',
      }
    }

    await execFileAsync('ffmpeg', [
      '-y',
      '-i', genPath,
      '-i', srcPath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-shortest',
      '-movflags', '+faststart',
      outPath,
    ], { maxBuffer: 40_000_000, timeout: 120_000 })

    if (!existsSync(outPath)) throw new Error('ffmpeg produced no muxed file')

    const url = await uploadBuffer(readFileSync(outPath), opts.storagePath, 'video/mp4')
    return { url }
  } finally {
    for (const p of [genPath, srcPath, outPath]) {
      try { if (existsSync(p)) unlinkSync(p) } catch { /* ignore */ }
    }
  }
}
