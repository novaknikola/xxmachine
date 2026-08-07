import { NextRequest, NextResponse } from 'next/server'
import { internalBaseUrl } from '@/lib/internal-url'
import { requireUser } from '@/lib/session'
import { getUserApiKey } from '@/lib/user-config'

const API_BASE = 'https://api.wavespeed.ai/api/v2'
const UPLOAD_URL = 'https://api.wavespeed.ai/api/v3/media/upload/binary'
const RESULT_BASE = 'https://api.wavespeed.ai/api/v3/predictions'
const MODEL = 'alibaba/wan-2.6/image-to-video'

async function uploadToWavespeed(file: File, apiKey: string): Promise<string> {
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: fd,
  })
  const data = await res.json()
  if (data.code && data.code !== 200) throw new Error(data.message ?? 'Upload failed')
  const url = data?.data?.download_url
  if (!url) throw new Error('Upload response missing download_url')
  return url as string
}

async function pollResult(requestId: string, apiKey: string, signal: AbortSignal): Promise<string> {
  for (let i = 0; i < 80; i++) {
    if (signal.aborted) throw new Error('Aborted')
    await new Promise(r => setTimeout(r, 4000))
    const res = await fetch(`${RESULT_BASE}/${requestId}/result`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    })
    const data = await res.json()
    const status = data?.data?.status ?? data?.status
    if (status === 'completed') {
      const outputs = data?.data?.outputs ?? data?.outputs
      if (!outputs?.length) throw new Error('No video output')
      return outputs[0] as string
    }
    if (status === 'failed') throw new Error('Video generation failed: ' + JSON.stringify(data?.data?.error ?? data?.error))
  }
  throw new Error('Timeout waiting for video')
}

export async function POST(req: NextRequest) {
  const abort = AbortSignal.timeout(360_000)
  try {
    const auth = await requireUser(req)
    if (auth instanceof NextResponse) return auth

    const apiKey = await getUserApiKey(auth.id, 'wavespeed_api_key').catch(() => '')
    if (!apiKey) return NextResponse.json({ error: 'WAVESPEED_API_KEY not configured' }, { status: 500 })

    const contentType = req.headers.get('content-type') ?? ''
    let imageUrl: string
    let prompt: string
    let duration: number = 5
    let resolution: string = '720p'

    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData()
      prompt = (form.get('prompt') as string | null)?.trim() ?? ''
      duration = Number(form.get('duration') ?? 5)
      resolution = (form.get('resolution') as string | null) ?? '720p'
      const file = form.get('file') as File | null
      const urlParam = (form.get('imageUrl') as string | null)?.trim()
      if (file) {
        imageUrl = await uploadToWavespeed(file, apiKey)
      } else if (urlParam) {
        // Proxy external URL through server to get a Wavespeed-uploadable blob
        const imgRes = await fetch(`${internalBaseUrl()}/api/proxy-image?url=${encodeURIComponent(urlParam)}`)
        if (!imgRes.ok) throw new Error('Could not fetch image URL')
        const blob = await imgRes.blob()
        imageUrl = await uploadToWavespeed(new File([blob], 'image.jpg', { type: blob.type || 'image/jpeg' }), apiKey)
      } else {
        return NextResponse.json({ error: 'No image provided' }, { status: 400 })
      }
    } else {
      const body = await req.json()
      prompt = body.prompt?.trim() ?? ''
      duration = body.duration ?? 5
      resolution = body.resolution ?? '720p'
      imageUrl = body.imageUrl?.trim() ?? ''
      if (!imageUrl) return NextResponse.json({ error: 'No imageUrl provided' }, { status: 400 })
    }

    if (!prompt) return NextResponse.json({ error: 'Missing prompt' }, { status: 400 })
    if (![5, 10, 15].includes(duration)) return NextResponse.json({ error: 'Duration must be 5, 10 or 15' }, { status: 400 })

    const initRes = await fetch(`${API_BASE}/${MODEL}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, image: imageUrl, duration, resolution }),
    })
    const initData = await initRes.json()
    if (initData.code && initData.code !== 200) throw new Error(initData.message ?? JSON.stringify(initData))
    const requestId = initData?.data?.id ?? initData?.id
    if (!requestId) throw new Error('No request ID from Wavespeed')

    const videoUrl = await pollResult(requestId, apiKey, abort)
    return NextResponse.json({ url: videoUrl })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}
