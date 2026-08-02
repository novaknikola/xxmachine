/**
 * Pull a profile's reels and download the videos.
 *
 * Apify is skipped (its listing needs an actor run, and the account's monthly quota
 * is the first thing to blow). Listing comes from the stable-api host, which returns
 * play/like counts but no media URL, so each reel is resolved through the downloader
 * hosts afterwards. Instagram CDN links expire within minutes — resolve and download
 * in the same pass, never list now and fetch later.
 *
 *   npx tsx scripts/fetch-profile-reels.ts <username> [limit] [outDir]
 */
import { config } from 'dotenv'
import { mkdirSync, writeFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'

config({ path: '.env.local' })

const LIST_HOST = 'instagram-scraper-stable-api.p.rapidapi.com'
const CALL_GAP_MS = 1_500

const username = (process.argv[2] || '').replace(/^@/, '').trim()
const limit = Number(process.argv[3] || 30)
const outDir = process.argv[4] || join(process.cwd(), 'tmp-reels', username)

if (!username) {
  console.error('usage: npx tsx scripts/fetch-profile-reels.ts <username> [limit] [outDir]')
  process.exit(1)
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

interface ReelMeta {
  code: string
  views: number
  likes: number
  comments: number
  width: number | null
  height: number | null
}

interface Row extends ReelMeta {
  url: string
  videoUrl: string | null
  file: string | null
  bytes: number | null
  error?: string
}

async function listReels(apiKey: string, want: number): Promise<ReelMeta[]> {
  const out: ReelMeta[] = []
  let token = ''

  while (out.length < want) {
    const body = new URLSearchParams({ username_or_url: username })
    if (token) body.set('pagination_token', token)

    const res = await fetch(`https://${LIST_HOST}/get_ig_user_reels.php`, {
      method: 'POST',
      headers: {
        'x-rapidapi-key': apiKey,
        'x-rapidapi-host': LIST_HOST,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    })
    if (!res.ok) throw new Error(`listing failed: HTTP ${res.status} ${await res.text()}`)

    const data = (await res.json()) as {
      reels?: Array<{ node?: { media?: Record<string, unknown> } }>
      pagination_token?: string
    }
    const page = data.reels ?? []
    if (!page.length) break

    for (const r of page) {
      const m = r.node?.media
      if (!m?.code) continue
      out.push({
        code: String(m.code),
        views: Number(m.play_count ?? m.view_count ?? 0),
        likes: Number(m.like_count ?? 0),
        comments: Number(m.comment_count ?? 0),
        width: m.original_width ? Number(m.original_width) : null,
        height: m.original_height ? Number(m.original_height) : null,
      })
      if (out.length >= want) break
    }

    token = data.pagination_token ?? ''
    if (!token) break
    await sleep(CALL_GAP_MS)
  }

  return out
}

async function download(url: string, dest: string): Promise<number> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength < 10_000) throw new Error(`too small (${buf.byteLength} bytes)`)
  writeFileSync(dest, buf)
  return buf.byteLength
}

async function main() {
  const apiKey = process.env.RAPIDAPI_KEY
  if (!apiKey) throw new Error('RAPIDAPI_KEY missing from .env.local')

  // Lazy: instagram-scrape reads APIFY_API_KEY at module load.
  const { resolveVideoUrlViaRapidApi } = await import('../src/lib/instagram-scrape')

  mkdirSync(outDir, { recursive: true })
  console.log(`listing up to ${limit} reels for @${username} …`)
  const metas = await listReels(apiKey, limit)
  console.log(`  listed ${metas.length}\n`)

  const rows: Row[] = []
  for (const meta of metas) {
    const url = `https://www.instagram.com/reel/${meta.code}/`
    const row: Row = { ...meta, url, videoUrl: null, file: null, bytes: null }
    const dest = join(outDir, `${meta.code}.mp4`)

    if (existsSync(dest) && statSync(dest).size > 10_000) {
      row.file = dest
      row.bytes = statSync(dest).size
    } else {
      try {
        const resolved = await resolveVideoUrlViaRapidApi(url, apiKey)
        row.videoUrl = resolved.videoUrl
        row.bytes = await download(resolved.videoUrl, dest)
        row.file = dest
      } catch (err) {
        row.error = err instanceof Error ? err.message : String(err)
      }
      await sleep(CALL_GAP_MS)
    }

    rows.push(row)
    const mb = row.bytes ? (row.bytes / 1e6).toFixed(2) + ' MB' : '—'
    console.log(
      `  ${row.code.padEnd(13)} ${String(row.views).padStart(9)} views ` +
        `${String(row.likes).padStart(7)} likes ${String(row.comments).padStart(5)} c  ${mb.padStart(9)}` +
        (row.error ? `  ✗ ${row.error.slice(0, 60)}` : ''),
    )
  }

  const indexPath = join(outDir, 'index.json')
  writeFileSync(
    indexPath,
    JSON.stringify({ username, fetchedAt: new Date().toISOString(), rows }, null, 2),
  )

  const ok = rows.filter(r => r.file).length
  console.log(`\n${ok}/${rows.length} downloaded → ${outDir}`)
  console.log(`index → ${indexPath}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
