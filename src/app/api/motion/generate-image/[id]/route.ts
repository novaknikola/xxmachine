import { NextRequest, NextResponse } from 'next/server'
import { one, query } from '@/lib/db'
import type { ViralReel } from '@/lib/types'

const WAVESPEED_KEY = process.env.WAVESPEED_API_KEY!
const MODEL = 'wavespeed-ai/z-image/turbo-lora'
const API_BASE = 'https://api.wavespeed.ai/api/v2'

async function pollResult(requestId: string, signal: AbortSignal): Promise<string> {
  for (let i = 0; i < 40; i++) {
    if (signal.aborted) throw new Error('Aborted')
    await new Promise(r => setTimeout(r, 3000))
    const res = await fetch(`${API_BASE}/predictions/${requestId}/result`, {
      headers: { Authorization: `Bearer ${WAVESPEED_KEY}` },
      signal,
    })
    const data = await res.json()
    const status = data?.data?.status ?? data?.status
    if (status === 'completed') {
      const outputs = data?.data?.outputs ?? data?.outputs
      if (!outputs?.length) throw new Error('No outputs from Wavespeed')
      return outputs[0] as string
    }
    if (status === 'failed') throw new Error('Wavespeed generation failed: ' + JSON.stringify(data?.data?.error))
  }
  throw new Error('Wavespeed timeout')
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!WAVESPEED_KEY) {
    return NextResponse.json({ error: 'WAVESPEED_API_KEY not configured' }, { status: 500 })
  }

  const { id } = await params
  const reel = await one<ViralReel>('SELECT * FROM viral_reels WHERE id = $1', [id])
  if (!reel) return NextResponse.json({ error: 'Reel not found' }, { status: 404 })
  if (!reel.gemini_prompt) return NextResponse.json({ error: 'No prompt — run analyze first' }, { status: 400 })

  // Accept loraUrl + loraScale from request body
  const body = await req.json().catch(() => ({}))
  const loraUrl: string | null = body.loraUrl ?? null
  const loraScale: number = body.loraScale ?? 0.8
  const triggerWord: string = body.triggerWord ?? ''

  // Prepend trigger word to prompt if provided
  const fullPrompt = triggerWord
    ? `${triggerWord}, ${reel.gemini_prompt}`
    : reel.gemini_prompt

  try {
    const abort = AbortSignal.timeout(130_000)

    const payload: Record<string, unknown> = {
      prompt: fullPrompt,
      size: '756*1344',
      enable_safety_checker: false,
    }
    if (loraUrl) {
      payload.loras = [{ path: loraUrl, scale: loraScale }]
    }

    const initRes = await fetch(`${API_BASE}/${MODEL}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WAVESPEED_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    const initData = await initRes.json()
    if (initData.code && initData.code !== 200) {
      throw new Error(initData.message ?? JSON.stringify(initData))
    }
    const requestId = initData?.data?.id ?? initData?.id
    if (!requestId) throw new Error('No request ID from Wavespeed')

    const imageUrl = await pollResult(requestId, abort)

    await query(
      'UPDATE viral_reels SET generated_image_url = $1, status = $2 WHERE id = $3',
      [imageUrl, 'image_generated', id]
    )

    return NextResponse.json({ ok: true, image_url: imageUrl })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}
