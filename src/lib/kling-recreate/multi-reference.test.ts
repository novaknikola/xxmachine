import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { identityLines } from './seedance-prompt'
import { namedPhotosFromRow } from './process-job'
import type { KlingRecreateJobRow } from './types'

const BASE_ROW: Pick<KlingRecreateJobRow, 'reference_image_url' | 'reference_photos' | 'is_script_only' | 'lead_character' | 'custom_prompt'> = {
  reference_image_url: null,
  reference_photos: null,
  is_script_only: false,
  lead_character: null,
  custom_prompt: null,
}

describe('namedPhotosFromRow', () => {
  it('falls back to the single unnamed reference photo when nothing else is set', () => {
    const photos = namedPhotosFromRow({ ...BASE_ROW, reference_image_url: 'https://x/ref.jpg' } as KlingRecreateJobRow)
    assert.deepEqual(photos, [{ name: null, url: 'https://x/ref.jpg' }])
  })

  it('labels the single photo with custom_prompt for a normal job', () => {
    const photos = namedPhotosFromRow({
      ...BASE_ROW, reference_image_url: 'https://x/ref.jpg', custom_prompt: 'the maid',
    } as KlingRecreateJobRow)
    assert.deepEqual(photos, [{ name: 'the maid', url: 'https://x/ref.jpg' }])
  })

  it('labels the single photo with lead_character for a script-only job', () => {
    const photos = namedPhotosFromRow({
      ...BASE_ROW, reference_image_url: 'https://x/ref.jpg', is_script_only: true, lead_character: 'Tiana',
      custom_prompt: 'a whole script that is not a role label',
    } as KlingRecreateJobRow)
    assert.deepEqual(photos, [{ name: 'Tiana', url: 'https://x/ref.jpg' }])
  })

  it('prefers reference_photos over reference_image_url when both are present', () => {
    const photos = namedPhotosFromRow({
      ...BASE_ROW,
      reference_image_url: 'https://x/fallback.jpg',
      reference_photos: { Tiana: 'https://x/tiana.jpg', Dianna: 'https://x/dianna.jpg' },
    } as KlingRecreateJobRow)
    assert.deepEqual(photos, [
      { name: 'Tiana', url: 'https://x/tiana.jpg' },
      { name: 'Dianna', url: 'https://x/dianna.jpg' },
    ])
  })

  it('returns an empty list when there is no photo of any kind', () => {
    assert.deepEqual(namedPhotosFromRow({ ...BASE_ROW } as KlingRecreateJobRow), [])
  })
})

describe('identityLines', () => {
  it('uses the original generic single-lead wording when there is one unnamed photo', () => {
    const line = identityLines([{ name: null }], 1)
    assert.match(line, /single main character in this scene/)
  })

  it('names the single photo\'s role when given', () => {
    const line = identityLines([{ name: 'the maid' }], 1)
    assert.match(line, /identity reference for "the maid"/)
    assert.doesNotMatch(line, /Image 1/)
  })

  it('maps each photo to an image index for multiple identities', () => {
    const line = identityLines([{ name: 'Tiana' }, { name: 'Dianna' }], 2)
    assert.match(line, /Image 2 is the identity reference for "Tiana"/)
    assert.match(line, /Image 3 is the identity reference for "Dianna"/)
  })
})
