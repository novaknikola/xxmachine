import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  composeRecreateScrapeError,
  extractPlayableVideoUrlFromHtml,
  findPlayableVideoUrl,
  isRapidApiPlanNoise,
  looksLikeDirectVideoUrl,
} from '../instagram-video-extract.mjs'
import { pickPlayableUrlFromYtdlpOutput, YT_DLP_LOOKUP } from './ytdlp.mjs'

const CDN_MP4 =
  'https://scontent-lax3-1.cdninstagram.com/o1/v/t16/f2/m86/AQMI-rs42_example.mp4?stp=dst-mp4&_nc_cat=108'

describe('looksLikeDirectVideoUrl', () => {
  it('accepts Instagram CDN mp4s and rejects thumbs / reel pages', () => {
    assert.equal(looksLikeDirectVideoUrl(CDN_MP4), true)
    assert.equal(
      looksLikeDirectVideoUrl('https://scontent.cdninstagram.com/v/t51.2885-15/thumb.jpg'),
      false,
    )
    assert.equal(looksLikeDirectVideoUrl('https://www.instagram.com/reel/Dax1cfasmOA/'), false)
  })
})

describe('extractPlayableVideoUrlFromHtml', () => {
  it('reads og:video and JSON video_url the way embed pages expose them', () => {
    const og = `<html><meta property="og:video" content="${CDN_MP4}" /></html>`
    assert.equal(extractPlayableVideoUrlFromHtml(og), CDN_MP4)

    const json = `window.__additionalDataLoaded("extra",{"graphql":{"shortcode_media":{"video_url":"${CDN_MP4}"}}})`
    assert.equal(extractPlayableVideoUrlFromHtml(json), CDN_MP4)

    const versions = `{"video_versions":[{"url":"${CDN_MP4}","width":720}]}`
    assert.equal(extractPlayableVideoUrlFromHtml(versions), CDN_MP4)
  })

  it('unescapes Instagram JSON slashes / unicode ampersands', () => {
    const escaped = CDN_MP4.replace(/\//g, '\\/').replace(/&/g, '\\u0026')
    const html = `{"video_url":"${escaped}"}`
    assert.equal(extractPlayableVideoUrlFromHtml(html), CDN_MP4)
  })

  it('returns null when the page is a login shell with no media', () => {
    assert.equal(
      extractPlayableVideoUrlFromHtml('<!DOCTYPE html><title>Instagram</title><body>restricted</body>'),
      null,
    )
  })
})

describe('findPlayableVideoUrl', () => {
  it('walks the RapidAPI / GraphQL media object shape', () => {
    assert.equal(
      findPlayableVideoUrl({
        data: { xdt_shortcode_media: { video_versions: [{ url: CDN_MP4 }] } },
      }),
      CDN_MP4,
    )
    assert.equal(
      findPlayableVideoUrl({ success: true, data: { medias: [{ type: 'video', url: CDN_MP4 }] } }),
      CDN_MP4,
    )
  })
})

describe('composeRecreateScrapeError', () => {
  it('names restricted_page and does not blame a RapidAPI subscription', () => {
    const msg = composeRecreateScrapeError([
      { source: 'Apify', detail: 'restricted_page' },
      { source: 'RapidAPI downloader', detail: 'You are not subscribed to this API' },
      { source: 'RapidAPI downloader', detail: 'system undergoing an upgrade' },
    ])
    assert.match(msg, /restricted_page/)
    assert.match(msg, /not a RapidAPI subscription issue/)
    assert.doesNotMatch(msg, /not subscribed/)
    assert.match(msg, /Last resort: send the reel as a video file/)
  })
})

describe('isRapidApiPlanNoise', () => {
  it('detects the upgrade / not-subscribed replies the downloader hosts return', () => {
    assert.equal(isRapidApiPlanNoise('You are not subscribed to this API'), true)
    assert.equal(isRapidApiPlanNoise('This API is undergoing an upgrade'), true)
    assert.equal(isRapidApiPlanNoise('No video media in the response'), false)
  })
})

describe('yt-dlp --get-url helper', () => {
  it('looks up env then the three VPS paths', () => {
    assert.deepEqual(YT_DLP_LOOKUP, [
      'env:YT_DLP_PATH',
      '/usr/local/bin/yt-dlp',
      '/usr/bin/yt-dlp',
      '/tmp/ytdlp-venv/bin/yt-dlp',
    ])
  })

  it('picks the first CDN mp4 from --get-url stdout', () => {
    const fra = 'https://scontent-fra5-2.cdninstagram.com/o1/v/t16/f2/m86/control.mp4?stp=dst-mp4'
    assert.equal(pickPlayableUrlFromYtdlpOutput(`${fra}\nhttps://example.com/audio.m4a\n`), fra)
  })
})
