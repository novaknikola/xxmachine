import { NextRequest, NextResponse } from 'next/server'
import { one, query } from '@/lib/db'
import type { ViralReel } from '@/lib/types'

const WAVESPEED_KEY = process.env.WAVESPEED_API_KEY!
// v3 API — motion control models use a different base than z-image (v2)
const API_BASE = 'https://api.wavespeed.ai/api/v3'
const MODEL = 'kwaivgi/kling-v2.6-std/motion-control'

async function pollResult(requestId: string, signal: AbortSignal): Promise<string> {
  for (let i = 0; i < 60; i++) {
    if (signal.aborted) throw new Error('Aborted')
    await new Promise(r => setTimeout(r, 5000))
    const res = await fetch(`${API_BASE}/predictions/${requestId}/result`, {
      headers: { Authorization: `Bearer ${WAVESPEED_KEY}` },
      signal,
    })
    const data = await res.json()
    const status = data?.data?.status ?? data?.status
    if (status === 'completed') {
      const outputs = data?.data?.outputs ?? data?.outputs
      if (!outputs?.length) throw new Error('No video output')
      return outputs[0] as string
    }
    if (status === 'failed') throw new Error('Motion control failed: ' + JSON.stringify(data?.data?.error ?? data?.error))
  }
  throw new Error('Timeout')
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const reel = await one<ViralReel>('SELECT * FROM viral_reels WHERE id = $1', [id])
  if (!reel) return NextResponse.json({ error: 'Reel not found' }, { status: 404 })
  if (!reel.generated_image_url) return NextResponse.json({ error: 'No generated image — run generate-image first' }, { status: 400 })
  if (!reel.video_url) return NextResponse.json({ error: 'No source video URL for motion reference' }, { status: 400 })

  try {
    const abort = AbortSignal.timeout(310_000)
    const initRes = await fetch(`${API_BASE}/${MODEL}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WAVESPEED_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        image: reel.generated_image_url,
        video: reel.video_url,
        character_orientation: 'image',
      }),
    })
    const initData = await initRes.json()
    if (initData.code && initData.code !== 200) {
      throw new Error(initData.message ?? JSON.stringify(initData))
    }
    const requestId = initData?.data?.id ?? initData?.id
    if (!requestId) throw new Error('No request ID from Wavespeed')

    const videoUrl = await pollResult(requestId, abort)

    await query(
      'UPDATE viral_reels SET kling_video_url = $1, status = $2 WHERE id = $3',
      [videoUrl, 'video_created', id]
    )

    return NextResponse.json({ ok: true, video_url: videoUrl })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}
