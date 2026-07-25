import { NextRequest, NextResponse } from 'next/server'
import { rows, query } from '@/lib/db'
import { requireAdmin } from '@/lib/session'

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req)
  if (admin instanceof NextResponse) return admin

  const userId = req.nextUrl.searchParams.get('userId')
  if (!userId) {
    return NextResponse.json({ error: 'userId required' }, { status: 400 })
  }

  const permissions = await rows(
    `SELECT module_name, enabled
     FROM user_permissions
     WHERE user_id = $1
     ORDER BY module_name`,
    [userId]
  )

  return NextResponse.json({ permissions })
}

export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin(req)
  if (admin instanceof NextResponse) return admin

  const { userId, moduleName, enabled } = await req.json()

  if (!userId || !moduleName) {
    return NextResponse.json(
      { error: 'userId and moduleName required' },
      { status: 400 }
    )
  }

  await query(
    `INSERT INTO user_permissions (user_id, module_name, enabled)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, module_name)
     DO UPDATE SET enabled = EXCLUDED.enabled`,
    [userId, moduleName, enabled ?? true]
  )

  return NextResponse.json({ ok: true })
}