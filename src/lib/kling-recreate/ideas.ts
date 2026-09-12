import { createHash } from 'node:crypto'
import { query, rows } from '@/lib/db'
import { callGrok, GROK_FAST } from '@/lib/grok'
import { NICHE_DEFINITIONS } from '@/lib/niche-prompts'
import type { KlingFrameRow, KlingVideoContext } from './types'

export function ideaUniquenessHash(prompt: string): string {
  const normalized = prompt.trim().toLowerCase().replace(/\s+/g, ' ')
  return createHash('sha256').update(normalized).digest('hex')
}

export interface IdeaCandidate {
  niche: string
  prompt: string
}

export interface HashedIdea extends IdeaCandidate {
  hash: string
}

/**
 * Drop ideas whose normalized prompt already exists for this user (or earlier
 * in the same batch). The DB unique (user_id, uniqueness_hash) is the last
 * line of defence; this keeps Grok retries from hammering that constraint.
 */
export function filterNewIdeas(
  ideas: IdeaCandidate[],
  existingHashes: Iterable<string>,
): HashedIdea[] {
  const seen = new Set(existingHashes)
  const out: HashedIdea[] = []
  for (const idea of ideas) {
    const prompt = idea.prompt?.trim()
    const niche = idea.niche?.trim()
    if (!prompt || !niche) continue
    const hash = ideaUniquenessHash(prompt)
    if (seen.has(hash)) continue
    seen.add(hash)
    out.push({ niche, prompt, hash })
  }
  return out
}

export async function loadExistingIdeaHashes(userId: string): Promise<Set<string>> {
  const existing = await rows<{ uniqueness_hash: string }>(
    `SELECT uniqueness_hash FROM kling_idea_bank WHERE user_id = $1`,
    [userId],
  )
  return new Set(existing.map(r => r.uniqueness_hash))
}

export async function insertIdeaBankRows(
  userId: string,
  jobId: string | null,
  ideas: HashedIdea[],
): Promise<number> {
  let inserted = 0
  for (const idea of ideas) {
    const result = await query(
      `INSERT INTO kling_idea_bank (user_id, job_id, niche, prompt, uniqueness_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, uniqueness_hash) DO NOTHING`,
      [userId, jobId, idea.niche, idea.prompt, idea.hash],
    )
    inserted += result.rowCount ?? 0
  }
  return inserted
}

function pickNiches(n: number): { id: string; label: string; description: string }[] {
  const pool = [...NICHE_DEFINITIONS]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, Math.min(n, pool.length)).map(n => ({
    id: n.id,
    label: n.label,
    description: n.description,
  }))
}

function parseIdeaJson(raw: string): IdeaCandidate[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { ideas?: unknown })?.ideas
  if (!Array.isArray(list)) return []
  return list
    .map((item): IdeaCandidate | null => {
      if (!item || typeof item !== 'object') return null
      const rec = item as { niche?: unknown; prompt?: unknown; niche_id?: unknown }
      const niche = String(rec.niche_id ?? rec.niche ?? '').trim()
      const prompt = String(rec.prompt ?? '').trim()
      if (!niche || !prompt) return null
      return { niche, prompt }
    })
    .filter((x): x is IdeaCandidate => x !== null)
}

/**
 * Fresh motion-generation ideas inspired by the source, tagged with a niche.
 * Runs alongside 1fps analysis — these are banked, not rendered.
 */
export async function generateFreshIdeas(opts: {
  frames?: Pick<KlingFrameRow, 't_sec' | 'description'>[]
  context?: Partial<KlingVideoContext> | null
  sourceUrl: string
  count?: number
}): Promise<IdeaCandidate[]> {
  const count = opts.count ?? 8
  const niches = pickNiches(count)
  const frameNotes = (opts.frames ?? [])
    .slice(0, 6)
    .map(f => `${f.t_sec.toFixed(0)}s: ${f.description ?? ''}`)
    .filter(line => line.length > 4)
    .join('\n')

  const raw = await callGrok({
    model: GROK_FAST,
    json: true,
    temperature: 0.95,
    maxTokens: 2048,
    system:
      'You invent unique short-form video ideas for motion generation. ' +
      'Each idea must be a self-contained textual prompt describing a NEW scene, ' +
      'not a copy of the source. Return JSON: {"ideas":[{"niche_id":"...","prompt":"..."}]}',
    messages: [{
      role: 'user',
      content: [
        `Source reel: ${opts.sourceUrl}`,
        opts.context?.setting ? `Setting hint: ${opts.context.setting}` : '',
        opts.context?.character_action ? `Action hint: ${opts.context.character_action}` : '',
        frameNotes ? `A few source-frame notes (inspire, do not copy):\n${frameNotes}` : '',
        `Write exactly ${niches.length} unique ideas. Assign each to one of these niches (use the id):`,
        niches.map(n => `- ${n.id} (${n.label}): ${n.description}`).join('\n'),
        'Each prompt: 2–4 sentences, photoreal motion, camera, wardrobe, setting. No hashtags.',
      ].filter(Boolean).join('\n'),
    }],
  })

  const parsed = parseIdeaJson(raw)
  const allowed = new Set(niches.map(n => n.id))
  return parsed.map(idea => ({
    niche: allowed.has(idea.niche) ? idea.niche : (niches[0]?.id ?? idea.niche),
    prompt: idea.prompt,
  }))
}

export async function bankFreshIdeas(opts: {
  userId: string
  jobId: string | null
  sourceUrl: string
  frames?: Pick<KlingFrameRow, 't_sec' | 'description'>[]
  context?: Partial<KlingVideoContext> | null
}): Promise<number> {
  const existing = await loadExistingIdeaHashes(opts.userId)
  const generated = await generateFreshIdeas(opts)
  const fresh = filterNewIdeas(generated, existing)
  if (!fresh.length) return 0
  return insertIdeaBankRows(opts.userId, opts.jobId, fresh)
}
