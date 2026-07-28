import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { one, query } from '@/lib/db'
import { clearUserGoogleDrive, getUserGoogleAccessToken } from '@/lib/drive-archive/user-google-auth'
import { ensureDriveRootFolder } from '@/lib/drive-archive/ensure-root-folder'

export async function GET(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const row = await one<{
    google_refresh_token: string | null
    drive_root_folder_id: string | null
    drive_auto_archive: boolean
  }>(
    `SELECT google_refresh_token, drive_root_folder_id, drive_auto_archive
       FROM users WHERE id = $1`,
    [auth.id],
  )

  const connected = Boolean(row?.google_refresh_token)
  const pending = connected
    ? await one<{ count: string }>(
        `SELECT count(*)::text AS count FROM drive_exports
          WHERE user_id = $1 AND status IN ('pending', 'uploading', 'failed')`,
        [auth.id],
      )
    : null

  return NextResponse.json({
    connected,
    autoArchive: row?.drive_auto_archive ?? false,
    rootFolderId: row?.drive_root_folder_id ?? null,
    rootFolderUrl: row?.drive_root_folder_id
      ? `https://drive.google.com/drive/folders/${row.drive_root_folder_id}`
      : null,
    pendingExports: pending ? Number(pending.count) : 0,
  })
}

export async function PATCH(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const body = await req.json() as {
    action?: 'toggle' | 'disconnect' | 'ensure_root'
    autoArchive?: boolean
  }

  if (body.action === 'disconnect') {
    await clearUserGoogleDrive(auth.id)
    return NextResponse.json({ ok: true, connected: false, autoArchive: false })
  }

  if (body.action === 'ensure_root') {
    try {
      const token = await getUserGoogleAccessToken(auth.id)
      const rootFolderId = await ensureDriveRootFolder(token)
      await query(
        `UPDATE users SET drive_root_folder_id = $2 WHERE id = $1`,
        [auth.id, rootFolderId],
      )
      return NextResponse.json({
        ok: true,
        rootFolderId,
        rootFolderUrl: `https://drive.google.com/drive/folders/${rootFolderId}`,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create Drive folder'
      return NextResponse.json({ error: msg }, { status: 400 })
    }
  }

  if (body.action === 'toggle' || typeof body.autoArchive === 'boolean') {
    const enabled = Boolean(body.autoArchive)
    if (enabled) {
      const row = await one<{ google_refresh_token: string | null }>(
        `SELECT google_refresh_token FROM users WHERE id = $1`,
        [auth.id],
      )
      if (!row?.google_refresh_token) {
        return NextResponse.json(
          { error: 'Connect Google Drive first' },
          { status: 400 },
        )
      }
    }
    await query(
      `UPDATE users SET drive_auto_archive = $2 WHERE id = $1`,
      [auth.id, enabled],
    )
    return NextResponse.json({ ok: true, autoArchive: enabled })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
