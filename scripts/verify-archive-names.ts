/**
 * Proves the naming change is safe. No DB, no Drive, no credits.
 *
 *   npx tsx scripts/verify-archive-names.ts
 *
 * Carries a verbatim copy of the PREVIOUS buildArchiveFilename so the current
 * one can be diffed against it over a matrix of inputs. Without a label every
 * name must be byte-identical — except the documented bug-fix partition, which
 * is asserted to differ in exactly the intended way.
 */
import { createHash } from 'node:crypto'
import { buildArchiveFilename, sanitizeDriveKey, archiveDateKey } from '../src/lib/drive-archive/paths'
import { sanitizeArchiveLabel, seriesFolderName, copyPasteArchiveLabel } from '../src/lib/drive-archive/label'
import { archiveFolderPaths } from '../src/lib/drive-archive/resolve-folder'
import type { DriveArchiveSourceType } from '../src/lib/drive-archive/types'

function hashUrl(url: string) { return createHash('sha256').update(url).digest('hex') }

function extFromUrl(url: string, mimeType: string): string {
  try {
    const m = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i)
    if (m) return m[1].toLowerCase()
  } catch { /* ignore */ }
  if (mimeType.startsWith('video/')) return 'mp4'
  if (mimeType === 'image/png') return 'png'
  if (mimeType === 'image/webp') return 'webp'
  return 'jpg'
}

interface Opts {
  sourceType: DriveArchiveSourceType
  sourceId: string
  url: string
  mimeType: string
  index: number
  total: number
  modelKey?: string | null
  seriesId?: string | null
  seriesIndex?: number | null
  seriesTotal?: number | null
}

/** Exactly what shipped before this change. */
function legacyBuildArchiveFilename(opts: Opts): string {
  const day = archiveDateKey()
  const model = sanitizeDriveKey(opts.modelKey, 'gen').replace(/^_/, '') || 'gen'
  const shortType =
    opts.sourceType === 'generation' ? 'gen'
      : opts.sourceType === 'discovery_item' ? 'disc'
        : 'job'
  const inSeries = !!opts.seriesId && (opts.seriesTotal ?? 0) > 1
  const idShort = inSeries
    ? hashUrl(opts.seriesId!).slice(0, 8)
    : opts.sourceId.replace(/-/g, '').slice(0, 8)
  const hash8 = hashUrl(opts.url).slice(0, 8)
  const ext = extFromUrl(opts.url, opts.mimeType)
  const position = inSeries ? (opts.seriesIndex ?? 0) + 1 : opts.index + 1
  const positionTag = inSeries || opts.total > 1 ? `_${String(position).padStart(2, '0')}` : ''
  return `${day}_${shortType}-${idShort}${positionTag}_${model}_${hash8}.${ext}`
}

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) { failures++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ── 1. No label: current must equal legacy, except the fixed partition ───────
const sourceTypes: DriveArchiveSourceType[] = ['generation', 'discovery_item', 'queue_job', 'pinterest_pin']
const urls = [
  'https://x.test/a/one.jpg',
  'https://x.test/a/two.png',
  'https://x.test/a/three.mp4',
]
const mimes = ['image/jpeg', 'image/png', 'video/mp4']
const models = [null, 'bulk_carousel', 'seedream_edit']
const seriesCases: Array<{ seriesId?: string | null; seriesIndex?: number | null; seriesTotal?: number | null }> = [
  {},
  { seriesId: 'job-1:0', seriesIndex: 0, seriesTotal: 1 },
  { seriesId: 'job-1:0', seriesIndex: 2, seriesTotal: 3 },
  { seriesId: 'job-1:1', seriesIndex: 4, seriesTotal: 5 },
]

let compared = 0, intendedDiffs = 0
for (const sourceType of sourceTypes) {
  for (const total of [1, 3]) {
    for (const sc of seriesCases) {
      for (let u = 0; u < urls.length; u++) {
        for (const modelKey of models) {
          const opts: Opts = {
            sourceType, sourceId: '3f9a1c07-aaaa-bbbb-cccc-ddddeeeeffff',
            url: urls[u], mimeType: mimes[u], index: 0, total, modelKey, ...sc,
          }
          const now = buildArchiveFilename(opts)
          const before = legacyBuildArchiveFilename(opts)
          compared++
          // The fix: a seriesId + a position IS a series, regardless of total.
          const isFixedCase = !!sc.seriesId && sc.seriesIndex != null && (sc.seriesTotal ?? 0) <= 1
          if (isFixedCase) {
            intendedDiffs++
            check('fixed case must differ', now !== before, `${before} === ${now}`)
            check('fixed case gains a position tag', /_\d{2}_/.test(now), now)
          } else {
            check('legacy name unchanged', now === before, `${before} -> ${now}`)
          }
        }
      }
    }
  }
}
console.log(`compared ${compared} no-label cases (${intendedDiffs} intended diffs)`)

// ── 2. Labelled names ───────────────────────────────────────────────────────
const base: Opts = {
  sourceType: 'queue_job', sourceId: 'job:0:0', url: urls[0], mimeType: mimes[0],
  index: 0, total: 1, modelKey: 'bulk_carousel', seriesId: 'job:0', seriesIndex: 0, seriesTotal: 5,
}
const labelled = buildArchiveFilename({ ...base, seriesLabel: 'Beach Vacation' })
check('label drives the name', labelled === `beach_vacation_01_${hashUrl(urls[0]).slice(0, 4)}.jpg`, labelled)

const inFolder = buildArchiveFilename({ ...base, seriesLabel: 'Beach Vacation', seriesFolder: 'beach_vacation_01' })
check('inside a subfolder the name is short', inFolder === `01_${hashUrl(urls[0]).slice(0, 4)}.jpg`, inFolder)

for (const bad of ['', '   ', 'Клара', '???']) {
  const out = buildArchiveFilename({ ...base, seriesLabel: bad })
  check(`unusable label ${JSON.stringify(bad)} falls back to legacy`,
    out === legacyBuildArchiveFilename(base), out)
}
const long = buildArchiveFilename({ ...base, seriesLabel: 'a'.repeat(200) })
check('long label is truncated', /^a{48}_01_[0-9a-f]{4}\.jpg$/.test(long), long)
check('café is transliterated', sanitizeArchiveLabel('café') === 'cafe', sanitizeArchiveLabel('café'))
check('slashes cannot escape the folder', !sanitizeArchiveLabel('beach/../vacation').includes('/'))

// ── 3. Folder helpers ───────────────────────────────────────────────────────
check('folder is zero padded', seriesFolderName('beach vacation', 2) === 'beach_vacation_02')
check('folder sorts past nine', seriesFolderName('x', 10) > seriesFolderName('x', 2))
check('no label means no folder', seriesFolderName('', 1) === '')
check('copy-paste label', copyPasteArchiveLabel('tiana', 'DbbSK7rD-SW') === 'tiana_dbbsk7rd-sw')

const flat = archiveFolderPaths({ characterKey: 'tiana', kind: 'carousels', stage: 'ready', dateKey: '2026-08-05' })
check('no subfolder keeps the old leaf', flat.leafPath === 'tiana/carousel/ready/2026-08-05', flat.leafPath)
const nested = archiveFolderPaths({ characterKey: 'tiana', kind: 'carousels', stage: 'ready', dateKey: '2026-08-05', seriesFolder: 'beach_vacation_01' })
check('subfolder appends one level', nested.leafPath === 'tiana/carousel/ready/2026-08-05/beach_vacation_01', nested.leafPath)
check('day path is untouched by the subfolder', nested.dayPath === flat.leafPath)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
