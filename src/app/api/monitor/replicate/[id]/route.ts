import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { replicateDiscoveryItem } from '@/lib/monitor/process-item'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const { id } = await params
  try {
    const result = await replicateDiscoveryItem(id, auth.id)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Replicate failed' },
      { status: 500 },
    )
  }
}
