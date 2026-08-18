// Full pipeline for a batch of Instagram accounts tracked in a Google Sheet:
// for each row (username, password, totp_secret, status) not yet genuinely
// connected, adds it as a Meta Instagram Tester, imports it into
// instagram_accounts with a generated proxy if not already there, runs the
// full OAuth-connect flow, and writes the real outcome back to the sheet's
// status column — so the sheet becomes the source of truth instead of a
// stale manual log.
//
// Paced deliberately slowly and interleaved per-account (tester-add then
// immediately OAuth-connect for that same account, not two big separate
// phases) — confirmed live (2026-08-13) that Meta's own anti-abuse system
// temporarily blocks the Add People dashboard action after ~8 rapid
// submissions, and the old two-phase design meant that block silently
// stalled the ENTIRE run before any account ever reached the sheet-writing
// step. This version aborts immediately on that block instead of grinding
// through the rest of the list against a wall, and paces each Add People
// action with a long randomized human-scale delay (not a fixed short one).
//
// Run manually on the VPS:
//   DISPLAY=:99 npx tsx scripts/sync-accounts-from-sheet.ts
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import fs from 'fs'
import { one, rows } from '../src/lib/db'
import { readSheetRange, writeSheetCell } from '../src/lib/google-sheets'
import { launchMetaAdminBrowser } from '../src/lib/meta-admin/browser'
import { loginToMeta } from '../src/lib/meta-admin/login'
import { addInstagramTester, MetaRateLimitedError } from '../src/lib/meta-admin/testers'
import { connectAccountViaOAuth } from '../src/lib/instagram/auto-oauth-connect'

const SPREADSHEET_ID = '1jkurYqie-ZcuZRVCnSkSfpwWEotQG_wjs_NGJDwYWxU'
const GOOGLE_USER_ID = 'f469a1b8-67fc-4103-8c6c-89e2873a1c7a' // novakovicbbrs@gmail.com
const META_APP_ID = '2904588276606941'
const CREDS_PATH = '/root/meta-admin-creds.json'
const PROGRESS_LOG = '/root/sheet-sync-progress.json'

interface SheetRow {
  rowNumber: number // 1-indexed, matches the actual sheet row
  username: string
  password: string
  totp: string
}

function buildProxyUrl(username: string): string {
  const session = 'batch3_' + username.replace(/[^a-zA-Z0-9]/g, '') + '_' + Date.now()
  return `http://batbPp6Uzd8i9qHI:71bfQNs2NQ9xVKvc_country-us_session-${session}_lifetime-30m@geo.iproyal.com:12321`
}

async function resolveSheetName(): Promise<string> {
  const { getUserGoogleAccessToken } = await import('../src/lib/drive-archive/user-google-auth')
  const accessToken = await getUserGoogleAccessToken(GOOGLE_USER_ID)
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Failed to read spreadsheet metadata: ${res.status} ${await res.text()}`)
  const data = await res.json() as { sheets: { properties: { sheetId: number; title: string } }[] }
  const first = data.sheets.find(s => s.properties.sheetId === 0) ?? data.sheets[0]
  return first.properties.title
}

function writeProgress(entries: Record<string, string>) {
  fs.writeFileSync(PROGRESS_LOG, JSON.stringify(entries, null, 2))
}

/** Random human-scale pause, not a fixed one — real people don't act on a metronome. */
function humanDelayMs(minSec: number, maxSec: number): number {
  return (minSec + Math.random() * (maxSec - minSec)) * 1000
}
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms))

// Timeouts, dropped connections, a slow-rendering page — worth one retry
// after a real pause, since the persistent Chrome profile usually resumes
// mid-session rather than from scratch. Suspensions, wrong credentials, and
// "no TOTP secret" are real outcomes retrying can't change — those still
// fail immediately, once.
function isTransientError(message: string): boolean {
  return /timeout|econnreset|etimedout|net::err|execution context was destroyed/i.test(message)
}

// "Unsupported request - method type: get" at the token-exchange step is
// the documented signature of an account that was never actually granted
// the Instagram Tester role on Meta's dashboard, even though it already has
// a DB row (accountId) — confirmed live 2026-08-19 for beckett.browning,
// same root cause as the earlier regan515571/frankie509489 case: having an
// accountId only means "imported", not "tester-add actually succeeded"
// (e.g. it silently lost to Meta's rate limiter in an earlier run). Routing
// this into the tester-stage retry (not a plain oauth retry) means the next
// pass actually re-adds it as a tester before trying to connect again,
// instead of repeating the same doomed OAuth attempt forever.
function isTesterGateError(message: string): boolean {
  return /unsupported request/i.test(message)
}

async function main() {
  console.log('Resolving sheet tab name...')
  const sheetName = await resolveSheetName()
  console.log('Sheet tab:', sheetName)

  console.log('Reading account rows...')
  const values = await readSheetRange(GOOGLE_USER_ID, SPREADSHEET_ID, `${sheetName}!A1:D1000`)
  let sheetRows: SheetRow[] = values
    .map((r, i) => ({ rowNumber: i + 1, username: (r[0] ?? '').trim(), password: (r[1] ?? '').trim(), totp: (r[2] ?? '').replace(/\s+/g, '') }))
    .filter(r => r.username && r.password)
  console.log(`Found ${sheetRows.length} account rows.`)

  // Optional: pass specific usernames as argv to run a small controlled
  // batch (e.g. testing after a fix) instead of the whole remaining sheet.
  const onlyUsernames = process.argv.slice(2).map(u => u.toLowerCase())
  if (onlyUsernames.length) {
    sheetRows = sheetRows.filter(r => onlyUsernames.includes(r.username.toLowerCase()))
    console.log(`Filtered to ${sheetRows.length} requested account(s): ${onlyUsernames.join(', ')}`)
  }

  async function setStatus(rowNumber: number, status: string) {
    await writeSheetCell(GOOGLE_USER_ID, SPREADSHEET_ID, `${sheetName}!D${rowNumber}`, status).catch(err =>
      console.error(`  (failed to write status for row ${rowNumber}: ${err instanceof Error ? err.message : err})`))
  }

  const usernames = sheetRows.map(r => r.username.toLowerCase())
  const existing = await rows<{ id: string; ig_username: string; has_token: boolean }>(
    `SELECT id, ig_username, (ig_access_token IS NOT NULL) AS has_token
       FROM instagram_accounts WHERE lower(ig_username) = ANY($1)`,
    [usernames],
  )
  const dbByUsername = new Map(existing.map(r => [r.ig_username.toLowerCase(), r]))

  const alreadyConnected: SheetRow[] = []
  const needsWork: (SheetRow & { accountId: string | null })[] = []

  for (const r of sheetRows) {
    const dbRow = dbByUsername.get(r.username.toLowerCase())
    if (dbRow?.has_token) {
      alreadyConnected.push(r)
    } else {
      needsWork.push({ ...r, accountId: dbRow?.id ?? null })
    }
  }

  console.log(`${alreadyConnected.length} already connected, ${needsWork.length} need work.`)

  for (const r of alreadyConnected) {
    await setStatus(r.rowNumber, 'connected')
  }

  // A row already having an accountId means it's already in the DB — for
  // this batch that also means it already cleared the Meta Tester step in
  // an earlier (interrupted) run, so it skips straight to OAuth-connect
  // instead of hitting the Meta dashboard again unnecessarily.
  const needsTester = needsWork.filter(r => !r.accountId)
  console.log(`${needsTester.length} need Meta Tester add, ${needsWork.length - needsTester.length} already tester-added.`)

  let metaContext: Awaited<ReturnType<typeof launchMetaAdminBrowser>>['context'] | null = null
  let metaPage: Awaited<ReturnType<typeof launchMetaAdminBrowser>>['page'] | null = null
  async function ensureMetaBrowser() {
    if (metaPage) return
    const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'))
    const launched = await launchMetaAdminBrowser()
    metaContext = launched.context
    metaPage = launched.page
    await loginToMeta(metaPage, creds)
  }
  if (needsTester.length) {
    await ensureMetaBrowser()
  }

  const results: Record<string, string> = {}
  let rateLimited = false
  let processed = 0
  const retryQueue: (SheetRow & { accountId: string; failedStage: 'tester' | 'oauth' })[] = []

  try {
    for (const r of needsWork) {
      // Import into the DB first if this is a brand-new account — cheap,
      // no browser involved.
      if (!r.accountId) {
        const proxy = buildProxyUrl(r.username)
        const inserted = await one<{ id: string }>(
          `INSERT INTO instagram_accounts (name, ig_username, ig_password, ig_totp_secret, proxy_url)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [r.username, r.username, r.password, r.totp, proxy],
        )
        r.accountId = inserted!.id
        console.log(`Imported ${r.username} -> ${r.accountId}`)
      }

      const needsTesterAdd = needsTester.some(t => t.rowNumber === r.rowNumber)
      if (needsTesterAdd) {
        if (!rateLimited) {
          const delay = humanDelayMs(25, 55)
          console.log(`Waiting ${(delay / 1000).toFixed(0)}s before adding ${r.username} as tester...`)
          await sleep(delay)
          try {
            await addInstagramTester(metaPage!, META_APP_ID, r.username)
            console.log(`  tester ok: ${r.username}`)
          } catch (err) {
            if (err instanceof MetaRateLimitedError) {
              console.log(`\n!!! Meta rate-limited us — stopping tester-adds for the rest of this run.`)
              rateLimited = true
            } else {
              const msg = err instanceof Error ? err.message : String(err)
              if (isTransientError(msg)) {
                console.log(`  tester FAILED (transient, will retry): ${r.username} — ${msg}`)
                retryQueue.push({ ...r, accountId: r.accountId!, failedStage: 'tester' })
              } else {
                console.log(`  tester FAILED: ${r.username} — ${msg}`)
                await setStatus(r.rowNumber, `failed: tester add — ${msg.slice(0, 80)}`)
                results[r.username] = 'tester add failed'
                writeProgress(results)
              }
              continue // don't attempt OAuth-connect, it needs the tester role
            }
          }
        }
        if (rateLimited) {
          await setStatus(r.rowNumber, 'pending: Meta rate-limited, retry later')
          results[r.username] = 'skipped (rate limited)'
          writeProgress(results)
          continue
        }
        // Every ~8-10 accounts, a longer break — no continuous unbroken
        // rhythm, closer to how a person actually works through a list.
        processed++
        if (processed % (8 + Math.floor(Math.random() * 3)) === 0) {
          const breakMin = humanDelayMs(180, 360)
          console.log(`Taking a longer break: ${(breakMin / 60000).toFixed(1)} min...`)
          await sleep(breakMin)
        }
      }

      console.log(`Connecting ${r.username} (${r.accountId})...`)
      try {
        await connectAccountViaOAuth(r.accountId!)
        await setStatus(r.rowNumber, 'connected')
        results[r.username] = 'connected'
        console.log(`  ✓ ${r.username}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (isTesterGateError(message)) {
          console.log(`  ✗ ${r.username} (never actually tester-added, will retry via tester-add): ${message}`)
          retryQueue.push({ ...r, accountId: r.accountId!, failedStage: 'tester' })
        } else if (isTransientError(message)) {
          console.log(`  ✗ ${r.username} (transient, will retry): ${message}`)
          retryQueue.push({ ...r, accountId: r.accountId!, failedStage: 'oauth' })
        } else {
          const status = message.includes('suspended') ? 'suspended' : `failed: ${message.slice(0, 100)}`
          await setStatus(r.rowNumber, status)
          results[r.username] = status
          console.log(`  ✗ ${r.username}: ${status}`)
        }
      }
      writeProgress(results)
      // A flat 4s between accounts reads as a script, not a person — random
      // 1-3 minutes between whole account connects instead, on top of the
      // Add People pacing above, so back-to-back OAuth-connects don't look
      // like a burst either.
      const betweenAccounts = humanDelayMs(60, 180)
      console.log(`Waiting ${(betweenAccounts / 1000).toFixed(0)}s before the next account...`)
      await sleep(betweenAccounts)
    }

    // One retry pass for whatever looked transient — after a real pause,
    // not immediately, so a flaky moment (proxy hiccup, slow render) has
    // actually passed rather than hitting the exact same condition again.
    if (retryQueue.length && !rateLimited) {
      const pause = humanDelayMs(120, 300)
      console.log(`\n${retryQueue.length} account(s) had transient failures — waiting ${(pause / 60000).toFixed(1)} min before retrying them once...`)
      await sleep(pause)

      // A tester-gate failure (isTesterGateError) can show up even when the
      // initial pass never opened the Meta browser at all — e.g. every
      // account in this run already had an accountId, per the same "has a
      // DB row" heuristic that caused the gate failure in the first place.
      if (retryQueue.some(r => r.failedStage === 'tester')) {
        await ensureMetaBrowser()
      }

      for (const r of retryQueue) {
        console.log(`Retrying ${r.username} (failed at: ${r.failedStage})...`)
        try {
          if (r.failedStage === 'tester') {
            const delay = humanDelayMs(25, 55)
            await sleep(delay)
            await addInstagramTester(metaPage!, META_APP_ID, r.username)
            console.log(`  tester ok on retry: ${r.username}`)
          }
          await connectAccountViaOAuth(r.accountId)
          await setStatus(r.rowNumber, 'connected')
          results[r.username] = 'connected'
          console.log(`  ✓ ${r.username} (retry succeeded)`)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const status = message.includes('suspended') ? 'suspended' : `failed after retry: ${message.slice(0, 100)}`
          await setStatus(r.rowNumber, status)
          results[r.username] = status
          console.log(`  ✗ ${r.username}: ${status}`)
        }
        writeProgress(results)
        await sleep(humanDelayMs(60, 180))
      }
    }
  } finally {
    if (metaContext) await metaContext.close()
  }

  console.log('\n=== Summary ===')
  console.log(JSON.stringify(results, null, 2))
  if (rateLimited) {
    console.log('\nStopped early due to Meta rate limiting. Re-run later to pick up the remaining "pending" rows.')
  }
}

main().catch(err => { console.error(err); process.exit(1) })
