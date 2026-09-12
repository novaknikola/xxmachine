import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyVariationDelta,
  applyVariationToKlingInput,
  buildVariationJobDrafts,
  clampVariationCount,
  parseVariationCallback,
  parseVariationRequest,
  planVariationCallback,
  isVariationAwaiting,
  variationAwaitingJobId,
  variationAwaitingValue,
  variationSkipsUpstream,
  VARIATION_INSTRUCTION,
} from './variation'
import type { KlingI2VInput } from './kling-client'

const PARENT = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  source_url: 'https://www.instagram.com/reel/AbC123xyz/',
  video_url: 'https://cdn.example/source.mp4',
  duration_sec: 8,
  reference_image_url: 'https://cdn.example/ref.jpg',
  character_image_url: 'https://cdn.example/still.jpg',
  master_prompt: 'A woman pours coffee in a sunlit kitchen.',
  context: {
    setting: 'kitchen',
    character_action: 'pours coffee',
    camera: 'handheld',
    speech: null,
    duration_sec: 8,
    aspect_ratio: '9:16',
    shots: [] as { t_start: number; t_end: number; prompt: string }[],
    prompt_mode: 'prompt' as const,
  },
  settings: { variant: 'pro' as const },
}

describe('clampVariationCount', () => {
  it('clamps into 1–6', () => {
    assert.equal(clampVariationCount(0), 1)
    assert.equal(clampVariationCount(1), 1)
    assert.equal(clampVariationCount(6), 6)
    assert.equal(clampVariationCount(7), 6)
    assert.equal(clampVariationCount(99), 6)
    assert.equal(clampVariationCount(Number.NaN), 1)
  })
})

describe('parseVariationRequest', () => {
  it('parses change + trailing count', () => {
    const got = parseVariationRequest('softer smile, 3')
    assert.equal(got.change, 'softer smile')
    assert.equal(got.count, 3)
  })

  it('parses a leading count on its own line', () => {
    const got = parseVariationRequest('3\nwarmer lighting, look at camera')
    assert.equal(got.change, 'warmer lighting, look at camera')
    assert.equal(got.count, 3)
  })

  it('parses count: N', () => {
    const got = parseVariationRequest('make it night, count: 2')
    assert.equal(got.change, 'make it night')
    assert.equal(got.count, 2)
  })

  it('defaults to 1 when the number is omitted', () => {
    const got = parseVariationRequest('warmer lighting, look at camera')
    assert.equal(got.change, 'warmer lighting, look at camera')
    assert.equal(got.count, 1)
  })

  it('caps count at 6', () => {
    assert.equal(parseVariationRequest('softer smile, 20').count, 6)
  })

  it('requires change text', () => {
    assert.equal(parseVariationRequest('3').change, null)
    assert.equal(parseVariationRequest('count: 2').change, null)
    assert.equal(parseVariationRequest('   ').change, null)
  })
})

describe('variation prompt = parent + delta', () => {
  it('appends a clear instruction to a single prompt', () => {
    const combined = applyVariationDelta(PARENT.master_prompt, 'softer smile')
    assert.ok(combined.startsWith(PARENT.master_prompt))
    assert.ok(combined.includes(VARIATION_INSTRUCTION))
    assert.ok(combined.includes('softer smile'))
  })

  it('keeps prompt XOR multi_prompt and applies the delta to the active one', () => {
    const single = applyVariationToKlingInput({
      variant: 'pro',
      image: PARENT.character_image_url,
      prompt: PARENT.master_prompt,
    }, 'make it night')
    assert.ok(single.prompt?.includes(PARENT.master_prompt))
    assert.ok(single.prompt?.includes('make it night'))
    assert.equal(single.multi_prompt, undefined)

    const multiIn: KlingI2VInput = {
      variant: 'pro',
      image: PARENT.character_image_url,
      multi_prompt: [
        { prompt: 'shot one', duration: 4 },
        { prompt: 'shot two', duration: 4 },
      ],
    }
    const multi = applyVariationToKlingInput(multiIn, 'look at camera')
    assert.equal(multi.prompt, undefined)
    assert.equal(multi.multi_prompt?.length, 2)
    assert.ok(multi.multi_prompt?.[0].prompt.includes('shot one'))
    assert.ok(multi.multi_prompt?.[0].prompt.includes('look at camera'))
    assert.ok(multi.multi_prompt?.[1].prompt.includes('shot two'))
  })
})

describe('variation jobs skip scrape/still', () => {
  it('drafts N children that start at Kling render with the parent still', () => {
    const drafts = buildVariationJobDrafts(PARENT, 'softer smile', 3)
    assert.equal(drafts.length, 3)
    for (const d of drafts) {
      assert.equal(d.skipScrape, true)
      assert.equal(d.skipAnalyze, true)
      assert.equal(d.skipStill, true)
      assert.equal(d.skipIdeas, true)
      assert.equal(d.characterImageUrl, PARENT.character_image_url)
      assert.equal(d.masterPrompt, PARENT.master_prompt)
      assert.equal(d.variationNote, 'softer smile')
      assert.equal(d.parentJobId, PARENT.id)
      assert.ok(d.klingPrompt.includes(PARENT.master_prompt))
      assert.ok(d.klingPrompt.includes('softer smile'))
      assert.ok(variationSkipsUpstream({ parent_job_id: d.parentJobId }))
    }
    assert.equal(variationSkipsUpstream({ parent_job_id: null }), false)
  })

  it('rejects a missing change and a parent without a still', () => {
    assert.throws(() => buildVariationJobDrafts(PARENT, '   ', 1), /Change text/)
    assert.throws(
      () => buildVariationJobDrafts({ ...PARENT, character_image_url: null }, 'softer smile', 1),
      /character still/,
    )
  })
})

describe('variation awaiting is not a reel URL', () => {
  it('stores variation:<jobId> and extracts the job id', () => {
    const awaiting = variationAwaitingValue(PARENT.id)
    assert.equal(isVariationAwaiting(awaiting), true)
    assert.equal(variationAwaitingJobId(awaiting), PARENT.id)
    assert.equal(isVariationAwaiting('negative_prompt'), false)
    assert.equal(variationAwaitingJobId('negative_prompt'), null)
    assert.equal(variationAwaitingJobId('variation:not-a-uuid'), null)
  })
})

describe('skip does not enqueue', () => {
  it('Skip is a no-op; Change anything? only waits for the next message', () => {
    assert.deepEqual(planVariationCallback('skip'), { enqueueCount: 0, awaitPrompt: false })
    assert.deepEqual(planVariationCallback('change'), { enqueueCount: 0, awaitPrompt: true })
    const skip = parseVariationCallback(`kr:skip:${PARENT.id}`)
    assert.equal(skip?.action, 'skip')
    assert.equal(planVariationCallback(skip!.action).enqueueCount, 0)
    const change = parseVariationCallback(`kr:var:${PARENT.id}`)
    assert.equal(change?.action, 'change')
    assert.equal(planVariationCallback(change!.action).enqueueCount, 0)
  })
})
