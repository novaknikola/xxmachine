import { NextRequest, NextResponse } from 'next/server'
import { runViralMonitorDaily } from '@/lib/viral-monitor/run'

/**
 * Manual / standalone trigger for the isolated viral monitor, independent of
 * the full cron/tick sweep. Auth: x-cron-secret (same as /api/cron/tick).
 */
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await runViralMonitorDaily()
  return NextResponse.json(result)
}
