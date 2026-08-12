/**
 * Seeds carousel_pose_prompts with a large random pool of pose-edit
 * instructions, replacing the small hardcoded CAROUSEL_POSE_VARIANTS list.
 * Seeded from carousel-presets.ts's body-language/mood-shift/candid-dump
 * prompts (natural, photographic, already used in production elsewhere in
 * this app) as few-shot style examples, expanded via the existing
 * generatePromptVariants() Grok helper.
 *
 * Resumable: safe to re-run after a crash/timeout — reads the current count
 * and seed presence from the DB rather than assuming a fresh start.
 *
 *   npx tsx scripts/seed-carousel-pose-prompts.ts [target=300]
 */
import { resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'
loadEnv({ path: resolve(process.cwd(), '.env.local') })

const SEED_EXAMPLES = [
  // body-language
  'Leaning against wall — casual, one shoulder back, relaxed gaze.',
  'Seated relaxed — sitting naturally, weight to one side, comfortable and open.',
  'Dynamic movement — mid-step or turning, energy and motion implied.',
  'Intimate and close — leaning toward camera, soft and inviting.',
  'Standing tall — confident upright posture, hands relaxed at sides.',
  'Looking away from camera, candid over-the-shoulder moment.',
  // mood-shift
  'Neutral calm expression — composed, still, direct eye contact, serene.',
  'Head thrown back laughing — full candid laugh, natural and unguarded.',
  'Thoughtful and distant — looking away, slightly introspective.',
  'Playful smirk — one eyebrow raised, teasing expression.',
  'Direct intense gaze — chin slightly lowered, eyes locked on camera.',
  // candid-dump
  'Street walk — caught mid-stride, golden hour, casual outfit.',
  'Morning routine — sipping coffee by window, soft natural light, cozy and unstaged.',
  'Thoughtful pause — looking down then glancing up at camera, natural transition.',
  'Wind in hair — caught mid-movement, hair lifted, candid energy.',
]

const HINT =
  'These are SHORT pose/body-language edit instructions only (one sentence each) — NOT full photo ' +
  "descriptions. They are used to edit an EXISTING photo, changing ONLY the subject's pose/body-language/" +
  'action, while identity, outfit and environment stay exactly the same. Keep every prompt to ONE sentence, ' +
  'natural photographic direction language (like a photographer coaching a model) — never exaggerated, ' +
  'cartoonish, or theatrical wording.'

const TARGET = Number(process.argv[2]) || 300
const BATCH_SIZE = 20
const MAX_ATTEMPTS = 60

async function main() {
  const { generatePromptVariants } = await import('../src/lib/prompt-variants')
  const { query, one, rows } = await import('../src/lib/db')

  const seedCount = await one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM carousel_pose_prompts WHERE source = 'preset'`)
  if (!seedCount || seedCount.n === 0) {
    for (const p of SEED_EXAMPLES) {
      await query(`INSERT INTO carousel_pose_prompts (prompt_text, source) VALUES ($1, 'preset')`, [p])
    }
    console.log(`Seeded ${SEED_EXAMPLES.length} preset prompt(s).`)
  } else {
    console.log(`Preset seed already present (${seedCount.n}), skipping re-seed.`)
  }

  const existing = await rows<{ prompt_text: string }>(`SELECT prompt_text FROM carousel_pose_prompts`)
  const seen = new Set(existing.map(r => r.prompt_text.toLowerCase().trim()))
  let total = existing.length
  console.log(`Currently stored: ${total}. Generating toward ${TARGET}…`)

  let attempts = 0
  while (total < TARGET && attempts < MAX_ATTEMPTS) {
    attempts++
    const n = Math.min(BATCH_SIZE, TARGET - total)
    try {
      const batch = await generatePromptVariants(SEED_EXAMPLES, n, HINT)
      let added = 0
      for (const p of batch) {
        const key = p.toLowerCase().trim()
        if (seen.has(key)) continue
        seen.add(key)
        await query(`INSERT INTO carousel_pose_prompts (prompt_text, source) VALUES ($1, 'grok')`, [p])
        total++
        added++
      }
      console.log(`  attempt ${attempts}: +${added} new (${total}/${TARGET})`)
    } catch (err) {
      // Covers both Grok failures AND transient DB/network errors (e.g. the
      // pooled Postgres connection timing out during a slow Grok call) —
      // nothing here is fatal, just retry the next iteration.
      console.error(`  attempt ${attempts} failed, retrying:`, err instanceof Error ? err.message : err)
    }
  }

  console.log(`\nDone. ${total} prompts stored (${attempts} attempt(s) this run).`)
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
