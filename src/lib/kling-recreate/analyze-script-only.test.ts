import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { capShotsDuration, parseSynthesizedContext } from './analyze'

describe('parseSynthesizedContext', () => {
  it('parses a full response, caps shots at 6, and normalizes capture_style', () => {
    const parsed = parseSynthesizedContext({
      setting: 'A bright kitchen.',
      hook: 'She catches him mid-lie.',
      character_action: 'She walks in, he freezes, she laughs.',
      camera: 'Wide, then a push in.',
      speech: 'Hi(0.0-0.3) there(0.3-0.6)',
      capture_style: 'produced',
      master_prompt: 'A bright kitchen. She walks in.',
      shots: [
        { t_start: 0, t_end: 2, prompt: 'She walks in.' },
        { t_start: 2, t_end: 4, prompt: 'He freezes.' },
        { t_start: 4, t_end: 6, prompt: 'She laughs.' },
        { t_start: 6, t_end: 8, prompt: 'Beat 4.' },
        { t_start: 8, t_end: 10, prompt: 'Beat 5.' },
        { t_start: 10, t_end: 12, prompt: 'Beat 6.' },
        { t_start: 12, t_end: 14, prompt: 'Beat 7 — should be dropped.' },
      ],
    })
    assert.equal(parsed.setting, 'A bright kitchen.')
    assert.equal(parsed.capture_style, 'produced')
    assert.equal(parsed.shots.length, 6)
    assert.equal(parsed.shots[5].prompt, 'Beat 6.')
  })

  it('defaults capture_style to phone and drops shot entries with no prompt', () => {
    const parsed = parseSynthesizedContext({
      setting: 'A car interior.',
      shots: [
        { t_start: 0, t_end: 2, prompt: '  ' },
        { t_start: 2, t_end: 4, prompt: 'She talks to camera.' },
        { t_start: 3 },
        null,
      ],
    })
    assert.equal(parsed.capture_style, 'phone')
    assert.equal(parsed.shots.length, 1)
    assert.equal(parsed.shots[0].prompt, 'She talks to camera.')
  })

  it('treats a missing/empty speech field as null, not the string "null"', () => {
    const parsed = parseSynthesizedContext({ setting: 'x', shots: [] })
    assert.equal(parsed.speech, null)
  })
})

describe('capShotsDuration', () => {
  const SHOTS = [
    { t_start: 0, t_end: 5, prompt: 'a' },
    { t_start: 5, t_end: 12, prompt: 'b' },
    { t_start: 12, t_end: 20, prompt: 'c — overruns the cap' },
    { t_start: 20, t_end: 27, prompt: 'd — starts past the cap, dropped entirely' },
  ]

  it('trims a shot that overruns the cap and drops any that start past it', () => {
    const capped = capShotsDuration(SHOTS, 15)
    assert.equal(capped.length, 3)
    assert.equal(capped[2].t_end, 15)
    assert.equal(capped[2].prompt, 'c — overruns the cap')
  })

  it('leaves shots untouched when nothing exceeds the cap', () => {
    const short = [{ t_start: 0, t_end: 10, prompt: 'a' }]
    assert.deepEqual(capShotsDuration(short, 15), short)
  })

  it('returns an empty list unchanged', () => {
    assert.deepEqual(capShotsDuration([], 15), [])
  })
})
