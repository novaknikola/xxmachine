import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseReelUrl } from '../monitor/parse-reel-url'
import { extractPlayableVideoFromHtml, formatRecreateScrapeFailure } from './scrape-format'

describe('parseReelUrl still accepts /reel/ and /p/', () => {
  it('parses both as the same shortcode', () => {
    const reel = parseReelUrl('https://www.instagram.com/reel/AbC123xyz_/')
    const post = parseReelUrl('https://instagram.com/p/AbC123xyz_/?igsh=1')
    assert.equal(reel?.shortCode, 'AbC123xyz_')
    assert.equal(post?.shortCode, 'AbC123xyz_')
    assert.equal(reel?.permalink, post?.permalink)
  })
})

describe('formatRecreateScrapeFailure', () => {
  it('does not call a missing RapidAPI key a not-subscribed plan error', () => {
    const noKey = formatRecreateScrapeFailure({
      hasRapidApiKey: false,
      hasApify: true,
      apifyError: null,
      quotaExhausted: false,
    })
    assert.match(noKey, /no RapidAPI key/i)
    assert.doesNotMatch(noKey, /not subscribed/i)
    assert.doesNotMatch(noKey, /video file/i)

    const noFetchers = formatRecreateScrapeFailure({
      hasRapidApiKey: false,
      hasApify: false,
      apifyError: 'You are not subscribed to this API',
      quotaExhausted: false,
    })
    assert.match(noFetchers, /no RapidAPI key/i)
    assert.doesNotMatch(noFetchers, /not subscribed/i)
    assert.doesNotMatch(noFetchers, /video file/i)
  })

  it('names a 429 when the user actually has a RapidAPI key', () => {
    const msg = formatRecreateScrapeFailure({
      hasRapidApiKey: true,
      hasApify: true,
      apifyError: null,
      quotaExhausted: true,
    })
    assert.match(msg, /429/)
    assert.doesNotMatch(msg, /video file/i)
  })
})

describe('extractPlayableVideoFromHtml', () => {
  it('takes og:video and rejects an Instagram page URL', () => {
    const hit = extractPlayableVideoFromHtml(
      '<meta property="og:video" content="https://scontent.cdninstagram.com/v/t.mp4?_nc=1" />',
    )
    assert.equal(hit, 'https://scontent.cdninstagram.com/v/t.mp4?_nc=1')

    const page = extractPlayableVideoFromHtml(
      '<meta property="og:video" content="https://www.instagram.com/reel/AbC123xyz_/" />',
    )
    assert.equal(page, null)
  })
})
