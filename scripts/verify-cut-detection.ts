/**
 * Prints the measured frame distance for every scene-score candidate on real
 * sources, so CUT_CONFIRM_DISTANCE can be calibrated (and re-checked) against
 * evidence instead of guessed.
 *
 *   npx tsx scripts/verify-cut-detection.ts [limit]
 *
 * A distance near 0 means the frames either side look the same — the candidate
 * is camera or subject motion, not an edit. A real cut lands far higher.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
import pg from 'pg'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const ff = promisify(execFile)
const SIZE = 32
const GAP = 0.25

async function tiny(path: string, s: number): Promise<Buffer | null> {
  try {
    const { stdout } = await ff('ffmpeg', [
      '-y', '-ss', Math.max(0, s).toFixed(3), '-i', path, '-vframes', '1',
      '-vf', `scale=${SIZE}:${SIZE}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ], { timeout: 20_000, encoding: 'buffer', maxBuffer: 1_000_000 })
    const b = stdout as unknown as Buffer
    return b.length === SIZE * SIZE * 3 ? b : null
  } catch { return null }
}

function dist(a: Buffer, b: Buffer): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i])
  return s / a.length / 255
}

async function main() {
  const limit = Number(process.argv[2] ?? 6)
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  await c.connect()
  const { rows } = await c.query(
    `select content_url, video_url, source_cut_count, source_duration
       from discovery_items
      where video_url is not null and source_cut_count is not null
      order by source_cut_count desc, discovered_at desc limit $1`,
    [limit],
  )
  await c.end()

  for (const r of rows) {
    const path = join(tmpdir(), `cutcal_${randomUUID()}.mp4`)
    try {
      const res = await fetch(r.video_url)
      if (!res.ok) { console.log(`SKIP (${res.status}) ${r.content_url}`); continue }
      writeFileSync(path, Buffer.from(await res.arrayBuffer()))

      const { stderr } = await ff('ffmpeg', [
        '-i', path, '-vf', "select='gt(scene,0.35)',showinfo", '-f', 'null', '-',
      ], { maxBuffer: 20_000_000, timeout: 60_000 }).catch(e => ({ stderr: String(e.stderr ?? '') }))
      const cands = [...String(stderr).matchAll(/pts_time:([0-9.]+)/g)]
        .map(m => Number(m[1])).filter(Number.isFinite).sort((a, b) => a - b)

      const measured: string[] = []
      for (const t of cands) {
        const [a, b] = await Promise.all([tiny(path, t - GAP), tiny(path, t + GAP)])
        measured.push(a && b ? `${t.toFixed(2)}s=${dist(a, b).toFixed(3)}` : `${t.toFixed(2)}s=?`)
      }
      console.log(
        `${String(r.source_cut_count).padStart(2)} stored | ${String(r.source_duration).slice(0, 5).padEnd(6)}s | ` +
        `${r.content_url}\n     candidates: ${measured.join('  ') || 'none'}`,
      )
    } finally {
      try { unlinkSync(path) } catch {}
    }
  }
}
main().catch(e => { console.error('ERR', e?.message ?? e); process.exit(1) })
