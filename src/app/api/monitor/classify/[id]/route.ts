import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { classifyDiscoveryItem } from '@/lib/monitor/process-item'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const { id } = await params
  // reset also clears the finished render, so the new spec can actually reach
  // Seedance — without it, re-analyzing a done item changes nothing visible.
  const body = await req.json().catch(() => ({})) as { reset?: boolean }
  try {
    const result = await classifyDiscoveryItem(id, auth.id, { reset: body.reset === true })
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Classify failed' },
      { status: 500 },
    )
  }
}
