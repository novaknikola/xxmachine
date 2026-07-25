import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/session'
import { fetchAllStats } from '@/lib/stats'

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (auth instanceof NextResponse) return auth

  try {
    const result = await fetchAllStats()
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.error('[analytics/refresh]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
