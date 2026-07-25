/**
 * Validates the measured half of technique detection against synthesised clips whose
 * properties are known up front, so cut counting and duration can be checked exactly.
 * Serves the clips over loopback because probeSourceVideo takes a URL.
 *
 * Usage: npx tsx scripts/test-probe-signals.ts [--grok]
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(__dirname, '..', '.env.local') })

const withGrok = process.argv.includes('--grok')

interface Fixture {
  name: string
  file: string
  expectedCuts: number
  expectedDuration: number
  build: () => Promise<void>
}

function tmp(name: string) {
  return join(tmpdir(), `xm_probe_${name}.mp4`)
}

/** One unbroken shot: a slow zoom on a single scene, so no cut should be reported. */
async function buildContinuous(file: string) {
  await execFileAsync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc2=size=540x960:rate=25:duration=6',
    '-vf', "zoompan=z='min(zoom+0.0015,1.5)':d=1:s=540x960",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file,
  ])
}

/** Three visually unrelated scenes spliced together: exactly two hard cuts. */
async function buildThreeScenes(file: string) {
  const parts: string[] = []
  // Solid colours differ enough that each boundary is an unambiguous scene change.
  const sources = [
    'color=c=navy:size=540x960:rate=25:duration=2',
    'color=c=orange:size=540x960:rate=25:duration=2',
    'color=c=white:size=540x960:rate=25:duration=2',
  ]
  for (const [i, src] of sources.entries()) {
    const part = tmp(`part${i}`)
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', src,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', part,
    ])
    parts.push(part)
  }
  const list = tmp('list').replace('.mp4', '.txt')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(list, parts.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n'))
  await execFileAsync('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', file,
  ])
  for (const p of [...parts, list]) { try { unlinkSync(p) } catch {} }
}

/** Long single shot, past the point where one generation call can cover it. */
async function buildLong(file: string) {
  await execFileAsync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc2=size=540x960:rate=25:duration=16',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file,
  ])
}

async function main() {
  const fixtures: Fixture[] = [
    {
      name: 'continuous 6s shot',
      file: tmp('continuous'),
      expectedCuts: 0,
      expectedDuration: 6,
      build: () => buildContinuous(tmp('continuous')),
    },
    {
      name: '3 scenes spliced (2 cuts)',
      file: tmp('threescenes'),
      expectedCuts: 2,
      expectedDuration: 6,
      build: () => buildThreeScenes(tmp('threescenes')),
    },
    {
      name: 'long 16s single shot',
      file: tmp('long'),
      expectedCuts: 0,
      expectedDuration: 16,
      build: () => buildLong(tmp('long')),
    },
  ]

  console.log('Building fixtures with ffmpeg…')
  for (const f of fixtures) await f.build()

  // probeSourceVideo fetches over HTTP, so expose the fixtures on loopback.
  const server = createServer((req, res) => {
    const fixture = fixtures.find(f => req.url === `/${f.name.replace(/\W+/g, '')}.mp4`)
    if (!fixture || !existsSync(fixture.file)) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': statSync(fixture.file).size,
    })
    createReadStream(fixture.file).pipe(res)
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port

  const { probeSourceVideo } = await import('../src/lib/monitor/analyze')
  const { analyzeVideoContent } = await import('../src/lib/monitor/classify')
  const { getTechnique } = await import('../src/lib/monitor/techniques')

  let failures = 0
  console.log(`\nProbing via http://127.0.0.1:${port}\n`)

  for (const f of fixtures) {
    const url = `http://127.0.0.1:${port}/${f.name.replace(/\W+/g, '')}.mp4`
    const probe = await probeSourceVideo(url, 5)

    if (!probe) {
      console.log(`✗ ${f.name}: probe returned null`)
      failures++
      continue
    }

    const durationOk = probe.duration != null && Math.abs(probe.duration - f.expectedDuration) < 1.0
    const cutsOk = probe.cutCount === f.expectedCuts
    const framesOk = probe.frames.length === 5
    const ok = durationOk && cutsOk && framesOk
    if (!ok) failures++

    console.log(`${ok ? '✓' : '✗'} ${f.name}`)
    console.log(`   duration ${probe.duration?.toFixed(2)}s (expected ~${f.expectedDuration}) ${durationOk ? 'ok' : 'MISMATCH'}`)
    console.log(`   cuts     ${probe.cutCount} (expected ${f.expectedCuts}) ${cutsOk ? 'ok' : 'MISMATCH'}`)
    console.log(`   frames   ${probe.frames.length}/5 ${framesOk ? 'ok' : 'MISMATCH'}`)

    if (withGrok) {
      try {
        const analysis = await analyzeVideoContent(probe)
        const spec = getTechnique(analysis.video_technique)
        console.log(`   grok     ${analysis.video_technique} @ ${Math.round(analysis.technique_confidence * 100)}%`
          + (analysis.overrodeModel ? ' (measured signal overrode model)' : ''))
        console.log(`   routes   ${spec.model ?? `parked — ${spec.reviewReason}`}`)
      } catch (err) {
        console.log(`   grok     FAILED: ${err instanceof Error ? err.message : err}`)
      }
    }
    console.log()
  }

  server.close()
  for (const f of fixtures) { try { if (existsSync(f.file)) unlinkSync(f.file) } catch {} }

  console.log(failures === 0 ? 'All measured signals correct.' : `${failures} fixture(s) mismatched.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
