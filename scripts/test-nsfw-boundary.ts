/**
 * Step 0 — boundary check: does Seedream Edit's `enable_safety_checker`-style
 * moderation block anything beyond a plain photo? Uses a moderate/suggestive
 * prompt (swimwear), NOT explicit, as a first calibration point.
 *
 *   npx tsx scripts/test-nsfw-boundary.ts
 */
import { resolve } from 'node:path'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { config as loadEnv } from 'dotenv'
loadEnv({ path: resolve(process.cwd(), '.env.local') })

const DIANA_REFS = [
  'https://gcvmuwlnrakhnxtstcpb.supabase.co/storage/v1/object/public/generations/inputs/f469a1b8-67fc-4103-8c6c-89e2873a1c7a/31db47dd-8357-4877-8075-39e5a47ce7ed.jpeg',
  'https://gcvmuwlnrakhnxtstcpb.supabase.co/storage/v1/object/public/generations/inputs/f469a1b8-67fc-4103-8c6c-89e2873a1c7a/abfb465e-d4c8-471d-a74a-03d08b0658b3.jpeg',
]

const PROMPT = `Keep the exact same face identity as the reference photos (same face, hair, skin tone). Change her outfit to a simple two-piece bikini, standing on a sunny beach, natural pose, photorealistic, phone-photo style.`

const OUT_DIR = resolve(process.cwd(), 'tmp-nsfw-boundary')

async function main() {
  const { editImage } = await import('../src/lib/wavespeed')
  const apiKey = process.env.WAVESPEED_API_KEY
  if (!apiKey) throw new Error('WAVESPEED_API_KEY missing')

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })

  console.log('Submitting Seedream Edit with a moderate (non-explicit) prompt…')
  const t0 = Date.now()
  try {
    const urls = await editImage({
      imageUrls: DIANA_REFS,
      prompt: PROMPT,
      size: '9:16',
      resolution: '1k',
      apiKey,
    })
    console.log(`Done in ${Date.now() - t0}ms`)
    console.log('Output URL(s):', urls)
    writeFileSync(resolve(OUT_DIR, 'result_url.txt'), urls.join('\n'))
    console.log(`\nSaved URL(s) to ${resolve(OUT_DIR, 'result_url.txt')}`)
    console.log('Open the URL yourself to verify the output visually — I did not fetch/view the image.')
  } catch (err) {
    console.error('FAILED / BLOCKED:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  }
}

main()
