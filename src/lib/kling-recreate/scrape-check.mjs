/**
 * Runnable check for reel-URL extractors + honest restricted_page errors.
 * node src/lib/kling-recreate/scrape-check.mjs
 */
import assert from 'node:assert/strict'
import {
  composeRecreateScrapeError,
  extractPlayableVideoUrlFromHtml,
  findPlayableVideoUrl,
  isRapidApiPlanNoise,
  looksLikeDirectVideoUrl,
} from '../instagram-video-extract.mjs'
import {
  findYtdlpBinary,
  pickPlayableUrlFromYtdlpOutput,
  ytdlpCandidatePaths,
  YT_DLP_LOOKUP,
} from './ytdlp.mjs'

const CDN_MP4 =
  'https://scontent-lax3-1.cdninstagram.com/o1/v/t16/f2/m86/AQMI-rs42_example.mp4?stp=dst-mp4&_nc_cat=108'

assert.equal(looksLikeDirectVideoUrl(CDN_MP4), true)
assert.equal(
  looksLikeDirectVideoUrl('https://scontent.cdninstagram.com/v/t51.2885-15/thumb.jpg'),
  false,
)
assert.equal(looksLikeDirectVideoUrl('https://www.instagram.com/reel/Dax1cfasmOA/'), false)

assert.equal(
  extractPlayableVideoUrlFromHtml(`<html><meta property="og:video" content="${CDN_MP4}" /></html>`),
  CDN_MP4,
)
assert.equal(
  extractPlayableVideoUrlFromHtml(
    `window.__additionalDataLoaded("extra",{"graphql":{"shortcode_media":{"video_url":"${CDN_MP4}"}}})`,
  ),
  CDN_MP4,
)
assert.equal(
  extractPlayableVideoUrlFromHtml(`{"video_versions":[{"url":"${CDN_MP4}","width":720}]}`),
  CDN_MP4,
)

const escaped = CDN_MP4.replace(/\//g, '\\/').replace(/&/g, '\\u0026')
assert.equal(extractPlayableVideoUrlFromHtml(`{"video_url":"${escaped}"}`), CDN_MP4)
assert.equal(
  extractPlayableVideoUrlFromHtml('<!DOCTYPE html><title>Instagram</title><body>restricted</body>'),
  null,
)

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

const restricted = composeRecreateScrapeError([
  { source: 'Apify', detail: 'restricted_page' },
  { source: 'RapidAPI downloader', detail: 'You are not subscribed to this API' },
  { source: 'RapidAPI downloader', detail: 'system undergoing an upgrade' },
])
assert.match(restricted, /restricted_page/)
assert.match(restricted, /not a RapidAPI subscription issue/)
assert.doesNotMatch(restricted, /not subscribed/)
assert.match(restricted, /Last resort: send the reel as a video file/)

assert.match(
  composeRecreateScrapeError([{ source: 'public page', detail: 'timeout' }]),
  /public page: timeout/,
)

assert.equal(isRapidApiPlanNoise('You are not subscribed to this API'), true)
assert.equal(isRapidApiPlanNoise('This API is undergoing an upgrade'), true)
assert.equal(isRapidApiPlanNoise('No video media in the response'), false)

assert.deepEqual(YT_DLP_LOOKUP, [
  'env:YT_DLP_PATH',
  '/usr/local/bin/yt-dlp',
  '/usr/bin/yt-dlp',
  '/tmp/ytdlp-venv/bin/yt-dlp',
])
const candidates = ytdlpCandidatePaths()
assert.deepEqual(candidates.slice(-3), [
  '/usr/local/bin/yt-dlp',
  '/usr/bin/yt-dlp',
  '/tmp/ytdlp-venv/bin/yt-dlp',
])
assert.equal(findYtdlpBinary(), null)

const fra = 'https://scontent-fra5-2.cdninstagram.com/o1/v/t16/f2/m86/control.mp4?stp=dst-mp4'
assert.equal(pickPlayableUrlFromYtdlpOutput(`${fra}\nhttps://example.com/audio.m4a\n`), fra)

const gated = composeRecreateScrapeError([
  { source: 'Apify', detail: 'restricted_page' },
  { source: 'RapidAPI downloader', detail: 'HTTP 500 system undergoing an upgrade' },
  {
    source: 'yt-dlp',
    detail: "This content isn't available to everyone: It can't be seen by certain audiences.",
  },
])
assert.match(gated, /Instagram blocked anonymous access/)
assert.match(gated, /restricted_page/)
assert.doesNotMatch(gated, /not subscribed/)
assert.match(
  composeRecreateScrapeError([{
    source: 'yt-dlp',
    detail: "This content isn't available to everyone: It can't be seen by certain audiences.",
  }]),
  /isn't available to everyone/,
)

console.log('scrape-check: ok')
