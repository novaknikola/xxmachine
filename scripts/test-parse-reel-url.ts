import { parseReelUrl, parseReelUrlList } from '../src/lib/monitor/parse-reel-url'

const cases: Array<[string, string | null]> = [
  ['https://www.instagram.com/reel/ABC123xyz_/', 'ABC123xyz_'],
  ['https://instagram.com/reels/ABC123xyz_/?igsh=1', 'ABC123xyz_'],
  ['instagram.com/p/ABC123xyz_/', 'ABC123xyz_'],
  ['https://www.instagram.com/gracie.bestie_/reel/ABC123xyz_/', 'ABC123xyz_'],
  ['ABC123xyz_', 'ABC123xyz_'],
  ['https://tiktok.com/@x/video/1', null],
  ['not a url', null],
]

let failed = 0
for (const [input, expected] of cases) {
  const got = parseReelUrl(input)?.shortCode ?? null
  if (got !== expected) {
    console.error('FAIL', input, '→', got, 'expected', expected)
    failed++
  } else {
    console.log('ok', input, '→', got)
  }
}

const list = parseReelUrlList(`
https://www.instagram.com/reel/AAA111/
https://www.instagram.com/reel/AAA111/
https://www.instagram.com/reel/BBB222/
junk
`)
if (list.parsed.length !== 2 || list.parsed[0].shortCode !== 'AAA111') {
  console.error('FAIL list', list)
  failed++
} else {
  console.log('ok list', list.parsed.map(p => p.shortCode))
}

// A bare shortcode alone on its own line still works via the list parser.
const listBare = parseReelUrlList('ABC123xyz_')
if (listBare.parsed.length !== 1 || listBare.parsed[0].shortCode !== 'ABC123xyz_') {
  console.error('FAIL list bare shortcode', listBare)
  failed++
} else {
  console.log('ok list bare shortcode', listBare.parsed.map(p => p.shortCode))
}

// Regression for the 2026-08-13 incident: a real link followed by a plain
// instruction sentence must not shred the sentence into fake reel links.
const listSentence = parseReelUrlList(
  'https://www.instagram.com/reel/Db5mUCDO86a/\n' +
  'Change environment background colors a little. Remove screen. Increase breasts chest, petite.',
)
if (listSentence.parsed.length !== 1 || listSentence.parsed[0].shortCode !== 'Db5mUCDO86a') {
  console.error('FAIL sentence shredded into fake shortcodes', listSentence)
  failed++
} else {
  console.log('ok sentence not shredded', listSentence.parsed.map(p => p.shortCode))
}

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall passed')
