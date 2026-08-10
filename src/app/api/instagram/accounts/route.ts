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
assigned_sheet_name: string | null
published_count: number
pending_count: number
failed_count: number
    }>(

  `SELECT a.id, a.name, a.ig_username,
          (a.ig_access_token IS NOT NULL OR a.ig_session IS NOT NULL) AS connected,
          (a.ig_access_token IS NOT NULL AND a.ig_user_id IS NOT NULL) AS graph_connected,
          (a.ig_session IS NOT NULL) AS browser_connected,
          a.ig_token_expires_at AS token_expires_at,
          a.proxy_url,
          a.google_drive_folder_id,
          (a.ig_password IS NOT NULL) AS has_password,
          (SELECT m.sheet_name FROM content_source_mappings m
           WHERE m.instagram_account_id = a.id ORDER BY m.sheet_name LIMIT 1) AS assigned_sheet_name,
          COALESCE(q.published_count, 0) AS published_count,
          COALESCE(q.pending_count, 0) AS pending_count,
          COALESCE(q.failed_count, 0) AS failed_count
   FROM instagram_accounts a
   LEFT JOIN (
     SELECT account_id,
            COUNT(*) FILTER (WHERE status = 'done') AS published_count,
            COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
            COUNT(*) FILTER (WHERE status = 'failed') AS failed_count
     FROM instagram_queue
     GROUP BY account_id
   ) q ON q.account_id = a.id
   ORDER BY a.name`
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
    const { id, name, proxyUrl, driveFolderId, igUsername, igPassword, igTotpSecret } = await req.json()
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    await one(
      `UPDATE instagram_accounts SET
        name = COALESCE($1, name),
        proxy_url = COALESCE($2, proxy_url),
        google_drive_folder_id = COALESCE($3, google_drive_folder_id),
        ig_username = COALESCE($4, ig_username),
        ig_password = COALESCE($5, ig_password),
        ig_totp_secret = COALESCE($6, ig_totp_secret)
       WHERE id=$7`,
      [name ?? null, proxyUrl ?? null, driveFolderId ?? null, igUsername ?? null, igPassword ?? null, igTotpSecret ?? null, id]
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
