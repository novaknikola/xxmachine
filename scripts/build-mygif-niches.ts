/**
 * Build MyGIF → xxmachine house-style niche bundles (separate namespace).
 *
 *   npx tsx scripts/build-mygif-niches.ts
 *
 * Reads:  tmp-e2e/mygifai/filtered-of-strict.json
 * Writes: src/lib/niches/mygif-generated.ts
 */

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT = process.cwd()
const IN_PATH = path.join(ROOT, 'tmp-e2e', 'mygifai', 'filtered-of-strict.json')
const OUT_PATH = path.join(ROOT, 'src', 'lib', 'niches', 'mygif-generated.ts')

const IPHONE =
  'shot on iPhone, natural lighting, neutral color balance, candid unposed realism, subtle contrast, authentic smartphone photography'

type Bucket =
  | 'soft_selfie_mirror'
  | 'bedroom_lingerie'
  | 'outdoor_casual'
  | 'glam_night_out'
  | 'intimate_closeup'
  | 'pose_body_focus'
  | 'tease_implied'
  | 'outfit_seasonal'

type StrictItem = {
  id: string
  titleEn: string | null
  primaryBucket: Bucket
  buckets: Bucket[]
  promptEn: string | null
  promptCn: string | null
  useCount: number
}

/** Extra hard excludes at rewrite time (costume / art / junk that breaks OF feed). */
const REWRITE_EXCLUDE = [
  'tang dynasty',
  'pipa',
  'bound with tape',
  'cation tape',
  'fox mask',
  'wuxia',
  'assassin',
  'mecha',
  'cyborg',
  'hanfu',
  'ancient chinese',
  'classical chinese',
  'child',
  'children',
  'schoolgirl',
  'teenage',
  'teen girl',
  'node_graph',
  'ip_adapter',
  'safetensors',
  'prompt_type',
  'prompt_details',
  'image_description',
  'preserve_original',
  'uploaded image',
  'attached image',
  'reference_file',
  'help me generate',
  'as a photography master',
  'uploaded character',
  'nine-square',
  'nine square',
  '3:4 aspect',
  'voyeur',
  'photography analysis',
  'ai-generated female portrait',
  '深度解析',
  '构图（',
  '纯欲美学风格',
]

function looksLikeJunk(s: string): boolean {
  const t = s.trim()
  if (t.startsWith('{') || t.includes('{"') || t.includes('"subject"')) return true
  if (t.includes('```') || t.includes('### ')) return true
  // Too much CJK = analysis dump, not a scene prompt
  const cjk = (t.match(/[\u4e00-\u9fff]/g) ?? []).length
  if (cjk > 24) return true
  // Midjourney / SD noise dumps
  if (/\b(masterpiece|best quality|perfect lighting)\b/i.test(t) && t.length > 400) return true
  return false
}

const BUCKET_META: Record<
  Bucket,
  { id: string; label: string; description: string; cap: number }
> = {
  bedroom_lingerie: {
    id: 'mygif-bedroom-lingerie',
    label: 'MyGIF · Bedroom / Lingerie',
    description: 'Scraped MyGIF — bedroom, lingerie, silk, private intimacy.',
    cap: 24,
  },
  tease_implied: {
    id: 'mygif-tease-implied',
    label: 'MyGIF · Tease / Pure Desire',
    description: 'Scraped MyGIF — flirty tease, sensual implied, pure-desire mood.',
    cap: 28,
  },
  intimate_closeup: {
    id: 'mygif-intimate-closeup',
    label: 'MyGIF · Intimate Close-up',
    description: 'Scraped MyGIF — face / collarbone / tight portrait framing.',
    cap: 20,
  },
  soft_selfie_mirror: {
    id: 'mygif-soft-selfie',
    label: 'MyGIF · Soft Selfie / Mirror',
    description: 'Scraped MyGIF — mirror and phone-camera selfies.',
    cap: 16,
  },
  pose_body_focus: {
    id: 'mygif-pose-body',
    label: 'MyGIF · Pose / Body Focus',
    description: 'Scraped MyGIF — full-body and deliberate pose shots.',
    cap: 16,
  },
  glam_night_out: {
    id: 'mygif-glam-night',
    label: 'MyGIF · Glam Night Out',
    description: 'Scraped MyGIF — evening glam, neon, dressed-up energy.',
    cap: 16,
  },
  outdoor_casual: {
    id: 'mygif-outdoor-casual',
    label: 'MyGIF · Outdoor Casual',
    description: 'Scraped MyGIF — street, beach, café, candid outdoor.',
    cap: 16,
  },
  outfit_seasonal: {
    id: 'mygif-outfit-seasonal',
    label: 'MyGIF · Outfit / Seasonal',
    description: 'Scraped MyGIF — bikini, summer, outfit drops.',
    cap: 16,
  },
}

function stripMidjourneyFlags(s: string): string {
  return s
    .replace(/\s*--[\w]+(?:\s+[^\s-][^\s]*)?/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function stripArtPrefix(s: string): string {
  let t = s.trim()
  // Drop leading "A … of a woman/girl …" wrappers when the rest is the scene.
  t = t.replace(
    /^(?:create|generate|make|an?|the)\s+/i,
    '',
  )
  t = t.replace(
    /^(?:highly\s+)?(?:artistic\s+)?(?:realistic\s+)?(?:female\s+)?(?:portrait\s+)?(?:photography\s+)?(?:of\s+)?/i,
    '',
  )
  t = t.replace(
    /^(?:a\s+)?(?:pure\s+desire\s+style\s+)?(?:photography|photograph|portrait|image|shot|photo)\s+(?:of\s+)?/i,
    '',
  )
  t = t.replace(
    /^(?:a\s+|an\s+)?(?:young\s+)?(?:beautiful\s+)?(?:asian\s+)?(?:east\s+asian\s+)?(?:realistic\s+)?(?:woman|girl|female|lady)\b[,:]?\s*/i,
    '',
  )
  t = t.replace(/^based on the uploaded image[,.]?\s*/i, '')
  t = t.replace(/^you are a master photographer[^.]*\.\s*/i, '')
  return t.trim().replace(/^[,.\s]+/, '')
}

function rewriteToHouseStyle(raw: string): string | null {
  let body = stripMidjourneyFlags(raw)
  if (!body || body.length < 40) return null
  if (looksLikeJunk(body)) return null
  const lower = body.toLowerCase()
  if (REWRITE_EXCLUDE.some((x) => lower.includes(x))) return null

  body = stripArtPrefix(body)
  if (looksLikeJunk(body) || body.length < 40) return null
  // Collapse leftover bilingual junk markers sometimes left in MyGIF EN
  body = body
    .replace(/super high颜值/gi, 'highly attractive face')
    .replace(/真实细腻的皮肤细节/g, 'realistic fine skin detail')
    .replace(/film感/gi, 'film look')
    .replace(/\s{2,}/g, ' ')
    .trim()

  if (body.length < 40) return null

  // Ensure it reads as a scene clause after "woman "
  if (!/^(in|on|at|wearing|sitting|standing|lying|kneeling|leaning|holding|looking|posing|walking|with)\b/i.test(body)) {
    // Keep as descriptive clause
    body = body.charAt(0).toLowerCase() + body.slice(1)
  } else {
    body = body.charAt(0).toLowerCase() + body.slice(1)
  }

  // Trim runaway length for Bulk UX
  if (body.length > 520) {
    const cut = body.slice(0, 520)
    const lastComma = cut.lastIndexOf(',')
    body = (lastComma > 300 ? cut.slice(0, lastComma) : cut).trim()
  }

  body = body.replace(/[.\s]+$/, '')
  return `Ultra realistic 4K photo of a woman ${body}, ${IPHONE}.`
}

function dedupePrompts(prompts: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of prompts) {
    const key = p.toLowerCase().replace(/\s+/g, ' ').slice(0, 180)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
}

async function main() {
  const raw = JSON.parse(await readFile(IN_PATH, 'utf8')) as { items: StrictItem[] }
  const items = raw.items ?? []

  const byBucket = new Map<Bucket, StrictItem[]>()
  for (const item of items) {
    const list = byBucket.get(item.primaryBucket) ?? []
    list.push(item)
    byBucket.set(item.primaryBucket, list)
  }

  type NicheOut = {
    id: string
    label: string
    description: string
    sourceIds: string[]
    prompts: string[]
  }

  const niches: NicheOut[] = []

  for (const [bucket, meta] of Object.entries(BUCKET_META) as Array<
    [Bucket, (typeof BUCKET_META)[Bucket]]
  >) {
    const pool = (byBucket.get(bucket) ?? [])
      .slice()
      .sort((a, b) => b.useCount - a.useCount)

    const prompts: string[] = []
    const sourceIds: string[] = []
    for (const item of pool) {
      if (prompts.length >= meta.cap) break
      const src = item.promptEn || item.promptCn
      if (!src) continue
      const rewritten = rewriteToHouseStyle(src)
      if (!rewritten) continue
      prompts.push(rewritten)
      sourceIds.push(item.id)
    }

    const unique = dedupePrompts(prompts)
    if (!unique.length) continue

    niches.push({
      id: meta.id,
      label: meta.label,
      description: meta.description,
      sourceIds: sourceIds.slice(0, unique.length),
      prompts: unique,
    })
  }

  // Combined mix bundle (best of each)
  const mixPrompts: string[] = []
  const mixIds: string[] = []
  for (const niche of niches) {
    for (const [i, p] of niche.prompts.slice(0, 6).entries()) {
      mixPrompts.push(p)
      mixIds.push(niche.sourceIds[i] ?? niche.id)
    }
  }
  const mixUnique = dedupePrompts(mixPrompts)
  if (mixUnique.length) {
    niches.unshift({
      id: 'mygif-of-mix',
      label: 'MyGIF · OF Mix (All Buckets)',
      description:
        'Scraped MyGIF — balanced mix across tease, bedroom, close-up, selfie, pose. Source-tagged mygif; separate from brand niches.',
      sourceIds: mixIds.slice(0, mixUnique.length),
      prompts: mixUnique,
    })
  }

  const generatedAt = new Date().toISOString()
  const totalPrompts = niches.reduce((n, x) => n + x.prompts.length, 0)

  const body = `/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: MyGIF inspiration scrape (strict OF filter)
 * Generated: ${generatedAt}
 * Niches: ${niches.length} | Prompts: ${totalPrompts}
 *
 * Regenerate: npx tsx scripts/build-mygif-niches.ts
 */

import type { NicheDefinition } from '@/lib/niche-utils'

export const MYGIF_GENERATED_AT = ${JSON.stringify(generatedAt)}

export const MYGIF_NICHE_DEFINITIONS: NicheDefinition[] = [
${niches
  .map(
    (n) => `  {
    id: ${JSON.stringify(n.id)},
    label: ${JSON.stringify(n.label)},
    description: ${JSON.stringify(n.description)},
    prompts: [
${n.prompts.map((p) => `      \`${esc(p)}\`,`).join('\n')}
    ],
  }`,
  )
  .join(',\n')}
]

/** Original MyGIF inspiration ids per niche (debug / provenance). */
export const MYGIF_SOURCE_IDS: Record<string, string[]> = {
${niches.map((n) => `  ${JSON.stringify(n.id)}: ${JSON.stringify(n.sourceIds)},`).join('\n')}
}
`

  await writeFile(OUT_PATH, body, 'utf8')
  console.log(`Wrote ${OUT_PATH}`)
  console.log(`niches=${niches.length} prompts=${totalPrompts}`)
  for (const n of niches) {
    console.log(`  ${n.id}: ${n.prompts.length}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
