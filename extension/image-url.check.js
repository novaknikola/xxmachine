#!/usr/bin/env node
// ponytail: one assert-based check for the URL extractors. Fails the process
// if srcset / background-image / picture-source picking regresses.
const assert = require('assert')
const {
  isHttpUrl,
  normalizeHttpUrl,
  pickFromSrcset,
  extractCssBgUrls,
  pickHttpImageUrl,
} = require('./image-url.js')

assert.strictEqual(isHttpUrl('https://cdn.example.com/a.jpg'), true)
assert.strictEqual(isHttpUrl('http://cdn.example.com/a.jpg'), true)
assert.strictEqual(isHttpUrl('blob:https://instagram.com/abc'), false)
assert.strictEqual(isHttpUrl('data:image/png;base64,xxx'), false)
assert.strictEqual(normalizeHttpUrl('//i.pinimg.com/a.jpg'), 'https://i.pinimg.com/a.jpg')
assert.strictEqual(normalizeHttpUrl('blob:https://x/y'), null)

assert.strictEqual(
  pickFromSrcset('https://cdn.example.com/a.jpg 1x, https://cdn.example.com/a-2x.jpg 2x'),
  'https://cdn.example.com/a-2x.jpg',
)
assert.strictEqual(
  pickFromSrcset('https://i.pinimg.com/236x/a.jpg 236w, https://i.pinimg.com/736x/a.jpg 736w'),
  'https://i.pinimg.com/736x/a.jpg',
)
assert.strictEqual(pickFromSrcset('blob:https://ig/1 1x, https://scontent.cdn/real.jpg 2x'), 'https://scontent.cdn/real.jpg')
assert.strictEqual(pickFromSrcset('data:image/gif;base64,xxx 1x'), null)

assert.deepStrictEqual(
  extractCssBgUrls('url("https://i.pinimg.com/pin.jpg")'),
  ['https://i.pinimg.com/pin.jpg'],
)
assert.deepStrictEqual(
  extractCssBgUrls("image-set(url('https://cdn.example.com/1.png') 1x, url(https://cdn.example.com/2.png) 2x)"),
  ['https://cdn.example.com/1.png', 'https://cdn.example.com/2.png'],
)
assert.deepStrictEqual(extractCssBgUrls('url("data:image/png;base64,xxx")'), [])
assert.deepStrictEqual(extractCssBgUrls('url("//i.pinimg.com/bg.jpg")'), ['https://i.pinimg.com/bg.jpg'])

assert.strictEqual(
  pickHttpImageUrl({
    currentSrc: 'blob:https://instagram.com/tmp',
    src: 'blob:https://instagram.com/tmp',
    srcset: 'https://scontent.cdn/full.jpg 1080w, https://scontent.cdn/tiny.jpg 150w',
    dataSrc: null,
    sourceSrcsets: [],
  }),
  'https://scontent.cdn/full.jpg',
)
assert.strictEqual(
  pickHttpImageUrl({
    currentSrc: '',
    src: '',
    srcset: '',
    dataSrc: 'https://i.pinimg.com/lazy.jpg',
    sourceSrcsets: [],
  }),
  'https://i.pinimg.com/lazy.jpg',
)
assert.strictEqual(
  pickHttpImageUrl({
    currentSrc: '',
    src: '',
    srcset: '',
    dataSrc: '',
    sourceSrcsets: ['https://cdn.example.com/pic-small.jpg 400w, https://cdn.example.com/pic.jpg 1200w'],
  }),
  'https://cdn.example.com/pic.jpg',
)
assert.strictEqual(
  pickHttpImageUrl({ currentSrc: 'blob:x', src: 'blob:x', srcset: '', dataSrc: '', sourceSrcsets: [] }),
  null,
)
assert.strictEqual(
  pickHttpImageUrl({
    currentSrc: 'blob:https://ig/tmp',
    src: 'blob:https://ig/tmp',
    srcset: 'https://scontent.cdn/full.jpg 1080w',
    dataSrc: 'https://scontent.cdn/tiny-placeholder.jpg',
    sourceSrcsets: [],
  }),
  'https://scontent.cdn/full.jpg',
)

console.log('image-url.check.js: ok')
