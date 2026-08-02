import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { replicateCopyPasteItem } from '@/lib/monitor/process-item'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const { id } = await params

  try {
    const result = await replicateCopyPasteItem(id, auth.id)
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Replicate failed' },
      { status: 500 },
    )
  }
}
