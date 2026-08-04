/**
 * Bulk-archives the WaveSpeed account history: walks the prediction list API,
 * downloads every output file and (optionally) uploads each one into a single
 * Google Drive folder, reusing the Drive connection already stored on the user.
 *
 * WaveSpeed keeps output files ~7 days — the history list still returns months
 * of predictions, but anything older than the retention window answers 403 and
 * is counted as `expired`. Run this regularly so nothing else is lost.
 *
 * Resumable: `.archive-state.json` in the output dir records every URL already
 * downloaded / uploaded / found expired, so re-runs only pick up what is new.
 *
 * Usage:
 *   npx tsx scripts/wavespeed-archive.ts --drive
 *   npx tsx scripts/wavespeed-archive.ts --days=8 --out=D:/wavespeed --drive --zip
 *   npx tsx scripts/wavespeed-archive.ts --dry
 *
 * Options:
 *   --days=N            how far back to walk (default 8; older outputs are gone)
 *   --since=YYYY-MM-DD  explicit start date, overrides --days
 *   --out=DIR           local archive dir (default ./wavespeed-archive)
 *   --no-local          do not keep local copies (Drive only, needs --drive)
 *   --drive             upload every file to Google Drive
 *   --drive-folder=NAME Drive folder name (default "WaveSpeed Archive")
 *   --email=a@b.c       which user's Drive connection to use
 *   --models=a,b        only models whose id contains one of these substrings
 *   --concurrency=N     parallel downloads (default 6)
 *   --limit=N           stop after N files (smoke-testing a new setup)
 *   --zip               Compress-Archive the local dir when done
 *   --dry               report what would be fetched, write nothing
 */

import { mkdirSync, existsSync, writeFileSync, appendFileSync, readFileSync, statSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { config as loadEnv } from 'dotenv'

const scriptDir = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(scriptDir, '..', '.env.local') })

const API = 'https://api.wavespeed.ai/api/v3'
const PAGE_SIZE = 100
const MAX_PAGES = 200
const DOWNLOAD_RETRIES = 2

// ─── args ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const flag = (name: string) => argv.includes(`--${name}`)
const opt = (name: string) => argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)

const days = Number(opt('days') ?? 8)
const since = opt('since')
const outDir = resolve(opt('out') ?? join(process.cwd(), 'wavespeed-archive'))
const keepLocal = !flag('no-local')
const toDrive = flag('drive')
const driveFolderName = opt('drive-folder') ?? 'WaveSpeed Archive'
const email = opt('email')
const modelFilter = (opt('models') ?? '').split(',').map(s => s.trim()).filter(Boolean)
const concurrency = Number(opt('concurrency') ?? 6)
const limit = Number(opt('limit') ?? 0)
const wantZip = flag('zip')
const dryRun = flag('dry')

if (!keepLocal && !toDrive) {
  console.error('--no-local without --drive would discard everything; aborting.')
  process.exit(1)
}

const createdAfter = since
  ? new Date(`${since}T00:00:00Z`).toISOString()
  : new Date(Date.now() - days * 86_400_000).toISOString()

// ─── wavespeed history ──────────────────────────────────────────────────────

interface Prediction {
  id: string
  model: string
  outputs?: string[]
  status: string
  created_at: string
}

function wavespeedKey(): string {
  const key = process.env.WAVESPEED_API_KEY
  if (!key) throw new Error('WAVESPEED_API_KEY is not set in .env.local')
  return key
}

async function historyPage(page: number): Promise<Prediction[]> {
  const res = await fetch(`${API}/predictions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${wavespeedKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ page, page_size: PAGE_SIZE, created_after: createdAfter }),
  })
  const json = await res.json()
  if (json.code && json.code !== 200) throw new Error(json.message ?? 'predictions list failed')
  return json?.data?.items ?? []
}

async function collectHistory(): Promise<Prediction[]> {
  const all: Prediction[] = []
  const seen = new Set<string>()
  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = await historyPage(page)
    if (!items.length) break
    for (const item of items) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      if (item.status !== 'completed' || !item.outputs?.length) continue
      if (modelFilter.length && !modelFilter.some(m => item.model?.includes(m))) continue
      all.push(item)
    }
    process.stdout.write(`\r  history page ${page} — ${all.length} usable predictions`)
  }
  process.stdout.write('\n')
  return all
}

// ─── file naming ────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  safetensors: 'application/octet-stream',
}

function extOf(url: string): string {
  const clean = url.split('?')[0]!
  const ext = clean.includes('.') ? clean.split('.').pop()!.toLowerCase() : ''
  return /^[a-z0-9]{1,12}$/.test(ext) ? ext : 'bin'
}

function slugModel(model: string): string {
  return (model || 'unknown').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
}

/** `2026-08-03_162135__seedream-v5-0-pro-edit__0a959b70.jpeg` — sorts chronologically. */
function buildFilename(pred: Prediction, url: string, index: number, total: number): string {
  const d = new Date(pred.created_at)
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp =
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  const suffix = total > 1 ? `_${index + 1}` : ''
  return `${stamp}__${slugModel(pred.model)}__${pred.id.slice(0, 8)}${suffix}.${extOf(url)}`
}

// ─── resumable state ────────────────────────────────────────────────────────

type ItemStatus = 'saved' | 'expired' | 'failed'

interface StateEntry {
  status: ItemStatus
  filename: string
  bytes?: number
  driveId?: string
  driveLink?: string
  error?: string
}

const statePath = join(outDir, '.archive-state.json')
const manifestPath = join(outDir, 'manifest.csv')
let state: Record<string, StateEntry> = {}

function loadState() {
  if (!existsSync(statePath)) return
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'))
  } catch {
    console.warn('state file unreadable — starting fresh')
  }
}

let stateDirty = false
function saveState() {
  if (dryRun || !stateDirty) return
  writeFileSync(statePath, JSON.stringify(state, null, 1))
  stateDirty = false
}

function csvCell(v: unknown): string {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function appendManifest(row: unknown[]) {
  if (dryRun) return
  appendFileSync(manifestPath, row.map(csvCell).join(',') + '\n')
}

// ─── google drive ───────────────────────────────────────────────────────────

interface DriveTarget {
  userId: string
  folderId: string
  getToken: (force?: boolean) => Promise<string>
}

const TOKEN_TTL_MS = 40 * 60_000

async function setupDrive(): Promise<DriveTarget> {
  const { rows } = await import('../src/lib/db')
  const { getUserGoogleAccessToken, forceRefreshUserGoogleAccessToken } = await import(
    '../src/lib/drive-archive/user-google-auth'
  )
  const { ensureChildFolder } = await import('../src/lib/google-drive')

  const users = await rows<{ id: string; email: string; drive_root_folder_id: string | null }>(
    `SELECT id, email, drive_root_folder_id
       FROM users
      WHERE google_refresh_token IS NOT NULL
        ${email ? 'AND email = $1' : ''}
      ORDER BY created_at
      LIMIT 1`,
    email ? [email] : [],
  )
  const user = users[0]
  if (!user) {
    throw new Error(
      email
        ? `No user ${email} with a connected Google Drive`
        : 'No user has Google Drive connected — connect it in Settings first',
    )
  }

  let cached = { token: '', at: 0 }
  const getToken = async (force = false): Promise<string> => {
    if (!force && cached.token && Date.now() - cached.at < TOKEN_TTL_MS) return cached.token
    const token = force
      ? await forceRefreshUserGoogleAccessToken(user.id)
      : await getUserGoogleAccessToken(user.id)
    cached = { token, at: Date.now() }
    return token
  }

  const token = await getToken()
  const parent = user.drive_root_folder_id ?? 'root'
  const folderId = await ensureChildFolder(parent, driveFolderName, token)
  console.log(`drive: ${user.email} → "${driveFolderName}" (${folderId})`)
  return { userId: user.id, folderId, getToken }
}

async function uploadToDrive(
  drive: DriveTarget,
  filename: string,
  buffer: Buffer,
  mimeType: string,
): Promise<{ id: string; link: string }> {
  const { uploadBufferToDriveFolder } = await import('../src/lib/google-drive')
  try {
    return await uploadBufferToDriveFolder(drive.folderId, filename, buffer, mimeType, await drive.getToken())
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!/401|unauthorized|invalid authentication|invalid_grant/i.test(msg)) throw err
    // Long runs outlive one access token — refresh once and retry with the same buffer.
    return uploadBufferToDriveFolder(drive.folderId, filename, buffer, mimeType, await drive.getToken(true))
  }
}

// ─── download ───────────────────────────────────────────────────────────────

class ExpiredError extends Error {}

async function download(url: string): Promise<Buffer> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= DOWNLOAD_RETRIES; attempt++) {
    try {
      const res = await fetch(url)
      if (res.status === 403 || res.status === 404) {
        throw new ExpiredError(`output no longer stored (${res.status})`)
      }
      if (!res.ok) throw new Error(`download failed: ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (err) {
      if (err instanceof ExpiredError) throw err
      lastErr = err
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

// ─── main ───────────────────────────────────────────────────────────────────

interface Task {
  pred: Prediction
  url: string
  filename: string
}

async function main() {
  console.log(`wavespeed-archive — history since ${createdAfter}${dryRun ? ' (DRY RUN)' : ''}`)

  if (!dryRun) {
    mkdirSync(outDir, { recursive: true })
    if (!existsSync(manifestPath)) {
      appendManifest(['created_at', 'model', 'prediction_id', 'filename', 'bytes', 'status', 'drive_link', 'source_url'])
    }
  }
  loadState()

  const predictions = await collectHistory()
  const tasks: Task[] = []
  for (const pred of predictions) {
    const outputs = pred.outputs ?? []
    outputs.forEach((url, i) => {
      tasks.push({ pred, url, filename: buildFilename(pred, url, i, outputs.length) })
    })
  }

  const outstanding = tasks.filter(t => {
    const prev = state[t.url]
    if (!prev) return true
    if (prev.status === 'expired') return false
    if (prev.status === 'saved') {
      const needsDrive = toDrive && !prev.driveId
      const localMissing = keepLocal && !existsSync(join(outDir, prev.filename))
      return needsDrive || localMissing
    }
    return true // retry previous failures
  })
  const pending = limit > 0 ? outstanding.slice(0, limit) : outstanding

  console.log(
    `predictions: ${predictions.length} · output files: ${tasks.length} · ` +
    `already archived: ${tasks.length - outstanding.length} · to fetch: ${pending.length}` +
    (limit > 0 && outstanding.length > limit ? ` (--limit, of ${outstanding.length} outstanding)` : ''),
  )
  if (dryRun) {
    for (const t of pending.slice(0, 20)) console.log(`  would fetch ${t.filename}`)
    if (pending.length > 20) console.log(`  … +${pending.length - 20} more`)
    console.log('\nDRY RUN — nothing written')
    process.exit(0)
  }
  if (!pending.length) {
    console.log('nothing new to archive')
    process.exit(0)
  }

  const drive = toDrive ? await setupDrive() : null
  const stats = { saved: 0, expired: 0, failed: 0, bytes: 0 }
  let cursor = 0

  async function worker() {
    while (cursor < pending.length) {
      const task = pending[cursor++]!
      const { pred, url, filename } = task
      const mimeType = MIME[extOf(url)] ?? 'application/octet-stream'
      const localPath = join(outDir, filename)

      try {
        let buffer: Buffer
        if (keepLocal && existsSync(localPath) && statSync(localPath).size > 0) {
          buffer = readFileSync(localPath) // resuming a run that only lacks the Drive upload
        } else {
          buffer = await download(url)
          if (keepLocal) writeFileSync(localPath, buffer)
        }

        let driveId: string | undefined
        let driveLink: string | undefined
        if (drive) {
          const uploaded = await uploadToDrive(drive, filename, buffer, mimeType)
          driveId = uploaded.id
          driveLink = uploaded.link
        }

        state[url] = { status: 'saved', filename, bytes: buffer.length, driveId, driveLink }
        stats.saved++
        stats.bytes += buffer.length
        appendManifest([pred.created_at, pred.model, pred.id, filename, buffer.length, 'saved', driveLink ?? '', url])
      } catch (err) {
        const expired = err instanceof ExpiredError
        const msg = err instanceof Error ? err.message : String(err)
        state[url] = { status: expired ? 'expired' : 'failed', filename, error: msg }
        if (expired) stats.expired++
        else {
          stats.failed++
          console.error(`\n  ! ${filename}: ${msg}`)
        }
        appendManifest([pred.created_at, pred.model, pred.id, filename, 0, expired ? 'expired' : 'failed', '', url])
      }

      stateDirty = true
      const done = stats.saved + stats.expired + stats.failed
      if (done % 25 === 0) {
        saveState()
        const gb = (stats.bytes / 1e9).toFixed(2)
        process.stdout.write(
          `\r  ${done}/${pending.length} — saved ${stats.saved} (${gb} GB) · expired ${stats.expired} · failed ${stats.failed}   `,
        )
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  saveState()
  process.stdout.write('\n')

  if (wantZip && keepLocal && stats.saved > 0) {
    const zipPath = `${outDir}.zip`
    console.log(`zipping → ${zipPath} (already-compressed media, so expect little shrinkage)`)
    try {
      const run = promisify(execFile)
      await run('powershell.exe', [
        '-NoProfile', '-Command',
        `Compress-Archive -Path '${outDir}\\*' -DestinationPath '${zipPath}' -Force`,
      ], { maxBuffer: 1 << 26 })
      console.log(`zip done: ${zipPath}`)
    } catch (err) {
      console.error('zip failed:', err instanceof Error ? err.message : err)
    }
  }

  console.log(
    `\ndone — saved ${stats.saved} files (${(stats.bytes / 1e9).toFixed(2)} GB), ` +
    `expired ${stats.expired}, failed ${stats.failed}`,
  )
  console.log(`local: ${keepLocal ? outDir : '(skipped)'}`)
  console.log(`manifest: ${manifestPath}`)
  process.exit(0)
}

main().catch(err => {
  saveState()
  console.error(err)
  process.exit(1)
})
