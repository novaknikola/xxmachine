import { createServer as createHttpServer } from 'http'
import { createServer as createHttpsServer } from 'https'
import { parse } from 'url'
import next from 'next'
import cron from 'node-cron'
import { readFileSync, existsSync } from 'fs'

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

const app = next({ dev, turbopack: dev })
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
  const routes = ['/bulk', '/reels', '/socials', '/motion', '/schedule']
  console.log('> Pre-warming routes...')
  for (const route of routes) {
    fetch(`${base}${route}`).catch(() => {})
    await new Promise(r => setTimeout(r, 800))
  }
  console.log('> Routes warmed')
}

// ── Background scheduler (every minute) ─────────────────────────
cron.schedule('* * * * *', async () => {
  try {
    await fetch(`${base}/api/cron/tick`, {
      headers: { 'x-cron-secret': process.env.CRON_SECRET ?? '' },
    })
  } catch (err) {
    console.error('[cron] tick failed:', err)
  }
})

console.log('> Scheduler running (every minute)')
