import { NextRequest, NextResponse } from 'next/server'
import { one } from '@/lib/db'
import { generateFingerprint } from '@/lib/fingerprint'
import { requireUser } from '@/lib/session'
import { encryptIgSecretOrNull } from '@/lib/instagram/secrets'

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.trim().split('\n').filter(Boolean)
  if (lines.length < 2) return []
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase())
  return lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim())
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']))
  })
}

// Normalize proxy to http://user:pass@host:port
// Accepts: ip:port:user:pass  |  http://user:pass@host:port  |  host:port
function normalizeProxy(raw: string): string {
  if (!raw) return ''
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('socks5://')) return raw
  const parts = raw.split(':')
  if (parts.length === 4) return `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`
  return raw
}

export async function POST(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  try {
    const formData = await req.formData()
    const file = formData.get('file') as File | null
    if (!file) return NextResponse.json({ error: 'file required' }, { status: 400 })

    const text = await file.text()
    const rows = parseCSV(text)
    if (!rows.length) return NextResponse.json({ error: 'CSV is empty or has no data rows' }, { status: 400 })

    let imported = 0
    let updated = 0
    const errors: string[] = []

    for (const row of rows) {
      const name = row['name'] || row['account_name']
      const igUsername = row['ig_username'] || row['username'] || row['instagram_username']
      const igPassword = row['ig_password'] || row['password'] || row['instagram_password']
      const igTotpSecret = row['ig_totp_secret'] || row['totp_secret'] || ''
      const proxyUrl = row['proxy_url'] || row['proxy'] || ''
      const driveFolderId = row['drive_folder_id'] || row['google_drive_folder_id'] || ''

      if (!igUsername) { errors.push(`Row missing ig_username: ${JSON.stringify(row)}`); continue }
      const resolvedName = name || igUsername

      const normalizedProxy = normalizeProxy(proxyUrl)

      const existing = await one<{ id: string; browser_fingerprint: object | null }>(
        `SELECT id, browser_fingerprint FROM instagram_accounts
          WHERE (user_id=$3 OR user_id IS NULL)
            AND (lower(ig_username)=lower($1) OR lower(name)=lower($2))`,
        [igUsername, resolvedName, auth.id]
      )

      const encPassword = encryptIgSecretOrNull(igPassword || null)
      const encTotp = encryptIgSecretOrNull(igTotpSecret || null)

      if (existing) {
        const fp = existing.browser_fingerprint ?? generateFingerprint(existing.id)
        await one(
          `UPDATE instagram_accounts SET
            ig_username=$1,
            ig_password=COALESCE($2, ig_password),
            ig_totp_secret=COALESCE($3, ig_totp_secret),
            proxy_url=COALESCE(NULLIF($4,''), proxy_url),
            google_drive_folder_id=COALESCE(NULLIF($5,''), google_drive_folder_id),
            browser_fingerprint=COALESCE(browser_fingerprint, $6::jsonb),
            user_id=COALESCE(user_id, $8)
           WHERE id=$7`,
          [igUsername, encPassword, encTotp, normalizedProxy || null, driveFolderId || null, JSON.stringify(fp), existing.id, auth.id]
        )
        updated++
      } else {
        const newAcc = await one<{ id: string }>(
          `INSERT INTO instagram_accounts (name, ig_username, ig_password, ig_totp_secret, proxy_url, google_drive_folder_id, user_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [resolvedName, igUsername, encPassword, encTotp, normalizedProxy || null, driveFolderId || null, auth.id]
        )
        if (!newAcc) { errors.push(`Failed to insert: ${name}`); continue }
        const fp = generateFingerprint(newAcc.id)
        await one(`UPDATE instagram_accounts SET browser_fingerprint=$1 WHERE id=$2`, [JSON.stringify(fp), newAcc.id])
        imported++
      }
    }

    return NextResponse.json({ imported, updated, errors })
  } catch (err) {
    console.error('[import-csv]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
