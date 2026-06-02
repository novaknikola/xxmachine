import { NextResponse } from 'next/server'
import { query, rows } from '@/lib/db'

interface Check {
  name: string
  ok: boolean
  value?: string
  error?: string
}

async function tableExists(table: string): Promise<boolean> {
  try {
    const r = await query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
      [table],
    )
    return r.rowCount! > 0
  } catch {
    return false
  }
}

export async function GET() {
  const checks: Check[] = []

  // ── 1. DB connection ─────────────────────────────────────────
  try {
    await query('SELECT 1')
    checks.push({ name: 'DB connection', ok: true })
  } catch (err) {
    checks.push({ name: 'DB connection', ok: false, error: String(err) })
    return NextResponse.json({ checks, summary: 'DB unreachable — all other checks skipped' })
  }

  // ── 2. Required tables ───────────────────────────────────────
  const requiredTables = [
    'users', 'sessions',
    'instagram_accounts', 'instagram_queue',
    'threads_accounts',
    'scheduled_posts',
    'viral_reels', 'tracked_profiles',
  ]
  for (const t of requiredTables) {
    const exists = await tableExists(t)
    checks.push({ name: `Table: ${t}`, ok: exists, error: exists ? undefined : 'Table missing — run migration SQL' })
  }

  // ── 3. Instagram env vars ────────────────────────────────────
  const igAppId     = process.env.INSTAGRAM_APP_ID
  const igSecret    = process.env.INSTAGRAM_APP_SECRET
  const igRedirect  = process.env.INSTAGRAM_REDIRECT_URI
  checks.push({ name: 'Env: INSTAGRAM_APP_ID',      ok: !!igAppId,    value: igAppId    ?? '(not set)' })
  checks.push({ name: 'Env: INSTAGRAM_APP_SECRET',  ok: !!igSecret,   value: igSecret   ? '✓ set'      : '(not set)' })
  checks.push({ name: 'Env: INSTAGRAM_REDIRECT_URI',ok: !!igRedirect, value: igRedirect ?? '(not set)' })

  // ── 4. Threads env vars ──────────────────────────────────────
  const thAppId    = process.env.THREADS_APP_ID
  const thSecret   = process.env.THREADS_APP_SECRET
  const thRedirect = process.env.THREADS_REDIRECT_URI
  checks.push({ name: 'Env: THREADS_APP_ID',       ok: !!thAppId,    value: thAppId    ?? '(not set)' })
  checks.push({ name: 'Env: THREADS_APP_SECRET',   ok: !!thSecret,   value: thSecret   ? '✓ set'      : '(not set)' })
  checks.push({ name: 'Env: THREADS_REDIRECT_URI', ok: !!thRedirect, value: thRedirect ?? '(not set)' })

  // ── 5. Instagram accounts ────────────────────────────────────
  const igTableOk = await tableExists('instagram_accounts')
  if (igTableOk) {
    try {
      const accounts = await rows<{
        id: string; name: string; ig_username: string | null
        has_graph_token: boolean; has_private_session: boolean
        has_password: boolean; token_expires_at: string | null
      }>(
        `SELECT id, name, ig_username,
                (ig_access_token IS NOT NULL)  AS has_graph_token,
                (ig_session IS NOT NULL)        AS has_private_session,
                (ig_password IS NOT NULL)       AS has_password,
                ig_token_expires_at             AS token_expires_at
         FROM instagram_accounts ORDER BY name`
      )
      if (accounts.length === 0) {
        checks.push({ name: 'Instagram accounts', ok: false, error: 'No accounts in DB — add one via /socials' })
      } else {
        for (const acc of accounts) {
          const graphExpired = acc.token_expires_at ? new Date(acc.token_expires_at) < new Date() : null
          const connectedViaGraph   = acc.has_graph_token   && graphExpired !== true
          const connectedViaPrivate = acc.has_private_session
          const connected = connectedViaGraph || connectedViaPrivate

          let status: string
          if (connectedViaPrivate)   status = 'connected via Private API (ig_session)'
          else if (connectedViaGraph) status = `connected via Graph API (token valid until ${acc.token_expires_at})`
          else if (acc.has_graph_token && graphExpired) status = `Graph token EXPIRED (${acc.token_expires_at})`
          else if (acc.has_password)  status = 'has password but never logged in — click Connect'
          else                        status = 'no token, no session, no password — credentials missing'

          checks.push({
            name: `IG account: ${acc.name} (@${acc.ig_username ?? '?'})`,
            ok: connected,
            value: status,
          })
        }
      }
    } catch (err) {
      checks.push({ name: 'Instagram accounts', ok: false, error: String(err) })
    }
  }

  // ── 6. Threads accounts ──────────────────────────────────────
  const thTableOk = await tableExists('threads_accounts')
  if (thTableOk) {
    try {
      const accounts = await rows<{
        id: string; name: string; threads_username: string | null
        threads_user_id: string | null; connected: boolean; token_expires_at: string | null
      }>(
        `SELECT id, name, threads_username, threads_user_id,
                (access_token IS NOT NULL) AS connected,
                token_expires_at
         FROM threads_accounts ORDER BY name`
      )
      if (accounts.length === 0) {
        checks.push({ name: 'Threads accounts', ok: false, error: 'No accounts in DB — add one via /socials' })
      } else {
        for (const acc of accounts) {
          const expired = acc.token_expires_at ? new Date(acc.token_expires_at) < new Date() : null
          let status: string
          if (!acc.connected)           status = 'no token — needs OAuth (click Connect in /socials)'
          else if (expired === true)     status = `TOKEN EXPIRED (${acc.token_expires_at}) — needs re-auth`
          else if (expired === false)    status = `token valid until ${acc.token_expires_at}`
          else                          status = 'connected (no expiry date stored)'
          checks.push({
            name: `Threads account: ${acc.name} (@${acc.threads_username ?? acc.threads_user_id ?? '?'})`,
            ok: acc.connected && expired !== true,
            value: status,
          })
        }
      }
    } catch (err) {
      checks.push({ name: 'Threads accounts', ok: false, error: String(err) })
    }
  }

  // ── 7. Live token test — Instagram Graph API ─────────────────
  if (igTableOk) {
    try {
      const firstConnected = await query<{ ig_access_token: string; ig_username: string }>(
        `SELECT ig_access_token, ig_username FROM instagram_accounts
         WHERE ig_access_token IS NOT NULL LIMIT 1`
      )
      if (firstConnected.rows.length > 0) {
        const { ig_access_token, ig_username } = firstConnected.rows[0]
        const testRes = await fetch(
          `https://graph.instagram.com/me?fields=id,username&access_token=${ig_access_token}`
        )
        const testData = await testRes.json()
        if (testRes.ok) {
          checks.push({ name: `IG API live test (@${ig_username})`, ok: true, value: `Graph API returned id=${testData.id}` })
        } else {
          checks.push({ name: `IG API live test (@${ig_username})`, ok: false, error: testData.error?.message ?? JSON.stringify(testData) })
        }
      }
    } catch (err) {
      checks.push({ name: 'IG API live test', ok: false, error: String(err) })
    }
  }

  // ── Summary ──────────────────────────────────────────────────
  const failed = checks.filter(c => !c.ok)
  const summary = failed.length === 0
    ? '✅ All checks passed'
    : `❌ ${failed.length} issue(s) found: ${failed.map(c => c.name).join(', ')}`

  return NextResponse.json({ summary, checks }, { status: failed.length > 0 ? 207 : 200 })
}
