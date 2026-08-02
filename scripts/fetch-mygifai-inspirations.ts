/**
 * Local one-shot: pull MyGIF inspiration prompts and dump filtered samples.
 *
 *   npx tsx scripts/fetch-mygifai-inspirations.ts
 *
 * Writes under tmp-e2e/mygifai/:
 *   - all.json              full dump (deduped by id)
 *   - slim.jsonl            one slim row per line (easy to scan)
 *   - filtered-keyword.json first-pass keyword hits
 *   - filtered-sample.md    first ~40 hits for human review
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const API = 'https://mygifai.com/api/inspiration/list'
const OUT_DIR = path.join(process.cwd(), 'tmp-e2e', 'mygifai')
const PAGE_SIZE = 100

/** EN + CN seeds for "woman / girl / flirty" style themes — intentionally broad for v1. */
const KEYWORDS = [
  // English
  'woman',
  'women',
  'girl',
  'girls',
  'lady',
  'ladies',
  'female',
  'flirty',
  'flirt',
  'sexy',
  'seductive',
  'sensual',
  'lingerie',
  'bikini',
  'girlfriend',
  'pin-up',
  'pinup',
  'glamour',
  'babe',
  // Chinese (common on this site)
  '女',
  '女孩',
  '美女',
  '女生',
  '女性',
  '性感',
  '撩人',
  '妩媚',
  '娇媚',
  '内衣',
  '比基尼',
  '模特',
]

type Inspiration = {
  id: string
  title?: string
  titleEn?: string
  fullTitle?: string
  platform?: string
  sourceText?: string
  sourceUrl?: string
  tags?: string[] | null
  tagsEn?: string[] | null
  promptEn?: string | null
  promptCn?: string | null
  imageUrl?: string | null
  images?: string[] | null
  imageAlt?: string | null
  viewCount?: number
  useCount?: number
  createdAt?: number
  updatedAt?: number
  toolsOnly?: boolean
}

type ListResponse = {
  success: boolean
  inspirations: Inspiration[]
  pagination: {
    limit: number
    offset: number
    total: number
    hasMore: boolean
  }
}

function haystack(item: Inspiration): string {
  return [
    item.title,
    item.titleEn,
    item.fullTitle,
    item.promptEn,
    item.promptCn,
    item.imageAlt,
    ...(item.tags ?? []),
    ...(item.tagsEn ?? []),
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
}

function matchKeywords(text: string): string[] {
  const hits: string[] = []
  for (const kw of KEYWORDS) {
    if (text.includes(kw.toLowerCase())) hits.push(kw)
  }
  return hits
}

function slim(item: Inspiration, matched?: string[]) {
  return {
    id: item.id,
    titleEn: item.titleEn ?? item.title ?? null,
    platform: item.platform ?? null,
    tags: item.tags ?? [],
    tagsEn: item.tagsEn ?? [],
    promptEn: item.promptEn ?? null,
    promptCn: item.promptCn ?? null,
    imageUrl: item.imageUrl ?? null,
    sourceUrl: item.sourceUrl ?? null,
    useCount: item.useCount ?? 0,
    viewCount: item.viewCount ?? 0,
    ...(matched ? { matchedKeywords: matched } : {}),
  }
}

async function fetchPage(offset: number): Promise<ListResponse> {
  const url = `${API}?limit=${PAGE_SIZE}&offset=${offset}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return (await res.json()) as ListResponse
}

async function fetchAll(): Promise<Inspiration[]> {
  const byId = new Map<string, Inspiration>()
  let offset = 0
  let total = Infinity
  let page = 0

  while (offset < total) {
    page++
    const data = await fetchPage(offset)
    if (!data.success) throw new Error(`API success=false at offset=${offset}`)

    total = data.pagination.total
    const batch = data.inspirations ?? []
    for (const item of batch) {
      if (item?.id) byId.set(item.id, item)
    }

    console.log(
      `page ${page}: offset=${offset} got=${batch.length} unique=${byId.size}/${total} hasMore=${data.pagination.hasMore}`,
    )

    if (!batch.length || !data.pagination.hasMore) break
    offset += data.pagination.limit || PAGE_SIZE

    // be polite
    await new Promise((r) => setTimeout(r, 120))
  }

  return [...byId.values()]
}

function toMarkdownSample(
  rows: Array<ReturnType<typeof slim>>,
  limit = 40,
): string {
  const lines: string[] = [
    `# MyGIF inspiration — keyword filter sample`,
    ``,
    `Showing ${Math.min(limit, rows.length)} of ${rows.length} hits.`,
    ``,
  ]

  for (const row of rows.slice(0, limit)) {
    const prompt = (row.promptEn || row.promptCn || '').slice(0, 400)
    lines.push(`## ${row.titleEn ?? row.id}`)
    lines.push(``)
    lines.push(`- id: \`${row.id}\``)
    lines.push(`- matched: ${(row.matchedKeywords ?? []).join(', ')}`)
    lines.push(`- tags: ${(row.tags ?? []).join(', ') || '—'}`)
    lines.push(`- image: ${row.imageUrl ?? '—'}`)
    lines.push(``)
    lines.push('```')
    lines.push(prompt + ((row.promptEn || row.promptCn || '').length > 400 ? '…' : ''))
    lines.push('```')
    lines.push(``)
  }

  return lines.join('\n')
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })

  console.log('Fetching inspirations…')
  const all = await fetchAll()
  console.log(`Done. Unique items: ${all.length}`)

  const allPath = path.join(OUT_DIR, 'all.json')
  await writeFile(
    allPath,
    JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        source: API,
        count: all.length,
        inspirations: all,
      },
      null,
      2,
    ),
    'utf8',
  )

  const slimRows = all.map((i) => slim(i))
  const slimPath = path.join(OUT_DIR, 'slim.jsonl')
  await writeFile(
    slimPath,
    slimRows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8',
  )

  const filtered = all
    .map((item) => {
      const matched = matchKeywords(haystack(item))
      return matched.length ? slim(item, matched) : null
    })
    .filter(Boolean) as Array<ReturnType<typeof slim>>

  // Prefer English prompt presence + higher useCount for review order
  filtered.sort((a, b) => {
    const ae = a.promptEn ? 1 : 0
    const be = b.promptEn ? 1 : 0
    if (be !== ae) return be - ae
    return (b.useCount ?? 0) - (a.useCount ?? 0)
  })

  const filteredPath = path.join(OUT_DIR, 'filtered-keyword.json')
  await writeFile(
    filteredPath,
    JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        keywords: KEYWORDS,
        totalAll: all.length,
        totalMatched: filtered.length,
        items: filtered,
      },
      null,
      2,
    ),
    'utf8',
  )

  const mdPath = path.join(OUT_DIR, 'filtered-sample.md')
  await writeFile(mdPath, toMarkdownSample(filtered, 40), 'utf8')

  // Quick keyword frequency for tuning the filter next
  const freq = new Map<string, number>()
  for (const row of filtered) {
    for (const kw of row.matchedKeywords ?? []) {
      freq.set(kw, (freq.get(kw) ?? 0) + 1)
    }
  }
  const freqSorted = [...freq.entries()].sort((a, b) => b[1] - a[1])

  console.log('\n--- summary ---')
  console.log(`all:              ${all.length}`)
  console.log(`keyword matches:  ${filtered.length}`)
  console.log(`wrote: ${allPath}`)
  console.log(`wrote: ${slimPath}`)
  console.log(`wrote: ${filteredPath}`)
  console.log(`wrote: ${mdPath}`)
  console.log('\nkeyword frequency (top):')
  for (const [kw, n] of freqSorted.slice(0, 20)) {
    console.log(`  ${n.toString().padStart(4)}  ${kw}`)
  }
  console.log('\nOpen filtered-sample.md to eyeball quality, then we tighten the filter.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
