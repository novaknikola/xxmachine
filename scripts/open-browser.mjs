/**
 * Standalone script — spawned by open-browser and bulk-browser-connect routes.
 * Uses puppeteer (HTTP-based CDP) to avoid Playwright "Invalid URL" on Windows.
 *
 * Args:
 *   Mode A (manual):  "" <stateFile>            — no accountId, user logs in manually
 *   Mode B (account): <accountId> <stateFile>   — auto-fill credentials from DB
 *
 * Proxy is read from DB (mode B) or from DB proxy field if accountId given.
 * For manual mode, proxy can be passed as first arg if no accountId.
 */

import puppeteer from 'puppeteer'
import { chromium as playwrightChromium } from 'playwright-core'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'
import http from 'http'
import net from 'net'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

// Determine mode from args
// If argv[2] looks like a UUID → account mode; otherwise → manual mode with optional proxy
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const arg2 = process.argv[2] || ''
const isAccountMode = UUID_RE.test(arg2)
const accountId = isAccountMode ? arg2 : null
const manualProxyRaw = isAccountMode ? '' : arg2
const stateFile = process.argv[3]
const noProxy = process.argv.includes('--no-proxy')

function writeState(state) {
  if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(state))
}

// Tunnels one CONNECT request to upstream, with optional Proxy-Authorization.
// Resolves with { upstream, extra } on 200, rejects with { status } on non-200.
function upstreamConnect(upstreamHost, upstreamPort, target, authHeader) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    let done = false

    const upstream = net.connect(upstreamPort, upstreamHost, () => {
      upstream.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n` +
        (authHeader ? `Proxy-Authorization: Basic ${authHeader}\r\n` : '') +
        `\r\n`
      )
    })

    const timer = setTimeout(() => {
      if (done) return
      done = true
      upstream.destroy()
      reject(new Error('upstream timeout'))
    }, 15000)

    upstream.on('data', function onData(chunk) {
      if (done) return
      buf = Buffer.concat([buf, chunk])
      if (buf.indexOf('\r\n\r\n') === -1) return
      done = true
      clearTimeout(timer)
      upstream.removeListener('data', onData)
      const endIdx = buf.indexOf('\r\n\r\n') + 4
      const header = buf.slice(0, endIdx).toString()
      const extra = buf.slice(endIdx)
      const statusLine = header.split('\r\n')[0]
      console.log(`[local-proxy] ${target}: ${statusLine}`)
      if (/^HTTP\/1\.[01] 200/.test(header)) resolve({ upstream, extra })
      else { upstream.destroy(); reject(Object.assign(new Error(statusLine), { status: header })) }
    })

    upstream.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(e) } })
  })
}

// Local HTTP proxy that implements the full 407 challenge-response dance.
// Flow: CONNECT (no auth) → if 407 → new connection → CONNECT (with auth) → 200.
// This handles proxies that require challenge-response instead of accepting pre-auth.
function startLocalProxy(upstreamHost, upstreamPort, username, password) {
  const auth = Buffer.from(`${username}:${password}`).toString('base64')

  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => { res.writeHead(501); res.end() })

    server.on('connect', (req, socket, head) => {
      ;(async () => {
        let result
        try {
          // Step 1: try without auth (standard challenge-response)
          result = await upstreamConnect(upstreamHost, upstreamPort, req.url, null)
        } catch (err) {
          if (!err.status?.includes('407')) {
            // Not a 407 — try once more with auth directly (some proxies skip 407)
            try {
              result = await upstreamConnect(upstreamHost, upstreamPort, req.url, auth)
            } catch (err2) {
              console.error(`[local-proxy] CONNECT failed: ${err2.message}`)
              socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
              return socket.destroy()
            }
          } else {
            // Step 2: got 407 — retry with auth on a new connection
            try {
              result = await upstreamConnect(upstreamHost, upstreamPort, req.url, auth)
            } catch (err2) {
              console.error(`[local-proxy] Auth failed: ${err2.message}`)
              socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
              return socket.destroy()
            }
          }
        }

        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        result.upstream.pipe(socket)
        socket.pipe(result.upstream)
        if (result.extra.length) socket.write(result.extra)
        if (head.length) result.upstream.write(head)
      })()

      socket.on('error', () => {})
    })

    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
    server.on('error', reject)
  })
}

function parseProxy(raw) {
  if (!raw) return null
  const parts = raw.split(':')
  if (parts.length === 4 && !raw.startsWith('http')) {
    return { server: `http://${parts[0]}:${parts[1]}`, username: parts[2], password: parts[3] }
  }
  try {
    const u = new URL(raw.startsWith('http') ? raw : `http://${raw}`)
    return {
      server: `${u.protocol}//${u.hostname}:${u.port}`,
      username: u.username || null,
      password: u.password || null,
    }
  } catch {}
  return null
}

// Load .env.local
const envFile = path.join(rootDir, '.env.local')
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/)
    if (m) process.env[m[1].trim()] = m[2].trim()
  }
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
async function dbOne(sql, params) {
  const r = await pool.query(sql, params)
  return r.rows[0] ?? null
}

writeState({ active: true, error: null, done: false })

let browser = null
let localProxyServer = null
let loginDetected = false

process.on('SIGTERM', async () => {
  if (browser) await browser.close().catch(() => {})
  localProxyServer?.close()
  writeState({ active: false, error: null, done: false })
  process.exit(0)
})

try {
  // Load account credentials and proxy if in account mode
  let ig_username = null, ig_password = null, proxy = null

  if (accountId) {
    const acc = await dbOne(
      `SELECT ig_username, ig_password, proxy_url FROM instagram_accounts WHERE id=$1`,
      [accountId]
    )
    if (!acc) throw new Error(`Account not found: ${accountId}`)
    ig_username = acc.ig_username
    ig_password = acc.ig_password
    proxy = noProxy ? null : parseProxy(acc.proxy_url)
    console.log(`[open-browser] Account mode: @${ig_username}, proxy: ${noProxy ? 'skipped (--no-proxy)' : acc.proxy_url || 'none'}`)
  } else {
    proxy = parseProxy(manualProxyRaw)
    console.log(`[open-browser] Manual mode, proxy: ${manualProxyRaw || 'none'}`)
  }

  const profileId = accountId ?? `manual_${Date.now()}`
  const userDataDir = path.join(rootDir, 'chrome-profiles', profileId)
  fs.mkdirSync(userDataDir, { recursive: true })

  const SYSTEM_BROWSERS = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  let executablePath = SYSTEM_BROWSERS.find(p => fs.existsSync(p))
  if (!executablePath) {
    try { executablePath = playwrightChromium.executablePath() } catch {}
  }
  if (!executablePath || !fs.existsSync(executablePath)) {
    throw new Error('No Chrome/Edge browser found. Install Google Chrome.')
  }
  console.log(`[open-browser] Using browser: ${executablePath}`)

  const args = [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1280,900',
    '--lang=en-US',
  ]

  if (proxy) {
    if (proxy.username) {
      // Local proxy pre-authorizes CONNECT requests so Chrome never gets
      // ERR_EMPTY_RESPONSE from proxies that don't send 407 challenges.
      const u = new URL(proxy.server.startsWith('http') ? proxy.server : `http://${proxy.server}`)
      const lp = await startLocalProxy(u.hostname, parseInt(u.port), proxy.username, proxy.password ?? '')
      localProxyServer = lp.server
      args.push(`--proxy-server=http://127.0.0.1:${lp.port}`)
      console.log(`[open-browser] Local proxy on :${lp.port} → ${proxy.server}`)
    } else {
      args.push(`--proxy-server=${proxy.server}`)
    }
  }

  browser = await puppeteer.launch({
    headless: false,
    executablePath,
    userDataDir,
    args,
    defaultViewport: { width: 1280, height: 900 },
    ignoreDefaultArgs: ['--enable-automation'],
  })

  // Exit immediately when user closes Chrome — don't wait for poll cycle.
  // loginDetected guard prevents this from firing when we call browser.close() after a successful login.
  browser.on('disconnected', async () => {
    if (loginDetected) return
    console.log('[open-browser] Browser closed by user')
    localProxyServer?.close()
    await pool.end().catch(() => {})
    writeState({ active: false, error: null, done: false })
    process.exit(0)
  })

  const allPages = await browser.pages()
  // Close any tabs restored from previous session — keep only one
  for (let i = 1; i < allPages.length; i++) await allPages[i].close().catch(() => {})
  const page = allPages[0] ?? await browser.newPage()

  await page.goto('https://www.instagram.com/accounts/login/', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  }).catch(err => {
    // Any navigation error (ERR_TIMED_OUT, detached frame, proxy error, etc.) is recoverable —
    // Chrome stays open and the user can navigate manually or wait for the page to load.
    console.log('[open-browser] goto warning (continuing):', err.message.split('\n')[0])
  })
  console.log('[open-browser] Instagram login page loaded')

  // Auto-fill credentials if available
  if (ig_username && ig_password) {
    try {
      await page.waitForSelector('input[name="username"]', { timeout: 8000 })
      await page.type('input[name="username"]', ig_username, { delay: 60 })
      await page.type('input[name="password"]', ig_password, { delay: 60 })
      await page.click('button[type="submit"]')
      console.log(`[open-browser] Auto-filled credentials for @${ig_username}`)
    } catch (e) {
      console.log('[open-browser] Auto-fill failed (form not found), waiting for manual login:', e.message)
    }
  }

  const deadline = Date.now() + 10 * 60 * 1000

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000))

    let url
    try { url = page.url() } catch { break }

    const loggedIn =
      url.includes('instagram.com') &&
      !url.includes('/accounts/login') &&
      !url.includes('/accounts/emailsignup') &&
      !url.includes('/challenge') &&
      !url.includes('/suspended')

    if (loggedIn) {
      const cookies = await page.cookies('https://www.instagram.com')
      const sessionid = cookies.find(c => c.name === 'sessionid')?.value
      if (!sessionid) continue

      // Extract dsUserId from cookie or from sessionid string (format: "USERID:HASH" URL-encoded)
      const dsUserId = cookies.find(c => c.name === 'ds_user_id')?.value
        || decodeURIComponent(sessionid).split(':')[0]
        || null

      // Get username via Instagram web API inside browser context (cookies + proxy automatic)
      let detectedUsername = null
      try {
        detectedUsername = await page.evaluate(async () => {
          try {
            const r = await fetch('/api/v1/accounts/current_user/?edit=true', { credentials: 'include' })
            if (r.ok) { const d = await r.json(); if (d.user?.username) return d.user.username }
          } catch {}
          const a = document.querySelector('a[href^="/"][role="link"]')
          if (a) { const m = a.href.match(/instagram\.com\/([^/?]+)/); if (m) return m[1] }
          return null
        })
        if (detectedUsername) console.log(`[open-browser] Username: @${detectedUsername}`)
      } catch {}

      const rawSession = {
        cookies: cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path })),
        sessionid,
        dsUserId,
      }

      if (accountId) {
        // Account mode: save directly to this account
        await dbOne(
          `UPDATE instagram_accounts SET ig_session=$1, ig_username=COALESCE($2, ig_username) WHERE id=$3`,
          [JSON.stringify(rawSession), detectedUsername, accountId]
        )
        console.log(`[open-browser] Session saved for accountId=${accountId} (@${detectedUsername})`)
      } else {
        // Manual mode: match by username or dsUserId, or create new
        let account = detectedUsername
          ? await dbOne(`SELECT id, name FROM instagram_accounts WHERE ig_username=$1`, [detectedUsername])
          : null
        if (!account && dsUserId) {
          account = await dbOne(
            `SELECT id, name FROM instagram_accounts WHERE ig_session->>'dsUserId'=$1`,
            [dsUserId]
          )
        }
        if (account) {
          await dbOne(
            `UPDATE instagram_accounts SET ig_session=$1, ig_username=COALESCE($2, ig_username) WHERE id=$3`,
            [JSON.stringify(rawSession), detectedUsername, account.id]
          )
          console.log(`[open-browser] Saved session for: ${account.name} (@${detectedUsername})`)
        } else {
          const newAcc = await dbOne(
            `INSERT INTO instagram_accounts (name, ig_username, ig_session) VALUES ($1,$2,$3) RETURNING id`,
            [detectedUsername ?? `ig_${dsUserId}`, detectedUsername, JSON.stringify(rawSession)]
          )
          console.log(`[open-browser] Created new account @${detectedUsername} (id: ${newAcc?.id})`)
        }
      }

      loginDetected = true
      await browser.close().catch(() => {})
      localProxyServer?.close()
      await pool.end()
      writeState({ active: false, error: null, done: true })
      process.exit(0)
    }
  }

  console.log('[open-browser] Timeout')
  await browser.close().catch(() => {})
  localProxyServer?.close()
  await pool.end()
  writeState({ active: false, error: null, done: false })
  process.exit(0)
} catch (err) {
  console.error('[open-browser] ERROR:', err.message)
  if (browser) await browser.close().catch(() => {})
  localProxyServer?.close()
  await pool.end().catch(() => {})
  writeState({ active: false, error: err.message, done: false })
  process.exit(1)
}
