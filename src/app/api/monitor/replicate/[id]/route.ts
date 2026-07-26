import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { replicateDiscoveryItem } from '@/lib/monitor/process-item'
import { normalizeImageModel, normalizeVideoBackend } from '@/lib/monitor/replicate'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const { id } = await params
  const body = await req.json().catch(() => ({})) as {
    image_model?: string
    seedream_resolution?: '1k' | '2k'
    video_backend?: string
    stop_after_image?: boolean
  }

  try {
    const result = await replicateDiscoveryItem(id, auth.id, null, {
      imageModel: normalizeImageModel(body.image_model),
      seedreamResolution: body.seedream_resolution === '2k' ? '2k' : '1k',
      videoBackend: normalizeVideoBackend(body.video_backend),
      stopAfterImage: Boolean(body.stop_after_image),
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Replicate failed' },
      { status: 500 },
    )
  }
}
