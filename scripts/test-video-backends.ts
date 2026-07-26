/**
 * Unit-style checks for video backend routing + payloads (no live WaveSpeed calls).
 *   npx tsx scripts/test-video-backends.ts
 */
import {
  defaultBackendForTechnique,
  resolveVideoBackend,
  VIDEO_BACKEND_OPTIONS,
  type VideoBackend,
} from '../src/lib/monitor/video-backends'
import type { VideoTechnique } from '../src/lib/monitor/types'

let failed = 0
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL', msg)
    failed++
  } else {
    console.log('ok ', msg)
  }
}

const techniques: VideoTechnique[] = [
  'motion_transfer', 'image_to_video', 'first_last_frame', 'multi_shot', 'extend', 'unknown',
]

console.log('— Auto defaults —')
assert(defaultBackendForTechnique('motion_transfer') === 'kling_mc', 'motion → kling')
assert(defaultBackendForTechnique('multi_shot') === 'kling_mc', 'multi → kling')
assert(defaultBackendForTechnique('image_to_video') === 'seedance_i2v', 'i2v → seedance')
assert(defaultBackendForTechnique('first_last_frame') === 'seedance_i2v', 'flf → seedance')

console.log('\n— Resolve —')
const ms = resolveVideoBackend('auto', 'multi_shot')
assert(ms.useMultiShotQueue === true, 'auto multi_shot uses queue')
assert(ms.backend === 'kling_mc', 'auto multi_shot backend kling')

const msSeed = resolveVideoBackend('seedance_i2v', 'multi_shot')
assert(msSeed.useMultiShotQueue === false, 'seedance multi_shot is one-shot I2V')
assert(msSeed.model.includes('seedance'), 'seedance model path')

const kling = resolveVideoBackend('kling_mc', 'image_to_video')
assert(kling.needsSourceVideo === true, 'forced kling needs source video')

const seed = resolveVideoBackend('auto', 'image_to_video')
assert(seed.needsMotionPrompt === true, 'seedance needs motion prompt')
assert(seed.needsSourceVideo === false, 'seedance does not need source video')

const flf = resolveVideoBackend('seedance_i2v', 'first_last_frame')
assert(flf.needsEndImage === true, 'seedance FLF needs end image')
const flfPayload = flf.buildPayload({
  imageUrl: 'https://example.com/a.jpg',
  endImageUrl: 'https://example.com/b.jpg',
  motionPrompt: 'walks to podium',
  duration: 7.2,
})
assert(flfPayload.last_image === 'https://example.com/b.jpg', 'FLF payload has last_image')
assert(flfPayload.duration === 7, 'seedance duration clamped round')
assert(flfPayload.aspect_ratio === '9:16', 'seedance 9:16')

const ltx = resolveVideoBackend('ltx_i2v_lora', 'image_to_video')
assert(ltx.needsLora === true, 'ltx lora needs lora')
const ltxPayload = ltx.buildPayload({
  imageUrl: 'https://example.com/a.jpg',
  motionPrompt: 'turns and smiles',
  duration: 12,
  loraUrl: 'https://example.com/lora.safetensors',
  loraScale: 0.85,
})
assert(Array.isArray(ltxPayload.loras), 'ltx payload has loras')
assert(ltxPayload.duration === 12, 'ltx duration 12')

console.log('\n— UI options —')
assert(VIDEO_BACKEND_OPTIONS.includes('auto'), 'options include auto')
assert(VIDEO_BACKEND_OPTIONS.includes('seedance_i2v_turbo'), 'options include turbo')
assert(VIDEO_BACKEND_OPTIONS.includes('ltx_i2v'), 'options include ltx')

console.log('\n— Payload smoke for each technique × auto —')
for (const t of techniques) {
  const r = resolveVideoBackend('auto', t)
  console.log(`  ${t.padEnd(18)} → ${r.backend.padEnd(18)} queue=${r.useMultiShotQueue} model=${r.model}`)
}

const backends: VideoBackend[] = [
  'kling_mc', 'wan_i2v', 'seedance_i2v', 'seedance_i2v_turbo', 'ltx_i2v', 'ltx_i2v_lora',
]
console.log('\n— Forced backends on image_to_video —')
for (const b of backends) {
  const r = resolveVideoBackend(b, 'image_to_video')
  const p = r.buildPayload({
    imageUrl: 'https://example.com/a.jpg',
    sourceVideoUrl: 'https://example.com/v.mp4',
    motionPrompt: 'subtle motion',
    duration: 5,
    loraUrl: 'https://example.com/l.safetensors',
  })
  assert(Boolean(r.model), `${b} has model`)
  assert(typeof p === 'object', `${b} builds payload`)
  console.log(`  ${b} → keys: ${Object.keys(p).join(', ')}`)
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll video-backend checks passed.')
