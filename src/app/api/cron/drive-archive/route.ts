import { NextRequest, NextResponse } from 'next/server'
import { processDriveExports } from '@/lib/drive-archive/process'

/**
 * Manual / cron helper to drain drive_exports without waiting for the full tick.
 * Auth: x-cron-secret (same as /api/cron/tick).
 */
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({})) as { limit?: number }
  const limit = Math.min(20, Math.max(1, Number(body.limit) || 5))
  const result = await processDriveExports({ limit })
  return NextResponse.json(result)
}
