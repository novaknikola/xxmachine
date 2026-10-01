/**
 * The reel provider chain against fake providers: who gets asked, in what
 * order, and what a failure is called. No network, no Apify credit.
 * Item shapes are the real ones seen in production on 2026-10-01.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ApifyReel, IntropixPost } from '@/lib/instagram-scrape'
import {
  classifyApifyItem,
  classifyIntropixPost,
  classifyProviderError,
  describeReelFailure,
  finalReelFailure,
  runReelProviderChain,
  type ChainContext,
  type ReelProviders,
} from './reel-source'

const reel = (code: string) => ({ shortCode: code, permalink: `https://www.instagram.com/reel/${code}/` })
const cdn = (name: string) => `https://scontent-lax7-1.cdninstagram.com/o1/v/t2/f2/m86/${name}.mp4?oe=6A000000`

const apifyVideo = (code: string): ApifyReel => ({
  shortCode: code, url: `https://www.instagram.com/reel/${code}/`, type: 'Video', videoUrl: cdn(code),
  displayUrl: `https://scontent.cdninstagram.com/${code}.jpg`, videoViewCount: 1200, likesCount: 34, commentsCount: 5,
  timestamp: '2026-09-30T18:44:00.000Z',
})
// Exactly what apify~instagram-scraper returned for the age-gated reels.
const apifyRestricted = (code: string): ApifyReel => ({
  inputUrl: `https://www.instagram.com/reel/${code}/`, url: `https://www.instagram.com/reel/${code}/`,
  error: 'restricted_page', errorDescription: 'Restricted access, only partial data available',
})
const intropixReel = (code: string): IntropixPost => ({
  shortcode: code, permalink: `https://www.instagram.com/reel/${code}/`, username: 'aisa.pee', post_type: 'reel',
  taken_at: '2026-09-30T18:44:00Z', like_count: 812, comment_count: 9, view_count: 40211,
  media: [{ media_type: 'video', media_url: cdn(`${code}-auth`), cover_url: `https://scontent.cdninstagram.com/${code}-c.jpg`, width: 1080, height: 1920, video_duration: 12.566 }],
})

function fakes(o: {
  apify?: (urls: string[], call: number) => Map<string, ApifyReel>
  intropix?: (urls: string[]) => IntropixPost[]
  rapid?: (url: string) => { videoUrl: string; thumbnail: string | null; likes: number | null; views: number | null }
  list?: (user: string) => ApifyReel[]
} = {}) {
  const calls = { apify: [] as string[][], intropix: [] as string[][], rapid: [] as string[], list: [] as string[], listOpts: [] as unknown[], sleep: 0 }
  const p: ReelProviders = {
    apifyAnonymous: async urls => { calls.apify.push(urls); return o.apify ? o.apify(urls, calls.apify.length) : new Map() },
    intropix: async urls => { calls.intropix.push(urls); return o.intropix ? o.intropix(urls) : [] },
    rapidApi: async url => {
      calls.rapid.push(url)
      if (o.rapid) return o.rapid(url)
      throw new Error('No video media in the response (probably not a reel) (fallback: No video media in scraper fallback response)')
    },
    listProfile: async (user, _limit, _key, opts) => {
      calls.list.push(user)
      calls.listOpts.push(opts)
      return { reels: o.list ? o.list(user) : [] }
    },
    ensureAudio: async r => r,
    sleep: async () => { calls.sleep++ },
  }
  return { p, calls }
}
const ctx = (over: Partial<ChainContext> = {}): ChainContext => ({
  apifyEnabled: true, rapidApiKey: null, sourceUsername: null, listLimit: 50, retryDelayMs: 0, ...over,
})
const byCode = (...items: [string, ApifyReel][]) => new Map(items.map(([c, i]) => [c.toLowerCase(), i]))
// Exactly what Apify answers a run start once the account's monthly limit is spent.
const HARD_LIMIT = 'Apify run failed to start: {"error":{"type":"platform-feature-disabled","message":"Monthly usage hard limit exceeded"}}'

describe('reel provider chain', () => {
  it('1, 13, 14. Apify success: the existing path, untouched — nothing else is asked', async () => {
    const { p, calls } = fakes({ apify: () => byCode(['AAA111', apifyVideo('AAA111')]) })
    const out = await runReelProviderChain([reel('AAA111')], ctx({ rapidApiKey: 'k', sourceUsername: 'owner' }), p)
    const hit = out.resolved.get('aaa111')!
    assert.equal(hit.provider, 'apify')
    assert.equal(hit.videoUrl, cdn('AAA111'))
    assert.deepEqual(hit.metadata, {
      permalink: 'https://www.instagram.com/reel/AAA111/', shortCode: 'AAA111', thumbnailUrl: 'https://scontent.cdninstagram.com/AAA111.jpg',
      views: 1200, likes: 34, comments: 5, postedAt: '2026-09-30T18:44:00.000Z',
    })
    assert.deepEqual([calls.apify.length, calls.intropix.length, calls.rapid.length, calls.list.length, calls.sleep], [1, 0, 0, 0, 0])
  })

  it('2, 6, 12. restricted_page → Intropix, once, and no anonymous retry loop', async () => {
    const { p, calls } = fakes({
      apify: () => byCode(['Dd7AUD_t2Vd', apifyRestricted('Dd7AUD_t2Vd')]),
      intropix: () => [intropixReel('Dd7AUD_t2Vd')],
    })
    const out = await runReelProviderChain([reel('Dd7AUD_t2Vd')], ctx({ rapidApiKey: 'k', sourceUsername: 'aisa.pee' }), p)
    const hit = out.resolved.get('dd7aud_t2vd')!
    assert.equal(hit.provider, 'intropix')
    assert.equal(hit.mediaType, 'video')
    assert.equal(hit.videoUrl, cdn('Dd7AUD_t2Vd-auth'))
    assert.equal(hit.metadata?.durationSec, 12.566)
    assert.deepEqual(calls.intropix, [['https://www.instagram.com/reel/Dd7AUD_t2Vd/']])
    assert.equal(calls.apify.length, 1, 'anonymous Apify asked once, not retried')
    assert.equal(calls.sleep, 0)
    assert.equal(out.attempts.get('dd7aud_t2vd')![0].errorType, 'ACCESS_RESTRICTED')
  })

  it('3. a "Restricted profile" answer is ACCESS_RESTRICTED → Intropix', async () => {
    const { p, calls } = fakes({
      apify: () => byCode(['Dd6ikHhiuoO', { url: 'https://www.instagram.com/reel/Dd6ikHhiuoO/', error: 'Restricted profile' }]),
      intropix: () => [intropixReel('Dd6ikHhiuoO')],
    })
    const out = await runReelProviderChain([reel('Dd6ikHhiuoO')], ctx(), p)
    assert.equal(out.resolved.get('dd6ikhhiuoo')?.provider, 'intropix')
    assert.equal(calls.intropix.length, 1)
  })

  it('3. a gated profile in the listing is ACCESS_RESTRICTED too, and stops the retry', async () => {
    const { p, calls } = fakes({
      apify: () => new Map(), // empty answer: a retry candidate…
      intropix: () => { throw new Error('Apify run failed: FAILED') },
      list: () => [{ error: 'Restricted profile' }], // …until the listing says the account is gated
    })
    const out = await runReelProviderChain([reel('Dd4MWoXBuZS')], ctx({ sourceUsername: 'tiffanytrouble34' }), p)
    const tried = out.attempts.get('dd4mwoxbuzs')!
    assert.deepEqual(tried.map(f => `${f.provider} ${f.errorType}`), ['apify NOT_FOUND', 'intropix PROVIDER_DOWN', 'profile-list ACCESS_RESTRICTED'])
    assert.equal(calls.apify.length, 1, 'no anonymous retry once the gate is known')
    assert.equal(calls.sleep, 0)
  })

  it('4. the shared Apify account over its monthly limit → no Intropix (same account), no Apify retry; RapidAPI still answers', async () => {
    const { p, calls } = fakes({
      apify: () => { throw new Error(HARD_LIMIT) },
      intropix: () => [intropixReel('Dd4MWoXBuZS')],
      rapid: () => ({ videoUrl: cdn('rapid'), thumbnail: null, likes: 3, views: 40 }),
    })
    const out = await runReelProviderChain([reel('Dd4MWoXBuZS')], ctx({ rapidApiKey: 'k', sourceUsername: 'owner' }), p)
    assert.equal(out.resolved.get('dd4mwoxbuzs')?.provider, 'rapidapi')
    assert.equal(calls.intropix.length, 0, 'Intropix runs on the same Apify account: not asked')
    assert.equal(calls.apify.length, 1)
    assert.equal(calls.sleep, 0)
    assert.equal(out.attempts.get('dd4mwoxbuzs')![0].errorType, 'ACCOUNT_QUOTA')
  })

  it('4. platform-feature-disabled in any wording is the account too: no Apify actor at all, the listing goes through RapidAPI only, and the user is told it is the Apify account', async () => {
    const { p, calls } = fakes({
      apify: () => { throw new Error('Apify run failed to start: {"error":{"type":"platform-feature-disabled","message":"Actor runs are disabled for this account"}}') },
      intropix: () => [intropixReel('ACCT0001')],
      rapid: () => { throw new Error('RapidAPI request failed (HTTP 429)') },
    })
    const out = await runReelProviderChain([reel('ACCT0001'), reel('ACCT0002')], ctx({ rapidApiKey: 'k', sourceUsername: 'owner' }), p)
    assert.equal(out.resolved.size, 0)
    assert.deepEqual([calls.apify.length, calls.intropix.length, calls.sleep], [1, 0, 0])
    assert.deepEqual(calls.list, ['owner'])
    assert.deepEqual(calls.listOpts, [{ skipApify: true }])
    for (const code of ['acct0001', 'acct0002']) {
      const final = finalReelFailure(out.attempts.get(code)!)
      assert.deepEqual([final.provider, final.errorType], ['apify', 'ACCOUNT_QUOTA'])
      const text = describeReelFailure(final)
      assert.equal(text, 'Apify account monthly usage limit exhausted — no Apify scraper can run until the limit resets or the plan is raised.')
      assert.doesNotMatch(text, /intropix/i)
    }
  })

  it('Intropix meeting the account limit itself: asked once, no Apify retry or listing run, and the Apify account named as the cause', async () => {
    const { p, calls } = fakes({
      apify: () => byCode(['GATED001', apifyRestricted('GATED001')], ['GATED002', apifyRestricted('GATED002')]), // EMPTY001: no item
      intropix: () => { throw new Error(HARD_LIMIT) },
    })
    const out = await runReelProviderChain([reel('GATED001'), reel('GATED002'), reel('EMPTY001')], ctx({ sourceUsername: 'owner' }), p)
    assert.deepEqual([calls.apify.length, calls.intropix.length, calls.list.length, calls.sleep], [1, 1, 0, 0])
    for (const code of ['gated001', 'gated002']) {
      const text = describeReelFailure(finalReelFailure(out.attempts.get(code)!))
      assert.equal(text, 'Apify account monthly usage limit exhausted — no Apify scraper can run until the limit resets or the plan is raised.'
        + ' The Reel is restricted/age-gated and needs the authenticated scraper, which runs on that account.')
      assert.doesNotMatch(text, /intropix/i)
    }
    assert.equal(finalReelFailure(out.attempts.get('empty001')!).errorType, 'ACCOUNT_QUOTA')
  })

  it('5. Apify timeout or failed run → Intropix', async () => {
    for (const [msg, type] of [['Apify run timed out (still RUNNING after 240s)', 'TIMEOUT'], ['Apify run failed: FAILED', 'PROVIDER_DOWN']] as const) {
      const { p, calls } = fakes({ apify: () => { throw new Error(msg) }, intropix: () => [intropixReel('Dd7AjJXuAWL')] })
      const out = await runReelProviderChain([reel('Dd7AjJXuAWL')], ctx(), p)
      assert.equal(out.resolved.get('dd7ajjxuawl')?.provider, 'intropix', msg)
      assert.equal(calls.intropix.length, 1)
      assert.equal(classifyProviderError('apify', new Error(msg)).errorType, type)
    }
  })

  it('7. Intropix says it is not a video → NOT_VIDEO, and nobody else is asked', async () => {
    const { p, calls } = fakes({
      apify: () => byCode(['PHOTO01', apifyRestricted('PHOTO01')]),
      intropix: () => [{ shortcode: 'PHOTO01', post_type: 'post', media: [{ media_type: 'image', media_url: 'https://scontent.cdninstagram.com/p.jpg' }] }],
    })
    const out = await runReelProviderChain([reel('PHOTO01')], ctx({ rapidApiKey: 'k', sourceUsername: 'owner' }), p)
    const final = finalReelFailure(out.attempts.get('photo01')!)
    assert.equal(final.errorType, 'NOT_VIDEO')
    assert.deepEqual([calls.rapid.length, calls.list.length, calls.sleep], [0, 0, 0])
    assert.equal(describeReelFailure(final), 'The Instagram URL does not point to a downloadable video Reel.')
  })

  it('8. Intropix delivers a post without media → a classified failure, the chain goes on', async () => {
    const { p, calls } = fakes({
      apify: () => byCode(['NOMEDIA1', apifyRestricted('NOMEDIA1')]),
      intropix: () => [{ shortcode: 'NOMEDIA1', post_type: 'reel', media: [] }],
    })
    const out = await runReelProviderChain([reel('NOMEDIA1')], ctx({ rapidApiKey: 'k' }), p)
    const tried = out.attempts.get('nomedia1')!
    assert.equal(tried[1].provider, 'intropix')
    assert.equal(tried[1].errorType, 'UNKNOWN')
    assert.match(tried[1].detail ?? '', /no media/)
    assert.equal(calls.rapid.length, 1, 'the RapidAPI fallback still gets its turn')
  })

  it('a photo seen by anonymous Apify is final: no Intropix run is paid for it', async () => {
    const { p, calls } = fakes({ apify: () => byCode(['DbsqSRlAgE5', { shortCode: 'DbsqSRlAgE5', type: 'Image', displayUrl: 'https://x/y.jpg' }]) })
    const out = await runReelProviderChain([reel('DbsqSRlAgE5')], ctx({ rapidApiKey: 'k', sourceUsername: 'isaadicksonn' }), p)
    assert.equal(finalReelFailure(out.attempts.get('dbsqsrlage5')!).errorType, 'NOT_VIDEO')
    assert.deepEqual([calls.intropix.length, calls.rapid.length, calls.list.length, calls.sleep], [0, 0, 0, 0])
  })

  it('Intropix out of free capacity: the next reel does not ask it again, and the user is told why', async () => {
    const { p, calls } = fakes({
      apify: () => byCode(['GATED001', apifyRestricted('GATED001')], ['GATED002', apifyRestricted('GATED002')]),
      intropix: () => [{ error: 'free_capacity_exhausted', errorDescription: 'Free-plan capacity is used up for today' }],
    })
    const out = await runReelProviderChain([reel('GATED001'), reel('GATED002')], ctx(), p)
    assert.equal(calls.intropix.length, 1)
    for (const code of ['gated001', 'gated002']) {
      const final = finalReelFailure(out.attempts.get(code)!)
      assert.equal(final.errorType, 'QUOTA')
      assert.equal(final.primary?.errorType, 'ACCESS_RESTRICTED')
      assert.match(describeReelFailure(final), /^Instagram scraper provider quota is exhausted \(intropix\) — the Reel is restricted\/age-gated/)
    }
  })

  it('an empty Apify answer still gets its one delayed retry (a transient miss, not a known gate)', async () => {
    const { p, calls } = fakes({
      apify: (_urls, call) => (call === 1 ? new Map() : byCode(['FLAKY001', apifyVideo('FLAKY001')])),
      intropix: () => [],
    })
    const out = await runReelProviderChain([reel('FLAKY001')], ctx(), p)
    assert.equal(out.resolved.get('flaky001')?.provider, 'apify-retry')
    assert.equal(calls.apify.length, 2)
    assert.equal(calls.sleep, 1)
  })

  it('RapidAPI still covers what both Apify actors could not answer', async () => {
    const { p, calls } = fakes({
      apify: () => { throw new Error('Apify run failed to start: fetch failed') },
      intropix: () => { throw new Error('Apify run failed to start: fetch failed') },
      rapid: () => ({ videoUrl: cdn('rapid'), thumbnail: null, likes: 3, views: 40 }),
    })
    const out = await runReelProviderChain([reel('RAPID001'), reel('RAPID002')], ctx({ rapidApiKey: 'k' }), p)
    assert.equal(out.resolved.get('rapid001')?.provider, 'rapidapi')
    assert.equal(calls.intropix.length, 1, 'a provider that is down is not asked for the second reel')
    assert.equal(calls.rapid.length, 2)
  })
})

describe('reel source classification', () => {
  it('names provider-level failures', () => {
    const cases: [string, string][] = [
      [HARD_LIMIT, 'ACCOUNT_QUOTA'],
      ['Apify run failed to start: {"error":{"type":"platform-feature-disabled","message":"Actor runs are disabled"}}', 'ACCOUNT_QUOTA'],
      ['Apify run failed: FAILED (free_capacity_exhausted)', 'QUOTA'],
      ['You have exceeded the MONTHLY quota for Requests on your current plan', 'QUOTA'],
      ['RapidAPI request failed (HTTP 429)', 'QUOTA'],
      ['The operation was aborted due to timeout', 'TIMEOUT'],
      ['Apify run failed: ABORTED', 'PROVIDER_DOWN'],
      ['The system is undergoing an upgrade. Please try again later.', 'PROVIDER_DOWN'],
      ['something nobody has seen', 'UNKNOWN'],
    ]
    for (const [msg, type] of cases) assert.equal(classifyProviderError('apify', new Error(msg)).errorType, type, msg)
  })

  it('reads item-level answers from both actors', () => {
    assert.equal((classifyApifyItem(apifyRestricted('X')) as { errorType: string }).errorType, 'ACCESS_RESTRICTED')
    assert.equal((classifyApifyItem({ shortCode: 'X', type: 'Sidecar' }) as { errorType: string }).errorType, 'NOT_VIDEO')
    assert.equal((classifyApifyItem({ shortCode: 'X', videoUrl: 'https://www.instagram.com/reel/X/' }) as { errorType: string }).errorType, 'INVALID')
    assert.equal((classifyApifyItem({ shortCode: 'X', error: 'not_found', errorDescription: 'Post not found' }) as { errorType: string }).errorType, 'NOT_FOUND')
    assert.equal(classifyIntropixPost(intropixReel('X')).ok, true)
    assert.equal((classifyIntropixPost({ ...intropixReel('X'), media: [{ media_type: 'video' }] }) as { errorType: string }).errorType, 'UNKNOWN')
    assert.equal((classifyIntropixPost({ error: 'private_account' }) as { errorType: string }).errorType, 'ACCESS_RESTRICTED')
  })

  it('tells the user what happened — and never "could not be downloaded" when nothing was found', () => {
    const restricted = finalReelFailure([{ ok: false, provider: 'apify', errorType: 'ACCESS_RESTRICTED', retryable: false }])
    assert.equal(describeReelFailure(restricted), 'Instagram Reel is restricted/age-gated and the primary scraper could not access it.')
    const quota = finalReelFailure([{ ok: false, provider: 'rapidapi', errorType: 'QUOTA', retryable: false }])
    assert.equal(describeReelFailure(quota), 'Instagram scraper provider quota is exhausted (rapidapi).')
    for (const t of ['ACCESS_RESTRICTED', 'NOT_VIDEO', 'NOT_FOUND', 'QUOTA', 'ACCOUNT_QUOTA', 'PROVIDER_DOWN', 'TIMEOUT', 'INVALID', 'UNKNOWN'] as const) {
      const text = describeReelFailure(finalReelFailure([{ ok: false, provider: 'apify', errorType: t, retryable: true }]))
      assert.doesNotMatch(text, /could not be downloaded/i, t)
    }
  })

  it('maps a classified failure onto the job error code', async () => {
    const { classifyAcquireError, WanJobError } = await import('./wan-jobs')
    const { EnqueueUrlsError } = await import('./enqueue-from-urls')
    const err = (reason: 'ACCESS_RESTRICTED' | 'NOT_VIDEO' | 'QUOTA' | 'ACCOUNT_QUOTA' | 'NOT_FOUND') => new EnqueueUrlsError('Could not fetch that reel. x', 502, { reason })
    assert.equal(classifyAcquireError(err('ACCESS_RESTRICTED')), 'SOURCE_UNAVAILABLE')
    assert.equal(classifyAcquireError(err('NOT_FOUND')), 'SOURCE_UNAVAILABLE')
    assert.equal(classifyAcquireError(err('NOT_VIDEO')), 'INVALID_INPUT')
    assert.equal(classifyAcquireError(err('QUOTA')), 'ACQUISITION_FAILED')
    assert.equal(classifyAcquireError(err('ACCOUNT_QUOTA')), 'ACQUISITION_FAILED')
    assert.equal(classifyAcquireError(new WanJobError('DOWNLOAD_FAILED', 'x')), 'DOWNLOAD_FAILED')
  })
})
