import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { looksLikeDirectVideoUrl } from '../instagram-video-extract.mjs'

const YT_DLP_TIMEOUT_MS = 60_000

/** First existing path wins. Env override, then the VPS install locations. */
export const YT_DLP_LOOKUP = Object.freeze([
  'env:YT_DLP_PATH',
  '/usr/local/bin/yt-dlp',
  '/usr/bin/yt-dlp',
  '/tmp/ytdlp-venv/bin/yt-dlp',
])

export function ytdlpCandidatePaths() {
  const fromEnv = typeof process.env.YT_DLP_PATH === 'string' ? process.env.YT_DLP_PATH.trim() : ''
  return [
    fromEnv,
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    '/tmp/ytdlp-venv/bin/yt-dlp',
  ].filter(Boolean)
}

export function findYtdlpBinary() {
  for (const path of ytdlpCandidatePaths()) {
    if (existsSync(path)) return path
  }
  return null
}

/** `--get-url` prints one URL per line; Instagram may emit video then audio. */
export function pickPlayableUrlFromYtdlpOutput(stdout) {
  if (!stdout) return null
  for (const line of stdout.split(/\r?\n/)) {
    const url = line.trim()
    if (looksLikeDirectVideoUrl(url)) return url
  }
  return null
}

function runYtdlp(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('yt-dlp timed out after 60s'))
    }, YT_DLP_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

/**
 * Resolve a playable mp4 URL via yt-dlp `--get-url` (no download into the tree).
 * Returns null when the binary is missing so callers skip this resolver.
 * Throws on a real yt-dlp failure (audience-gated, etc.) so the note stays honest.
 */
export async function resolveVideoUrlViaYtdlp(permalink) {
  const bin = findYtdlpBinary()
  if (!bin) return null

  const args = ['--get-url', '-f', 'mp4/best', '--no-playlist', '--no-warnings']
  const cookieFile = typeof process.env.YT_DLP_COOKIES === 'string' ? process.env.YT_DLP_COOKIES.trim() : ''
  const sessionid = typeof process.env.INSTAGRAM_SESSIONID === 'string' ? process.env.INSTAGRAM_SESSIONID.trim() : ''
  if (cookieFile) args.push('--cookies', cookieFile)
  else if (sessionid) args.push('--add-header', `Cookie: sessionid=${sessionid}`)
  args.push(permalink)

  const { code, stdout, stderr } = await runYtdlp(bin, args)
  const url = pickPlayableUrlFromYtdlpOutput(stdout)
  if (url) return url

  const detail = (stderr || stdout || `yt-dlp exited ${code}`).trim().replace(/\s+/g, ' ')
  throw new Error(detail.slice(0, 400))
}
