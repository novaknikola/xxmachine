import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSeedanceI2VPayload,
  clampSeedanceDuration,
  SeedancePayloadError,
  SEEDANCE_I2V_MODELS,
  seedanceI2VEndpoint,
} from './seedance-client'

const IMAGE = 'https://example.com/still.jpg'
const META_OK = { contentType: 'image/jpeg', byteLength: 120_000, width: 720, height: 1280 }

describe('clampSeedanceDuration', () => {
  it('rounds and clamps into 4-30 for standard/turbo', () => {
    assert.equal(clampSeedanceDuration(2, 'standard'), 4)
    assert.equal(clampSeedanceDuration(4.4, 'standard'), 4)
    assert.equal(clampSeedanceDuration(7.5, 'standard'), 8)
    assert.equal(clampSeedanceDuration(30.2, 'standard'), 30)
    assert.equal(clampSeedanceDuration(40, 'standard'), 30)
    assert.equal(clampSeedanceDuration(null, 'standard'), 5)
    assert.equal(clampSeedanceDuration(Number.NaN, 'standard'), 5)
  })

  it('caps spicy at 15s, not 30', () => {
    assert.equal(clampSeedanceDuration(20, 'spicy'), 15)
    assert.equal(clampSeedanceDuration(30, 'spicy'), 15)
    assert.equal(clampSeedanceDuration(12, 'spicy'), 12)
  })
})

describe('buildSeedanceI2VPayload', () => {
  it('builds a minimal valid payload with defaults', () => {
    const payload = buildSeedanceI2VPayload({
      variant: 'standard',
      image: IMAGE,
      prompt: 'Begin from the start image. 0-5s: hold, eye-level.',
    }, META_OK)
    assert.equal(payload.image, IMAGE)
    assert.equal(payload.duration, 5)
    assert.equal(payload.resolution, '480p')
    assert.equal(payload.generate_audio, true)
    // Kling-only fields must never appear on a Seedance payload.
    assert.equal('cfg_scale' in payload, false)
    assert.equal('shot_type' in payload, false)
    assert.equal('multi_prompt' in payload, false)
    assert.equal('element_list' in payload, false)
    assert.equal('aspect_ratio' in payload, false)
  })

  it('requires a prompt on the standard endpoint', () => {
    assert.throws(
      () => buildSeedanceI2VPayload({ variant: 'standard', image: IMAGE }, META_OK),
      SeedancePayloadError,
    )
  })

  it('allows an empty prompt on the spicy endpoint', () => {
    const payload = buildSeedanceI2VPayload({ variant: 'spicy', image: IMAGE }, META_OK)
    assert.equal('prompt' in payload, false)
  })

  it('carries resolution/duration/generate_audio/last_image through untouched', () => {
    const payload = buildSeedanceI2VPayload({
      variant: 'standard',
      image: IMAGE,
      prompt: 'motion only',
      duration: 12,
      resolution: '1080p',
      generate_audio: false,
      last_image: 'https://example.com/end.jpg',
    }, META_OK)
    assert.equal(payload.duration, 12)
    assert.equal(payload.resolution, '1080p')
    assert.equal(payload.generate_audio, false)
    assert.equal(payload.last_image, 'https://example.com/end.jpg')
  })

  it('rejects an unsupported image content type', () => {
    assert.throws(
      () => buildSeedanceI2VPayload({
        variant: 'standard', image: IMAGE, prompt: 'x',
      }, { contentType: 'image/gif', byteLength: 1000, width: 720, height: 1280 }),
      /jpg\/png\/webp/,
    )
  })

  it('maps variants to model paths', () => {
    assert.equal(seedanceI2VEndpoint('standard'), `https://api.wavespeed.ai/api/v3/${SEEDANCE_I2V_MODELS.standard}`)
    assert.equal(seedanceI2VEndpoint('spicy'), `https://api.wavespeed.ai/api/v3/${SEEDANCE_I2V_MODELS.spicy}`)
    assert.equal(seedanceI2VEndpoint('turbo'), `https://api.wavespeed.ai/api/v3/${SEEDANCE_I2V_MODELS.turbo}`)
    assert.match(seedanceI2VEndpoint('standard'), /image-to-video$/)
  })
})
