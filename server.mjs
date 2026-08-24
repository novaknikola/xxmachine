import { createServer as createHttpServer } from 'http'
import { createServer as createHttpsServer } from 'https'
import { parse } from 'url'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import next from 'next'
import cron from 'node-cron'
import { readFileSync, existsSync } from 'fs'

// In .mjs (ES module), __dirname is not defined — derive it from import.meta.url
const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .env.local
if (!existsSync('.env.local')) {
  console.warn('[server] WARNING: .env.local not found — API keys and secrets will be missing')
} else {
  try {
    const env = readFileSync('.env.local', 'utf8')
    for (const line of env.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx < 0) continue
      const key = trimmed.slice(0, eqIdx).trim()
      const val = trimmed.slice(eqIdx + 1).trim()
      if (key && !(key in process.env)) process.env[key] = val
    }
  } catch (err) {
    console.warn('[server] Failed to parse .env.local:', err)
  }
}

const dev = process.env.NODE_ENV !== 'production'

// Allow Node.js to trust mkcert local certs when calling itself (dev only)
if (dev) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const port = parseInt(process.env.PORT ?? '3000', 10)

const certPairs = [
  ['xmachine.local-key.pem', 'xmachine.local.pem'],
  ['localhost-key.pem', 'localhost.pem'],
]
const certPair = certPairs.find(([k, c]) => existsSync(k) && existsSync(c))
const hasCerts = !!certPair
const protocol = hasCerts ? 'https' : 'http'
const host = hasCerts && existsSync('xmachine.local.pem') ? 'xmachine.local' : 'localhost'
const base = `${protocol}://${host}:${port}`

const app = next({ dev, dir: __dirname })
const handle = app.getRequestHandler()

await app.prepare()

const handler = (req, res) => {
  const parsedUrl = parse(req.url ?? '/', true)
  handle(req, res, parsedUrl)
}

const server = hasCerts && certPair
  ? createHttpsServer({ key: readFileSync(certPair[0]), cert: readFileSync(certPair[1]) }, handler)
  : createHttpServer(handler)

server.listen(port, () => {
  console.log(`> Ready on ${base}`)
  if (dev) warmRoutes(base)
})

async function warmRoutes(base) {
  // Keep this light — /bulk pulls a huge client graph and thrashing it on boot
  // saturates the Turbopack compile queue. Warm smaller shells instead.
  const routes = ['/settings', '/copy-paste', '/history']
  console.log('> Pre-warming routes...')
  for (const route of routes) {
    fetch(`${base}${route}`).catch(() => {})
    await new Promise(r => setTimeout(r, 800))
  }
  console.log('> Routes warmed')
}

// ── Background scheduler (every minute) ─────────────────────────
if (!process.env.CRON_SECRET) {
  console.error(
    '[cron] CRON_SECRET is not set — scheduler disabled. Queue jobs, scheduled posts and\n' +
    '       analytics refresh will NOT run. Add CRON_SECRET to .env.local to enable them.',
  )
} else {
  // Without this guard, node-cron fires a new self-fetch every 60s regardless
  // of whether the previous tick's request ever resolved. /api/cron/tick does
  // real sequential work (profile scans, drive-archive uploads that hold a
  // per-user pg_advisory_lock, pod health checks, queue dispatch) that can
  // legitimately run past a minute — so a slow tick used to leave the next
  // one (and the one after that, ...) stacking up concurrently on this same
  // single Node process, each competing for the same DB locks and outbound
  // connections. That pile-up is what surfaced as "HeadersTimeoutError" on
  // completely unrelated self-fetches (queue/submit, telegram/webhook) once
  // enough of them had queued up — it wasn't any single endpoint being slow,
  // it was N overlapping copies of everything running at once.
  let tickRunning = false
  cron.schedule('* * * * *', async () => {
    if (tickRunning) {
      console.warn('[cron] previous tick still in flight — skipping this minute')
      return
    }
    tickRunning = true
    try {
      await fetch(`${base}/api/cron/tick`, {
        headers: { 'x-cron-secret': process.env.CRON_SECRET },
        // Bounded below undici's own 300s default so a genuinely stuck tick
        // releases the lock on its own instead of wedging the scheduler shut.
        signal: AbortSignal.timeout(280_000),
      })
    } catch (err) {
      console.error('[cron] tick failed:', err)
    } finally {
      tickRunning = false
    }
  })

  console.log('> Scheduler running (every minute, non-overlapping)')
}
