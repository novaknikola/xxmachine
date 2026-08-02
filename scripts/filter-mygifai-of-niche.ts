/**
 * Strict OnlyFans-niche filter over already-fetched MyGIF inspirations.
 *
 *   npx tsx scripts/filter-mygifai-of-niche.ts
 *
 * Reads:  tmp-e2e/mygifai/all.json
 * Writes: tmp-e2e/mygifai/filtered-of-strict.json
 *         tmp-e2e/mygifai/filtered-of-by-bucket.json
 *         tmp-e2e/mygifai/filtered-of-sample.md   (FULL prompts)
 */

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const OUT_DIR = path.join(process.cwd(), 'tmp-e2e', 'mygifai')
const ALL_PATH = path.join(OUT_DIR, 'all.json')

type Inspiration = {
  id: string
  title?: string
  titleEn?: string
  fullTitle?: string
  platform?: string
  tags?: string[] | null
  tagsEn?: string[] | null
  promptEn?: string | null
  promptCn?: string | null
  imageUrl?: string | null
  sourceUrl?: string | null
  useCount?: number
  viewCount?: number
}

type Bucket =
  | 'soft_selfie_mirror'
  | 'bedroom_lingerie'
  | 'outdoor_casual'
  | 'glam_night_out'
  | 'intimate_closeup'
  | 'pose_body_focus'
  | 'tease_implied'
  | 'outfit_seasonal'

/** Must look like a single adult woman subject. */
const SUBJECT_MUST = [
  'woman',
  'girl',
  'female',
  'lady',
  'girlfriend',
  'beauty',
  'model',
  'she ',
  ' her ',
  '女',
  '女孩',
  '美女',
  '女生',
  '女性',
  '模特',
]

/** Niche / sensual signal — without this, plain "woman portrait" dies. */
const NICHE_MUST = [
  'sexy',
  'sensual',
  'seductive',
  'flirty',
  'flirt',
  'lingerie',
  'bikini',
  'intimate',
  'glamour',
  'allure',
  'alluring',
  'desire',
  'bedroom',
  'silk slip',
  'nightwear',
  'sheer',
  'cleavage',
  'swimsuit',
  'pure desire',
  'erotic',
  'aphrodisiac',
  'wet hair',
  'girlfriend perspective',
  'tease',
  '性感',
  '撩人',
  '妩媚',
  '娇媚',
  '内衣',
  '比基尼',
  '私房',
  '卧室',
  '诱惑',
  '纯欲',
  '媚',
  '睡裙',
]

/** Hard exclusions — brand drift / wrong product type. */
const EXCLUDE = [
  'logo',
  'brand kit',
  'brand identity',
  'poster',
  'typography',
  'infographic',
  'storyboard',
  'svg',
  'vector icon',
  'pbr',
  'mockup',
  'product shot',
  'packaging',
  'ui design',
  'app interface',
  'website',
  'landing page',
  'character sheet',
  'character concept breakdown',
  'anatomical',
  'medical illustration',
  'mecha',
  'cyborg',
  'robot',
  'armor',
  'assassin',
  'fox mask',
  'wuxia',
  'martial arts',
  'superhero',
  'fantasy warrior',
  'dragon',
  'elf',
  'witch coven',
  'horror',
  'zombie',
  'gore',
  'child',
  'children',
  'kid ',
  'kids',
  'toddler',
  'baby',
  'multiple people',
  'crowd',
  'group of',
  'family photo',
  'man and woman',
  'boyfriend',
  'husband',
  'polygonal',
  'low poly',
  'pixel art',
  'sticker pack',
  'emoji',
  'manga page',
  'comic panel',
  '9-grid',
  'nine-grid',
  'triptych',
  'collage grid',
  'logo centered',
  '商标',
  '海报',
  '矢量',
  '包装',
  '产品图',
  '角色设定',
  '分镜',
  '儿童',
  '小孩',
  '男人和女人',
  '情侣合影',
]

const BUCKET_RULES: Array<{ bucket: Bucket; anyOf: string[] }> = [
  {
    bucket: 'bedroom_lingerie',
    anyOf: [
      'lingerie',
      'bedroom',
      'nightwear',
      'silk slip',
      'negligee',
      'bra ',
      'underwear',
      'on the bed',
      'lying on',
      '内衣',
      '卧室',
      '睡裙',
      '私房',
    ],
  },
  {
    bucket: 'soft_selfie_mirror',
    anyOf: [
      'selfie',
      'mirror selfie',
      'phone camera',
      'front camera',
      'bathroom mirror',
      'holding phone',
      '自拍',
      '镜子',
    ],
  },
  {
    bucket: 'outdoor_casual',
    anyOf: [
      'outdoor',
      'street',
      'park',
      'beach',
      'cafe',
      'café',
      'seaside',
      'city street',
      'candid',
      '日光',
      '街头',
      '海边',
      '咖啡馆',
      '户外',
    ],
  },
  {
    bucket: 'glam_night_out',
    anyOf: [
      'night out',
      'evening dress',
      'cocktail',
      'club',
      'neon',
      'glamour',
      'red carpet',
      'party',
      '夜店',
      '礼服',
      '霓虹',
      '晚宴',
    ],
  },
  {
    bucket: 'intimate_closeup',
    anyOf: [
      'close-up',
      'closeup',
      'close up',
      'portrait',
      'face close',
      'collarbone',
      'soft focus',
      'shallow depth',
      '特写',
      '人像',
      '肖像',
    ],
  },
  {
    bucket: 'pose_body_focus',
    anyOf: [
      'full body',
      'full-body',
      'standing pose',
      'sitting pose',
      'overheaded',
      'overhead',
      'arching',
      'pose',
      'body focus',
      '全身',
      '姿势',
      '俯拍',
    ],
  },
  {
    bucket: 'tease_implied',
    anyOf: [
      'tease',
      'flirty',
      'flirt',
      'seductive',
      'sensual',
      'pure desire',
      'alluring',
      'erotic tension',
      'implied',
      'sheer',
      'wet hair',
      '撩人',
      '性感',
      '诱惑',
      '纯欲',
    ],
  },
  {
    bucket: 'outfit_seasonal',
    anyOf: [
      'bikini',
      'swimsuit',
      'summer',
      'winter coat',
      'sweater',
      'outfit',
      'fashion editorial',
      '比基尼',
      '泳装',
      '夏日',
      '穿搭',
    ],
  },
]

function haystack(item: Inspiration): string {
  return [
    item.title,
    item.titleEn,
    item.fullTitle,
    item.promptEn,
    item.promptCn,
    ...(item.tags ?? []),
    ...(item.tagsEn ?? []),
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
}

function includesAny(text: string, words: string[]): string[] {
  return words.filter((w) => text.includes(w.toLowerCase()))
}

function assignBuckets(text: string): Bucket[] {
  const hits: Bucket[] = []
  for (const rule of BUCKET_RULES) {
    if (includesAny(text, rule.anyOf).length) hits.push(rule.bucket)
  }
  // Prefer at least one bucket; default tease if niche passed but no scene cue
  if (!hits.length) hits.push('tease_implied')
  return [...new Set(hits)]
}

function primaryBucket(buckets: Bucket[]): Bucket {
  const priority: Bucket[] = [
    'bedroom_lingerie',
    'soft_selfie_mirror',
    'tease_implied',
    'intimate_closeup',
    'pose_body_focus',
    'glam_night_out',
    'outdoor_casual',
    'outfit_seasonal',
  ]
  for (const b of priority) {
    if (buckets.includes(b)) return b
  }
  return buckets[0] ?? 'tease_implied'
}

type StrictRow = {
  id: string
  titleEn: string | null
  primaryBucket: Bucket
  buckets: Bucket[]
  subjectHits: string[]
  nicheHits: string[]
  excludeHits: string[]
  promptEn: string | null
  promptCn: string | null
  tags: string[]
  imageUrl: string | null
  sourceUrl: string | null
  useCount: number
  viewCount: number
}

function toMarkdown(rows: StrictRow[], perBucket = 6): string {
  const byBucket = new Map<Bucket, StrictRow[]>()
  for (const row of rows) {
    const list = byBucket.get(row.primaryBucket) ?? []
    list.push(row)
    byBucket.set(row.primaryBucket, list)
  }

  const lines: string[] = [
    `# MyGIF → OF niche (strict)`,
    ``,
    `Total kept: **${rows.length}**`,
    ``,
    `Buckets:`,
    ...[...byBucket.entries()].map(([b, list]) => `- ${b}: ${list.length}`),
    ``,
    `Prompts below are **full** (not truncated).`,
    ``,
  ]

  for (const [bucket, list] of byBucket) {
    lines.push(`---`)
    lines.push(``)
    lines.push(`# ${bucket} (${list.length})`)
    lines.push(``)
    for (const row of list.slice(0, perBucket)) {
      const prompt = row.promptEn || row.promptCn || ''
      lines.push(`## ${row.titleEn ?? row.id}`)
      lines.push(``)
      lines.push(`- id: \`${row.id}\``)
      lines.push(`- buckets: ${row.buckets.join(', ')}`)
      lines.push(`- niche: ${row.nicheHits.join(', ') || '—'}`)
      lines.push(`- image: ${row.imageUrl ?? '—'}`)
      lines.push(``)
      lines.push('```')
      lines.push(prompt)
      lines.push('```')
      lines.push(``)
    }
  }

  return lines.join('\n')
}

async function main() {
  const raw = JSON.parse(await readFile(ALL_PATH, 'utf8')) as {
    inspirations: Inspiration[]
  }
  const all = raw.inspirations ?? []

  const kept: StrictRow[] = []
  let droppedExclude = 0
  let droppedNoSubject = 0
  let droppedNoNiche = 0
  let droppedNoPrompt = 0

  for (const item of all) {
    const promptEn = item.promptEn?.trim() || null
    const promptCn = item.promptCn?.trim() || null
    if (!promptEn && !promptCn) {
      droppedNoPrompt++
      continue
    }

    const text = haystack(item)
    const excludeHits = includesAny(text, EXCLUDE)
    if (excludeHits.length) {
      droppedExclude++
      continue
    }

    const subjectHits = includesAny(text, SUBJECT_MUST)
    if (!subjectHits.length) {
      droppedNoSubject++
      continue
    }

    const nicheHits = includesAny(text, NICHE_MUST)
    if (!nicheHits.length) {
      droppedNoNiche++
      continue
    }

    const buckets = assignBuckets(text)
    kept.push({
      id: item.id,
      titleEn: item.titleEn ?? item.title ?? null,
      primaryBucket: primaryBucket(buckets),
      buckets,
      subjectHits,
      nicheHits,
      excludeHits,
      promptEn,
      promptCn,
      tags: item.tags ?? [],
      imageUrl: item.imageUrl ?? null,
      sourceUrl: item.sourceUrl ?? null,
      useCount: item.useCount ?? 0,
      viewCount: item.viewCount ?? 0,
    })
  }

  kept.sort((a, b) => {
    const ae = a.promptEn ? 1 : 0
    const be = b.promptEn ? 1 : 0
    if (be !== ae) return be - ae
    return b.useCount - a.useCount
  })

  const byBucket: Record<string, StrictRow[]> = {}
  for (const row of kept) {
    ;(byBucket[row.primaryBucket] ??= []).push(row)
  }

  const meta = {
    filteredAt: new Date().toISOString(),
    source: ALL_PATH,
    totalAll: all.length,
    totalKept: kept.length,
    dropped: {
      noPrompt: droppedNoPrompt,
      exclude: droppedExclude,
      noSubject: droppedNoSubject,
      noNiche: droppedNoNiche,
    },
    bucketCounts: Object.fromEntries(
      Object.entries(byBucket).map(([k, v]) => [k, v.length]),
    ),
  }

  const strictPath = path.join(OUT_DIR, 'filtered-of-strict.json')
  await writeFile(
    strictPath,
    JSON.stringify({ ...meta, items: kept }, null, 2),
    'utf8',
  )

  const byBucketPath = path.join(OUT_DIR, 'filtered-of-by-bucket.json')
  await writeFile(
    byBucketPath,
    JSON.stringify({ ...meta, byBucket }, null, 2),
    'utf8',
  )

  const mdPath = path.join(OUT_DIR, 'filtered-of-sample.md')
  await writeFile(mdPath, toMarkdown(kept, 6), 'utf8')

  console.log('--- OF niche strict ---')
  console.log(JSON.stringify(meta, null, 2))
  console.log(`wrote: ${strictPath}`)
  console.log(`wrote: ${byBucketPath}`)
  console.log(`wrote: ${mdPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
