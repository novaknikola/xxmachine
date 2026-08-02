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

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall passed')
