import { NextResponse } from 'next/server'
import { rows } from '@/lib/db'
import { getIgClient, saveIgSession, loginIgClient } from '@/lib/ig-private-api'
import { one } from '@/lib/db'

export const maxDuration = 300

export async function POST() {
  const pending = await rows<{
    id: string; name: string; ig_username: string; ig_password: string; ig_totp_secret: string | null
  }>(
    `SELECT id, name, ig_username, ig_password, ig_totp_secret
     FROM instagram_accounts
     WHERE ig_password IS NOT NULL
       AND ig_session IS NULL
     ORDER BY name`
  )

  if (!pending.length) {
    return NextResponse.json({ message: 'No pending accounts', results: [] })
  }

  const results: Array<{ name: string; username: string; ok: boolean; error?: string }> = []

  for (const acc of pending) {
    if (!acc.ig_username || !acc.ig_password) {
      results.push({ name: acc.name, username: acc.ig_username ?? '?', ok: false, error: 'Missing credentials' })
      continue
    }
    try {
      const ig = await getIgClient(acc.id)
      const loggedIn = await loginIgClient(ig, acc.ig_username, acc.ig_password, acc.ig_totp_secret)
      await saveIgSession(acc.id, ig)
      await one(`UPDATE instagram_accounts SET ig_username=$1 WHERE id=$2`, [loggedIn.username, acc.id])
      results.push({ name: acc.name, username: loggedIn.username, ok: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({ name: acc.name, username: acc.ig_username, ok: false, error: msg })
    }
    // 2s delay between logins to avoid rate limiting
    await new Promise(r => setTimeout(r, 2000))
  }

  const connected = results.filter(r => r.ok).length
  const failed    = results.filter(r => !r.ok).length

  return NextResponse.json({
    summary: `${connected} connected, ${failed} failed out of ${pending.length}`,
    results,
  })
}
