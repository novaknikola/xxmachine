// Full pipeline for a batch of Instagram accounts tracked in a Google Sheet:
// for each row (username, password, totp_secret, status) not yet genuinely
// connected, adds it as a Meta Instagram Tester (one shared browser login),
// imports it into instagram_accounts with a generated proxy if not already
// there, runs the full OAuth-connect flow, and writes the real outcome back
// to the sheet's status column — so the sheet becomes the source of truth
// instead of a stale manual log.
//
// Run manually on the VPS:
//   DISPLAY=:99 npx tsx scripts/sync-accounts-from-sheet.ts
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import fs from 'fs'
import { one, query, rows } from '../src/lib/db'
import { readSheetRange, writeSheetCell } from '../src/lib/google-sheets'
import { launchMetaAdminBrowser } from '../src/lib/meta-admin/browser'
import { loginToMeta } from '../src/lib/meta-admin/login'
import { addInstagramTester } from '../src/lib/meta-admin/testers'
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
  // gid=0 is virtually always the first/default tab — Sheets API needs the
  // tab's *name* for A1 notation, not its gid, so this is discovered live
  // rather than assumed to be "Sheet1".
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

async function main() {
  console.log('Resolving sheet tab name...')
  const sheetName = await resolveSheetName()
  console.log('Sheet tab:', sheetName)

  console.log('Reading account rows...')
  const values = await readSheetRange(GOOGLE_USER_ID, SPREADSHEET_ID, `${sheetName}!A1:D1000`)
  const sheetRows: SheetRow[] = values
    .map((r, i) => ({ rowNumber: i + 1, username: (r[0] ?? '').trim(), password: (r[1] ?? '').trim(), totp: (r[2] ?? '').replace(/\s+/g, '') }))
    .filter(r => r.username && r.password)
  console.log(`Found ${sheetRows.length} account rows.`)

  async function setStatus(rowNumber: number, status: string) {
    await writeSheetCell(GOOGLE_USER_ID, SPREADSHEET_ID, `${sheetName}!D${rowNumber}`, status).catch(err =>
      console.error(`  (failed to write status for row ${rowNumber}: ${err instanceof Error ? err.message : err})`))
  }

  // Cross-check every username against the DB in one query instead of N.
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

  // Correct any stale "connected" label for rows that are actually fine —
  // cheap, and keeps the sheet trustworthy even for rows this run skips.
  for (const r of alreadyConnected) {
    await setStatus(r.rowNumber, 'connected')
  }

  // Phase 1: add every not-yet-imported account as an Instagram Tester,
  // reusing one Meta admin browser session (one login, not N).
  const needsTester = needsWork.filter(r => !r.accountId)
  if (needsTester.length) {
    console.log(`\nPhase 1: adding ${needsTester.length} accounts as Instagram Testers...`)
    const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'))
    const { context, page } = await launchMetaAdminBrowser()
    try {
      await loginToMeta(page, creds)
      for (const r of needsTester) {
        try {
          await addInstagramTester(page, META_APP_ID, r.username)
          console.log(`  tester ok: ${r.username}`)
        } catch (err) {
          console.log(`  tester FAILED: ${r.username} — ${err instanceof Error ? err.message : err}`)
          // Not fatal — OAuth connect below will surface its own error if
          // the tester-add really didn't take.
        }
        await page.waitForTimeout(2000)
      }
    } finally {
      await context.close()
    }
  }

  // Phase 2: import any not-yet-in-DB accounts with a fresh proxy.
  console.log('\nPhase 2: importing new accounts into the DB...')
  for (const r of needsWork) {
    if (r.accountId) continue
    const proxy = buildProxyUrl(r.username)
    const inserted = await one<{ id: string }>(
      `INSERT INTO instagram_accounts (name, ig_username, ig_password, ig_totp_secret, proxy_url)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [r.username, r.username, r.password, r.totp, proxy],
    )
    r.accountId = inserted!.id
    console.log(`  imported: ${r.username} -> ${r.accountId}`)
  }

  // Phase 3: OAuth-connect each account sequentially, writing real status
  // back to the sheet immediately (not batched) so progress survives an
  // interruption and is visible while it's still running.
  console.log(`\nPhase 3: OAuth-connecting ${needsWork.length} accounts...`)
  const results: Record<string, string> = {}
  let i = 0
  for (const r of needsWork) {
    i++
    console.log(`[${i}/${needsWork.length}] Connecting ${r.username} (${r.accountId})...`)
    try {
      await connectAccountViaOAuth(r.accountId!)
      await setStatus(r.rowNumber, 'connected')
      results[r.username] = 'connected'
      console.log(`  ✓ ${r.username}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const status = message.includes('suspended') ? 'suspended' : `failed: ${message.slice(0, 100)}`
      await setStatus(r.rowNumber, status)
      results[r.username] = status
      console.log(`  ✗ ${r.username}: ${status}`)
    }
    writeProgress(results)
    await new Promise(res => setTimeout(res, 4000))
  }

  console.log('\n=== Summary ===')
  console.log(JSON.stringify(results, null, 2))
}

main().catch(err => { console.error(err); process.exit(1) })
