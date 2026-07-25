import { NextRequest, NextResponse } from 'next/server'
import { rows, one } from '@/lib/db'

export async function GET() {
  try {
    const accounts = await rows<{
      id: string
      name: string
      ig_username: string | null
      proxy_url: string | null
      google_drive_folder_id: string | null
      token_expires_at: string | null
      has_password: boolean
connected: boolean
graph_connected: boolean
browser_connected: boolean
    }>(
      
  `SELECT id, name, ig_username,
          (ig_access_token IS NOT NULL OR ig_session IS NOT NULL) AS connected,
          (ig_access_token IS NOT NULL AND ig_user_id IS NOT NULL) AS graph_connected,
          (ig_session IS NOT NULL) AS browser_connected,
          ig_token_expires_at AS token_expires_at,
          proxy_url,
          google_drive_folder_id,
          (ig_password IS NOT NULL) AS has_password
   FROM instagram_accounts
   ORDER BY name`
)
      
    return NextResponse.json(accounts)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { name, igUsername, igPassword, igTotpSecret, proxyUrl } = await req.json()
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })
    const row = await one<{ id: string }>(
      `INSERT INTO instagram_accounts (name, ig_username, ig_password, ig_totp_secret, proxy_url)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [name, igUsername ?? null, igPassword ?? null, igTotpSecret ?? null, proxyUrl ?? null]
    )
    return NextResponse.json({ id: row!.id })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { id, name, proxyUrl, driveFolderId } = await req.json()
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    await one(
      `UPDATE instagram_accounts SET
        name = COALESCE($1, name),
        proxy_url = COALESCE($2, proxy_url),
        google_drive_folder_id = COALESCE($3, google_drive_folder_id)
       WHERE id=$4`,
      [name ?? null, proxyUrl ?? null, driveFolderId ?? null, id]
    )
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { id } = await req.json()
    await one(`DELETE FROM instagram_accounts WHERE id=$1`, [id])
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
