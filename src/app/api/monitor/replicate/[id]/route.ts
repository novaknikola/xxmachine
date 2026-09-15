import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { generateCopyPasteKeyframes } from '@/lib/monitor/process-item'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const { id } = await params

  try {
    // Phase 1 only — generates the Seedream keyframe(s) and parks the item on
    // 'awaiting_keyframe_approval'. The Seedance call now requires a separate
    // approve step (Run tab or Telegram); see finishCopyPasteVideo.
    const result = await generateCopyPasteKeyframes(id, auth.id)
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Replicate failed' },
      { status: 500 },
    )
  }
}
