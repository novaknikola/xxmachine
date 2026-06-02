import { NextRequest, NextResponse } from 'next/server'
import { one } from '@/lib/db'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const allowed = ['googleDriveFolderId', 'proxy_url', 'ig_username', 'ig_password', 'ig_totp_secret']
  const colMap: Record<string, string> = {
    googleDriveFolderId: 'google_drive_folder_id',
    proxy_url: 'proxy_url',
    ig_username: 'ig_username',
    ig_password: 'ig_password',
    ig_totp_secret: 'ig_totp_secret',
  }

  const sets: string[] = []
  const vals: unknown[] = []
  let idx = 1
  for (const key of allowed) {
    if (key in body) {
      sets.push(`${colMap[key]}=$${idx}`)
      vals.push(body[key] ?? null)
      idx++
    }
  }
  if (!sets.length) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  vals.push(id)
  await one(`UPDATE characters SET ${sets.join(',')} WHERE id=$${idx}`, vals)
  return NextResponse.json({ ok: true })
}
