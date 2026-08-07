import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { persistGeneration } from '@/lib/persist-generation'
import { getUserApiKey } from '@/lib/user-config'

const MODEL = 'wavespeed-ai/z-image/turbo-lora'
const API_BASE = 'https://api.wavespeed.ai/api/v2'

const DIMENSION_MAP: Record<string, string> = {
  '1:1': '1024*1024',
  '4:3': '1152*864',
  '3:4': '864*1152',
  '16:9': '1344*756',
  '9:16': '756*1344',
  '2:3': '768*1152',
  '3:2': '1152*768',
}

function convertToDirectLink(url: string, hfToken: string): string {
  if (!url) return url
  if (url.includes('huggingface.co')) {
    return url.replace('/blob/', '/resolve/').split('?')[0] + '?token=' + hfToken
  }
  if (url.includes('drive.google.com')) {
    const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/)
    if (!match) return url
    return `https://drive.google.com/uc?export=download&confirm=t&id=${match[1]}`
  }
  return url
}

async function pollResult(requestId: string, apiKey: string, signal?: AbortSignal): Promise<string[]> {
  const maxAttempts = 40
  const interval = 3000

  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) throw new Error('Request aborted')
    await new Promise(r => setTimeout(r, interval))
    const res = await fetch(`${API_BASE}/predictions/${requestId}/result`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    })
    const data = await res.json()
    const status = data?.data?.status ?? data?.status
    if (status === 'completed') {
      const outputs = data?.data?.outputs ?? data?.outputs
      if (!outputs?.length) throw new Error('No outputs')
      return outputs as string[]
    }
    if (status === 'failed') {
      throw new Error('Generation failed: ' + JSON.stringify(data?.data?.error ?? data?.error))
    }
  }
  throw new Error('Timeout after polling')
}

export async function POST(req: NextRequest) {
  const abort = AbortSignal.timeout(130_000)
  try {
    const auth = await requireUser(req)
    if (auth instanceof NextResponse) return auth

    const apiKey = await getUserApiKey(auth.id, 'wavespeed_api_key').catch(() => '')
    if (!apiKey) return NextResponse.json({ error: 'WAVESPEED_API_KEY is not configured' }, { status: 500 })
    const hfToken = await getUserApiKey(auth.id, 'hf_token').catch(() => '')

    const {
      prompt, dimension, batch, loraUrl, loraScale, characterId, characterName, contentFormat,
      seriesId, seriesIndex, seriesTotal, seriesLabel, seriesFolder,
    } = await req.json()

    if (!prompt) return NextResponse.json({ error: 'Missing prompt' }, { status: 400 })

    const size = DIMENSION_MAP[dimension] ?? '756*1344'
    const allUrls: string[] = []

    const loraPath = loraUrl ? convertToDirectLink(loraUrl, hfToken) : null
    const payload: Record<string, unknown> = {
      prompt,
      size,
      enable_safety_checker: false,
    }
    if (loraPath) payload.loras = [{ path: loraPath, scale: loraScale ?? 0.8 }]

    for (let i = 0; i < (batch ?? 1); i++) {
      const initRes = await fetch(`${API_BASE}/${MODEL}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
      const initData = await initRes.json()
      if (initData.code && initData.code !== 200) {
        throw new Error(initData.message ?? JSON.stringify(initData))
      }
      const requestId = initData?.data?.id ?? initData?.id
      if (!requestId) throw new Error('No request ID returned')
      const urls = await pollResult(requestId, apiKey, abort)
      allUrls.push(...urls)
    }

    // Persist to History (direct DB + storage — no self-HTTP to BASE_URL).
    if (allUrls.length) {
      try {
        await persistGeneration({
          kind: 'text2img',
          characterId: characterId ?? null,
          characterName: characterName ?? null,
          prompt,
          dimension: dimension ?? null,
          batch: batch ?? 1,
          wavespeedUrls: allUrls,
          userId: auth.id,
          contentFormat: contentFormat ?? null,
          seriesId: seriesId ?? null,
          seriesIndex: seriesIndex ?? null,
          seriesTotal: seriesTotal ?? null,
          seriesLabel: seriesLabel ?? null,
          seriesFolder: seriesFolder ?? null,
        })
      } catch (e) {
        console.error('[generate] history persist failed:', e)
      }
    }

    return NextResponse.json({ urls: allUrls })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
