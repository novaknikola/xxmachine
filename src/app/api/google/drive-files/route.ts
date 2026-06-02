import { NextRequest, NextResponse } from 'next/server'
import { one, rows } from '@/lib/db'
import { getGoogleAccessToken } from '@/lib/google-auth'

export async function GET(req: NextRequest) {
  try {
    const accountId = req.nextUrl.searchParams.get('accountId')
    if (!accountId) return NextResponse.json({ error: 'accountId required' }, { status: 400 })

    const acc = await one<{ google_drive_folder_id: string | null }>(
      `SELECT google_drive_folder_id FROM instagram_accounts WHERE id=$1`,
      [accountId]
    )

    if (!acc?.google_drive_folder_id) return NextResponse.json({ error: 'No Drive folder configured — set google_drive_folder_id for this account' }, { status: 400 })

    const accessToken = await getGoogleAccessToken()

    const query = encodeURIComponent(
      `'${acc.google_drive_folder_id}' in parents and mimeType='video/mp4' and trashed=false`
    )
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,createdTime,size)&orderBy=createdTime&pageSize=100`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    )

    const data = await res.json()
    if (!res.ok) throw new Error(data.error?.message ?? 'Drive API error')

    const queuedIds = await rows<{ drive_file_id: string }>(
      `SELECT drive_file_id FROM instagram_queue WHERE account_id=$1 AND status IN ('pending','publishing','done')`,
      [accountId]
    )
    const usedSet = new Set(queuedIds.map(r => r.drive_file_id))
    const files = (data.files ?? []).filter((f: { id: string }) => !usedSet.has(f.id))

    return NextResponse.json({ files })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
