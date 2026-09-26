import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifySeedanceSubmitFailure,
  generateSeedanceI2V,
  SeedanceSubmitError,
  type SeedanceI2VInput,
} from './seedance-client'
import { approvePromptDisposition } from './process-job'
import type { KlingRecreateJobRow } from './types'

const INPUT: SeedanceI2VInput = {
  variant: 'standard',
  image: 'https://example.com/still.jpg',
  prompt: 'Begin from the start image. 0-5s: hold.',
  duration: 5,
}

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** submit -> `submit(callIndex)`; poll -> `poll(callIndex)`. Returns every URL hit. */
function mockWaveSpeed(handlers: {
  submit?: (n: number) => Response | Error
  poll?: (n: number) => Response | Error
}) {
  const calls: string[] = []
  let submitN = 0
  let pollN = 0
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url)
    calls.push(u)
    const r = u.includes('/predictions/') ? handlers.poll?.(pollN++) : handlers.submit?.(submitN++)
    if (r instanceof Error) throw r
    if (!r) throw new Error(`unexpected fetch ${u}`)
    return r
  }) as typeof fetch
  return calls
}

describe('classifySeedanceSubmitFailure', () => {
  it('credit problems are recognised by message or 402 and never retried', () => {
    assert.equal(classifySeedanceSubmitFailure(400, 'Insufficient credits. Please top up your account to continue.'), 'credits')
    assert.equal(classifySeedanceSubmitFailure(402, 'payment required'), 'credits')
  })
  it('auth failures', () => {
    assert.equal(classifySeedanceSubmitFailure(401, 'bad key'), 'auth')
    assert.equal(classifySeedanceSubmitFailure(403, 'forbidden'), 'auth')
  })
  it('other 4xx are invalid-request', () => {
    assert.equal(classifySeedanceSubmitFailure(400, 'image must be jpg/png/webp'), 'invalid')
    assert.equal(classifySeedanceSubmitFailure(422, 'bad duration'), 'invalid')
    assert.equal(classifySeedanceSubmitFailure(404, 'no such model'), 'invalid')
  })
  it('network errors, 408/425/429 and 5xx are transient', () => {
    for (const s of [null, 408, 425, 429, 500, 502, 503, 504]) {
      assert.equal(classifySeedanceSubmitFailure(s, 'x'), 'transient', String(s))
    }
  })
})

describe('generateSeedanceI2V submit failures', () => {
  it('HTTP 400 insufficient credits -> non-retryable SeedanceSubmitError, no poll', async () => {
    const calls = mockWaveSpeed({
      submit: () => json(400, { code: 400, message: 'Insufficient credits. Please top up your account to continue.' }),
    })
    await assert.rejects(
      () => generateSeedanceI2V(INPUT, 'key', { pollIntervalMs: 1 }),
      (e: unknown) => {
        assert.ok(e instanceof SeedanceSubmitError)
        assert.equal(e.kind, 'credits')
        assert.equal(e.status, 400)
        assert.equal(e.retryable, false)
        assert.match(e.message, /Insufficient credits/)
        return true
      },
    )
    assert.equal(calls.length, 1)
  })

  it('HTTP 503 -> retryable', async () => {
    mockWaveSpeed({ submit: () => json(503, { message: 'upstream busy' }) })
    await assert.rejects(
      () => generateSeedanceI2V(INPUT, 'key', { pollIntervalMs: 1 }),
      (e: unknown) => e instanceof SeedanceSubmitError && e.retryable && e.status === 503,
    )
  })

  it('a rejected fetch (network) -> retryable with no status', async () => {
    mockWaveSpeed({ submit: () => new TypeError('fetch failed') })
    await assert.rejects(
      () => generateSeedanceI2V(INPUT, 'key', { pollIntervalMs: 1 }),
      (e: unknown) => e instanceof SeedanceSubmitError && e.retryable && e.status === null && /network/.test(e.message),
    )
  })

  it('HTTP 200 with a non-200 body code is still a failed submit', async () => {
    mockWaveSpeed({ submit: () => json(200, { code: 401, message: 'invalid api key' }) })
    await assert.rejects(
      () => generateSeedanceI2V(INPUT, 'key', { pollIntervalMs: 1 }),
      (e: unknown) => e instanceof SeedanceSubmitError && e.kind === 'auth',
    )
  })

  it('a 200 response without a request id is a (retryable) failed submit', async () => {
    mockWaveSpeed({ submit: () => json(200, { code: 200, data: {} }) })
    await assert.rejects(
      () => generateSeedanceI2V(INPUT, 'key', { pollIntervalMs: 1 }),
      (e: unknown) => e instanceof SeedanceSubmitError && e.retryable,
    )
  })
})

describe('generateSeedanceI2V after a successful submit', () => {
  it('records the prediction id, then returns the video', async () => {
    const calls = mockWaveSpeed({
      submit: () => json(200, { code: 200, data: { id: 'pred-1' } }),
      poll: n => json(200, { data: n < 1 ? { status: 'processing' } : { status: 'completed', outputs: ['https://cdn/out.mp4'] } }),
    })
    let recorded: string | null = null
    const res = await generateSeedanceI2V(INPUT, 'key', {
      pollIntervalMs: 1,
      onSubmitted: async id => { recorded = id },
    })
    assert.equal(res.videoUrl, 'https://cdn/out.mp4')
    assert.equal(res.requestId, 'pred-1')
    assert.equal(recorded, 'pred-1')
    assert.equal(calls.filter(u => u.includes('/predictions/')).length, 2)
  })

  it('a failing onSubmitted (DB write) does not abort a render that already exists', async () => {
    mockWaveSpeed({
      submit: () => json(200, { code: 200, data: { id: 'pred-2' } }),
      poll: () => json(200, { data: { status: 'completed', outputs: ['https://cdn/ok.mp4'] } }),
    })
    const res = await generateSeedanceI2V(INPUT, 'key', {
      pollIntervalMs: 1,
      onSubmitted: async () => { throw new Error('db down') },
    })
    assert.equal(res.videoUrl, 'https://cdn/ok.mp4')
  })

  it('a render that FAILS after submit is a plain Error, never a SeedanceSubmitError (it may have billed)', async () => {
    mockWaveSpeed({
      submit: () => json(200, { code: 200, data: { id: 'pred-3' } }),
      poll: () => json(200, { data: { status: 'failed', error: 'model error' } }),
    })
    await assert.rejects(
      () => generateSeedanceI2V(INPUT, 'key', { pollIntervalMs: 1 }),
      (e: unknown) => e instanceof Error && !(e instanceof SeedanceSubmitError) && /failed/.test(e.message),
    )
  })

  it('resuming with an existing prediction id never submits again', async () => {
    const calls = mockWaveSpeed({
      poll: () => json(200, { data: { status: 'completed', outputs: ['https://cdn/resumed.mp4'] } }),
    })
    const res = await generateSeedanceI2V(INPUT, 'key', { existingRequestId: 'pred-9', pollIntervalMs: 1 })
    assert.equal(res.videoUrl, 'https://cdn/resumed.mp4')
    assert.equal(res.requestId, 'pred-9')
    assert.ok(calls.every(u => u.includes('/predictions/pred-9/')), calls.join(','))
  })
})

describe('approvePromptDisposition', () => {
  const req = (extra: Record<string, unknown> = {}) => ({ image: 'x', prompt: 'p', ...extra })

  it('a finished job is cached', () => {
    assert.equal(approvePromptDisposition({ status: 'done', kling_video_url: 'v', kling_request: req() }, 'q1'), 'cached')
  })
  it('the normal first approval runs', () => {
    assert.equal(approvePromptDisposition({ status: 'awaiting_prompt_approval', kling_video_url: null, kling_request: req() }, 'q1'), 'run')
  })
  it('no stored request -> ignore', () => {
    assert.equal(approvePromptDisposition({ status: 'awaiting_prompt_approval', kling_video_url: null, kling_request: null }, 'q1'), 'ignore')
  })
  it('rendering + prediction id from THIS queue row -> resume', () => {
    const r = req({ _prediction_id: 'p1', _queue_job_id: 'q1' })
    assert.equal(approvePromptDisposition({ status: 'rendering', kling_video_url: null, kling_request: r }, 'q1'), 'resume')
  })
  it('rendering + prediction id from ANOTHER queue row (double tap) -> ignore, so it cannot double-deliver', () => {
    const r = req({ _prediction_id: 'p1', _queue_job_id: 'q1' })
    assert.equal(approvePromptDisposition({ status: 'rendering', kling_video_url: null, kling_request: r }, 'q2'), 'ignore')
  })
  it('rendering without a prediction id -> ignore (a submit is in flight elsewhere)', () => {
    assert.equal(approvePromptDisposition({ status: 'rendering', kling_video_url: null, kling_request: req() }, 'q1'), 'ignore')
  })
  it('any other stage -> ignore', () => {
    const others = ['failed', 'still', 'awaiting_dialogue_approval', 'analyzing'] as unknown as KlingRecreateJobRow['status'][]
    for (const status of others) {
      assert.equal(
        approvePromptDisposition({ status, kling_video_url: null, kling_request: req({ _prediction_id: 'p', _queue_job_id: 'q1' }) }, 'q1'),
        'ignore',
        status,
      )
    }
  })
})
