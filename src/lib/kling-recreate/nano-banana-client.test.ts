import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { editImageNanoBananaPro } from './nano-banana-client'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const INPUT = { imageUrls: ['https://example.com/a.jpg'], prompt: 'p', apiKey: 'k', pollIntervalMs: 1 }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function mock(submit: () => Response | Error, poll: (n: number) => Response | Error) {
  let pollN = 0
  const calls: string[] = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url)
    calls.push(u)
    const r = u.includes('/predictions/') ? poll(pollN++) : submit()
    if (r instanceof Error) throw r
    return r
  }) as typeof fetch
  return calls
}

const submitOk = () => json(200, { code: 200, data: { id: 'p1' } })
const done = (url: string) => json(200, { data: { status: 'completed', outputs: [url] } })

describe('editImageNanoBananaPro polling', () => {
  it('returns the outputs of a completed prediction', async () => {
    mock(submitOk, n => (n < 1 ? json(200, { data: { status: 'processing' } }) : done('https://cdn/a.jpg')))
    assert.deepEqual(await editImageNanoBananaPro(INPUT), ['https://cdn/a.jpg'])
  })

  it('survives dropped connections and non-JSON gateway pages while polling', async () => {
    const calls = mock(submitOk, n => {
      if (n === 0) return new TypeError('fetch failed')
      if (n === 1) return new Response('<html>502 Bad Gateway</html>', { status: 502 })
      return done('https://cdn/b.jpg')
    })
    assert.deepEqual(await editImageNanoBananaPro(INPUT), ['https://cdn/b.jpg'])
    // one submit, three polls: the paid prediction was never abandoned and resubmitted
    assert.equal(calls.filter(u => !u.includes('/predictions/')).length, 1)
    assert.equal(calls.filter(u => u.includes('/predictions/')).length, 3)
  })

  it('a failed prediction throws with its status', async () => {
    mock(submitOk, () => json(200, { data: { status: 'failed', error: 'content policy' } }))
    await assert.rejects(() => editImageNanoBananaPro(INPUT), /Nano Banana Pro edit failed.*content policy/)
  })

  it('a cancelled or deleted prediction ends immediately instead of polling to the timeout', async () => {
    for (const status of ['cancelled', 'deleted', 'timeout']) {
      const calls = mock(submitOk, () => json(200, { data: { status } }))
      await assert.rejects(() => editImageNanoBananaPro(INPUT), new RegExp(status))
      assert.equal(calls.filter(u => u.includes('/predictions/')).length, 1, status)
    }
  })

  it('the caller aborting stops polling', async () => {
    const ctrl = new AbortController()
    mock(submitOk, () => { ctrl.abort(); return json(200, { data: { status: 'processing' } }) })
    await assert.rejects(() => editImageNanoBananaPro({ ...INPUT, signal: ctrl.signal }), /abort/i)
  })
})

describe('editImageNanoBananaPro submit', () => {
  it('reports the HTTP status and body of a refused submit', async () => {
    mock(() => json(400, { code: 400, message: 'Insufficient credits' }), () => done('x'))
    await assert.rejects(() => editImageNanoBananaPro(INPUT), /submit failed \(400\): Insufficient credits/)
  })

  it('a non-JSON submit response is a readable error, not a JSON parse crash', async () => {
    mock(() => new Response('<html>oops</html>', { status: 502 }), () => done('x'))
    await assert.rejects(() => editImageNanoBananaPro(INPUT), /submit failed \(502\).*non-JSON/)
  })

  it('needs at least one reference image', async () => {
    await assert.rejects(() => editImageNanoBananaPro({ ...INPUT, imageUrls: [] }), /at least one reference image/)
  })
})
