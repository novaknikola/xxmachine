import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildKlingI2VPayload,
  clampKlingDuration,
  KlingPayloadError,
  KLING_I2V_MODELS,
  klingI2VEndpoint,
} from './kling-client'

const IMAGE = 'https://example.com/still.jpg'
const META_OK = { contentType: 'image/jpeg', byteLength: 120_000, width: 720, height: 1280 }

describe('clampKlingDuration', () => {
  it('rounds and clamps into 3–15', () => {
    assert.equal(clampKlingDuration(2), 3)
    assert.equal(clampKlingDuration(2.4), 3)
    assert.equal(clampKlingDuration(7.4), 7)
    assert.equal(clampKlingDuration(7.5), 8)
    assert.equal(clampKlingDuration(15.2), 15)
    assert.equal(clampKlingDuration(20), 15)
    assert.equal(clampKlingDuration(null), 5)
    assert.equal(clampKlingDuration(Number.NaN), 5)
  })
})

describe('buildKlingI2VPayload', () => {
  it('sends prompt XOR multi_prompt — prompt only', () => {
    const payload = buildKlingI2VPayload({
      variant: 'pro',
      image: IMAGE,
      prompt: 'walk toward camera',
    }, META_OK)
    assert.equal(payload.prompt, 'walk toward camera')
    assert.equal(payload.multi_prompt, undefined)
    assert.equal(payload.image, IMAGE)
    assert.equal(payload.duration, 5)
    assert.equal(payload.cfg_scale, 0.5)
    assert.equal(payload.sound, true)
    assert.equal(payload.shot_type, 'customize')
    assert.equal('resolution' in payload, false)
  })

  it('sends prompt XOR multi_prompt — multi_prompt only', () => {
    const payload = buildKlingI2VPayload({
      variant: 'std',
      image: IMAGE,
      multi_prompt: [
        { prompt: 'shot one', duration: 4 },
        { prompt: 'shot two', duration: 5 },
      ],
      duration: 9,
    }, META_OK)
    assert.equal(payload.prompt, undefined)
    assert.deepEqual(payload.multi_prompt, [
      { prompt: 'shot one', duration: 4 },
      { prompt: 'shot two', duration: 5 },
    ])
    assert.equal(payload.duration, 9)
  })

  it('rejects both prompt and multi_prompt', () => {
    assert.throws(
      () => buildKlingI2VPayload({
        variant: 'pro',
        image: IMAGE,
        prompt: 'hello',
        multi_prompt: [{ prompt: 'also hello' }],
      }, META_OK),
      KlingPayloadError,
    )
  })

  it('rejects neither prompt nor multi_prompt', () => {
    assert.throws(
      () => buildKlingI2VPayload({ variant: 'pro', image: IMAGE }, META_OK),
      KlingPayloadError,
    )
  })

  it('rejects end_image together with multi_prompt', () => {
    assert.throws(
      () => buildKlingI2VPayload({
        variant: 'pro',
        image: IMAGE,
        end_image: 'https://example.com/end.jpg',
        multi_prompt: [{ prompt: 'shot' }],
      }, META_OK),
      /end_image is incompatible/,
    )
  })

  it('allows end_image with a single prompt', () => {
    const payload = buildKlingI2VPayload({
      variant: '4k',
      image: IMAGE,
      prompt: 'hold then turn',
      end_image: 'https://example.com/end.jpg',
      duration: 6,
    }, META_OK)
    assert.equal(payload.end_image, 'https://example.com/end.jpg')
    assert.equal(payload.prompt, 'hold then turn')
    assert.equal(payload.multi_prompt, undefined)
  })

  it('never silently drops documented optional fields', () => {
    const payload = buildKlingI2VPayload({
      variant: 'pro',
      image: IMAGE,
      prompt: 'turn',
      negative_prompt: 'blur, text',
      duration: 12,
      cfg_scale: 0.8,
      sound: false,
      shot_type: 'intelligence',
      element_list: ['el_1', 'el_2'],
    }, META_OK)
    assert.equal(payload.negative_prompt, 'blur, text')
    assert.equal(payload.duration, 12)
    assert.equal(payload.cfg_scale, 0.8)
    assert.equal(payload.sound, false)
    assert.equal(payload.shot_type, 'intelligence')
    assert.deepEqual(payload.element_list, ['el_1', 'el_2'])
  })

  it('rejects images that violate Kling constraints', () => {
    assert.throws(
      () => buildKlingI2VPayload({
        variant: 'pro', image: IMAGE, prompt: 'x',
      }, { contentType: 'image/webp', byteLength: 1000, width: 720, height: 1280 }),
      /jpg\/jpeg\/png/,
    )
    assert.throws(
      () => buildKlingI2VPayload({
        variant: 'pro', image: IMAGE, prompt: 'x',
      }, { contentType: 'image/jpeg', byteLength: 11 * 1024 * 1024, width: 720, height: 1280 }),
      /≤10MB/,
    )
    assert.throws(
      () => buildKlingI2VPayload({
        variant: 'pro', image: IMAGE, prompt: 'x',
      }, { contentType: 'image/jpeg', byteLength: 1000, width: 200, height: 400 }),
      /300px/,
    )
    assert.throws(
      () => buildKlingI2VPayload({
        variant: 'pro', image: IMAGE, prompt: 'x',
      }, { contentType: 'image/jpeg', byteLength: 1000, width: 2000, height: 400 }),
      /aspect/,
    )
  })

  it('maps variants to model paths with no resolution query', () => {
    assert.equal(klingI2VEndpoint('pro'), `https://api.wavespeed.ai/api/v3/${KLING_I2V_MODELS.pro}`)
    assert.equal(klingI2VEndpoint('std'), `https://api.wavespeed.ai/api/v3/${KLING_I2V_MODELS.std}`)
    assert.equal(klingI2VEndpoint('4k'), `https://api.wavespeed.ai/api/v3/${KLING_I2V_MODELS['4k']}`)
    assert.match(klingI2VEndpoint('pro'), /image-to-video$/)
    assert.doesNotMatch(klingI2VEndpoint('pro'), /resolution/)
  })
})
