import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSeedancePrompt, endFrameInstruction, renderFaceEndFramePrompt, FACE_END_SECONDS } from './seedance-prompt'
import { stillApprovalKeyboard } from '@/lib/telegram-recreate'
import type { KlingVideoContext } from './types'

const baseCtx: KlingVideoContext = {
  setting: 'kitchen', hook: '', character_action: 'she talks to camera', camera: 'handheld, eye-level',
  speech: null, duration_sec: 8, aspect_ratio: '9:16', shots: [], prompt_mode: 'prompt',
}

test('only face mode adds an end-image rule', () => {
  assert.equal(endFrameInstruction('scene', 8), '')
  assert.equal(endFrameInstruction('none', 8), '')
  assert.equal(endFrameInstruction(null, 8), '')
  assert.equal(endFrameInstruction(undefined, 8), '')
  const rule = endFrameInstruction('face', 8)
  assert.match(rule, /close-up of the lead character's face/)
  assert.match(rule, /"7\.5-8s: quick push-in/)
})

test('face rule falls back to a duration-free wording when the length is unknown', () => {
  const rule = endFrameInstruction('face', null)
  assert.match(rule, new RegExp(`LAST ${FACE_END_SECONDS} seconds`))
  assert.doesNotMatch(rule, /"\d/)
})

test('no-beats prompt: face mode splits off the closing 0.5s, other modes are unchanged', async () => {
  const scene = await buildSeedancePrompt(baseCtx, null, 'scene')
  const none = await buildSeedancePrompt(baseCtx, null, 'none')
  const legacy = await buildSeedancePrompt(baseCtx, null)
  assert.equal(scene, legacy)
  assert.equal(none, legacy)
  assert.match(legacy, /0-8s: she talks to camera handheld, eye-level/)

  const face = await buildSeedancePrompt(baseCtx, null, 'face')
  assert.match(face, /0-7\.5s: she talks to camera/)
  assert.match(face, /7\.5-8s: Quick push-in to a close-up on her face/)
})

test('face end-frame edit prompt: names the lead, locks the face, keeps the scene', () => {
  const single = renderFaceEndFramePrompt(baseCtx, [{ name: null }])
  assert.match(single, /CLOSE-UP of the main character/)
  assert.match(single, /image 2 is the identity reference photo/)
  const multi = renderFaceEndFramePrompt(baseCtx, [{ name: 'Tiana' }, { name: 'Marcus' }])
  assert.match(multi, /CLOSE-UP of "Tiana"/)
  assert.match(multi, /Show only this one character/)
})

test('still gate offers all four choices with distinct callbacks', () => {
  const kb = stillApprovalKeyboard('job-1')
  const cbs = kb.inline_keyboard.flat().map(b => b.callback_data)
  assert.deepEqual(cbs, ['kr:stillok:job-1', 'kr:stillnoend:job-1', 'kr:stillface:job-1', 'kr:stillrg:job-1'])
})
