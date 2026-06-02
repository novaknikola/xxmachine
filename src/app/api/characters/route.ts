import { NextResponse } from 'next/server'
import { rows } from '@/lib/db'

export async function GET() {
  try {
    const chars = await rows<{
      id: string
      name: string
      instagram_user_id: string | null
      instagram_username: string | null
      instagram_access_token: string | null
      instagram_token_expires_at: string | null
      proxy_url: string | null
      ig_username: string | null
      google_drive_folder_id: string | null
    }>(
      `SELECT id, name, instagram_user_id, instagram_username, instagram_access_token,
              instagram_token_expires_at, proxy_url, ig_username, google_drive_folder_id
       FROM characters ORDER BY name`
    )
    return NextResponse.json(chars)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
