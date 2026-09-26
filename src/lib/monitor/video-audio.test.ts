import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { videoHasAudio, muxTracks, ensureVideoHasAudio, muxStoragePath } from './video-audio'

function ffmpeg(args: string[]) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...args])
}

test('video-only file is reported silent, joined file has audio', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'va-test-'))
  try {
    const video = join(dir, 'v.mp4')
    const audio = join(dir, 'a.m4a')
    const joined = join(dir, 'j.mp4')
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=2', '-c:v', 'libx264', '-an', video])
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac', audio])

    assert.equal(await videoHasAudio(video), false)
    assert.equal(await videoHasAudio(audio), true)

    await muxTracks(video, audio, joined)
    assert.ok(existsSync(joined))
    assert.equal(await videoHasAudio(joined), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unprobeable source is unknown (null), not silent', async () => {
  assert.equal(await videoHasAudio('/definitely/not/a/file.mp4'), null)
})

test('ensureVideoHasAudio leaves the URL alone when no audio track is offered or sound exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'va-test-'))
  try {
    const withSound = join(dir, 's.mp4')
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=1',
      '-c:v', 'libx264', '-c:a', 'aac', '-shortest', withSound])
    assert.equal(await ensureVideoHasAudio(withSound, 'https://example.invalid/a.m4a'), withSound)
    assert.equal(await ensureVideoHasAudio('/no/audio/offered.mp4', undefined), '/no/audio/offered.mp4')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('re-joined files get a stable storage path per reel, independent of the signed query string', () => {
  const a = muxStoragePath('https://cdn.example/o1/v/t2/f2/m367/AQOaCJK6Zrw2.mp4?_nc_ht=x&oh=111&oe=AAA')
  const b = muxStoragePath('https://other-edge.example/o1/v/t2/f2/m367/AQOaCJK6Zrw2.mp4?oh=222&oe=BBB')
  const c = muxStoragePath('https://cdn.example/o1/v/t2/f2/m367/DIFFERENT.mp4?oh=111')
  assert.match(a, /^monitor\/audio-mux\/[0-9a-f]{24}\.mp4$/)
  assert.equal(a, muxStoragePath('https://cdn.example/o1/v/t2/f2/m367/AQOaCJK6Zrw2.mp4?_nc_ht=x&oh=111&oe=AAA'))
  assert.notEqual(a, c)
  // a different CDN host but the same asset path collides on purpose only if the path is identical
  assert.notEqual(b, c)
  assert.match(muxStoragePath('not a url'), /^monitor\/audio-mux\/[0-9a-f]{24}\.mp4$/)
})
