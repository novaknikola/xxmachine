/**
 * Smoke-test the repurpose variant path without touching Supabase or Drive.
 *
 * Serves a local JPEG over http, then renders variants through the real
 * download → probe → ffmpeg pipeline and checks they differ from each other
 * and from the source.
 *
 *   npx tsx scripts/test-image-variants.ts <path-to-jpeg>
 */
import { createServer } from 'http'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { repurposeImageBuffer } from '../src/lib/drive-archive/image-repurpose'
import type { RepurposeStrength } from '../src/lib/drive-archive/repurpose-profiles'

const file = process.argv[2]
const strength = (process.argv[3] as RepurposeStrength) || 'dedupe'
const outDir = process.argv[4] || join(process.cwd(), 'tmp-variants')

if (!file || !existsSync(file)) {
  console.error(
    'usage: npx tsx scripts/test-image-variants.ts <jpeg> [dedupe|distinct] [outDir]',
  )
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

const bytes = readFileSync(file)
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex').slice(0, 12)

async function main() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': bytes.length })
    res.end(bytes)
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no server address')
  const url = `http://127.0.0.1:${addr.port}/source.jpg`

  console.log(`source ${file} (${bytes.length} bytes, sha ${sha(bytes)})`)

  try {
    const hashes: string[] = []
    for (const format of ['stories', 'carousels', 'reels'] as const) {
      for (let v = 0; v < 3; v++) {
        const seed = (0x9e3779b1 ^ (v * 40503)) >>> 0
        const t0 = Date.now()
        const out = await repurposeImageBuffer(url, format, seed, strength)
        const h = sha(out)
        hashes.push(h)
        const dest = join(outDir, `${strength}_${format}_v${v + 1}.jpg`)
        writeFileSync(dest, out)
        console.log(
          `  ${format.padEnd(10)} v${v + 1}  ${String(out.length).padStart(8)} bytes  sha ${h}  ${Date.now() - t0}ms  → ${dest}`,
        )
        if (out.length < 500) throw new Error('output suspiciously small')
        if (h === sha(bytes)) throw new Error('output identical to source — filter did not apply')
      }
    }

    const unique = new Set(hashes).size
    console.log(`\n${unique}/${hashes.length} variants unique`)
    if (unique !== hashes.length) {
      console.error('FAIL: seeds collided — variants are not distinct')
      process.exitCode = 1
    } else {
      console.log('PASS')
    }
  } finally {
    server.close()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
