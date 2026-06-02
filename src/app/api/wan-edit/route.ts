import { NextRequest, NextResponse } from 'next/server'

const API_KEY = process.env.WAVESPEED_API_KEY!
const UPLOAD_URL = 'https://api.wavespeed.ai/api/v3/media/upload/binary'
const EDIT_URL = 'https://api.wavespeed.ai/api/v3/alibaba/wan-2.7/image-edit'
const RESULT_BASE = 'https://api.wavespeed.ai/api/v3/predictions'

async function uploadToWavespeed(file: File): Promise<string> {
  const fd = new FormData()
  fd.append('file', file)

  const res = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}` },
    body: fd,
  })
  const data = await res.json()
  if (data.code && data.code !== 200) {
    throw new Error(data.message ?? 'Upload failed')
  }
  const url = data?.data?.download_url
  if (!url) throw new Error('Upload response missing download_url')
  return url as string
}

async function pollResult(requestId: string, signal?: AbortSignal): Promise<string[]> {
  const maxAttempts = 60
  const interval = 3000

  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) throw new Error('Request aborted')
    await new Promise(r => setTimeout(r, interval))
    const res = await fetch(`${RESULT_BASE}/${requestId}/result`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal,
    })
    const data = await res.json()
    const status = data?.data?.status ?? data?.status
    if (status === 'completed') {
      const outputs = data?.data?.outputs ?? data?.outputs
      if (!outputs?.length) throw new Error('No outputs returned')
      return outputs as string[]
    }
    if (status === 'failed') {
      throw new Error('Edit failed: ' + JSON.stringify(data?.data?.error ?? data?.error))
    }
  }
  throw new Error('Timeout while polling Wan 2.7 result')
}

export async function POST(req: NextRequest) {
  const abort = AbortSignal.timeout(300_000)
  try {
    if (!API_KEY) return NextResponse.json({ error: 'WAVESPEED_API_KEY is not configured' }, { status: 500 })

    const SIZE_MAP: Record<string, string> = {
      '1:1': '1024*1024', '4:3': '1152*864', '3:4': '864*1152',
      '16:9': '1344*756', '9:16': '756*1344', '2:3': '768*1152', '3:2': '1152*768',
    }
    const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])

    const form = await req.formData()
    const prompt = (form.get('prompt') as string | null)?.trim()
    const sizeRaw = (form.get('size') as string | null) ?? undefined
    const size = sizeRaw
      ? (SIZE_MAP[sizeRaw] ?? (sizeRaw.includes('*') ? sizeRaw : undefined))
      : undefined
    const seedRaw = form.get('seed') as string | null
    const saveHistory = form.get('saveHistory') === 'true'
    const historyPrompt = (form.get('historyPrompt') as string | null) ?? prompt ?? ''
    const historyUserId = (form.get('historyUserId') as string | null) ?? null

    // Support both single 'file' and multiple 'files[]'
    const singleFile = form.get('file') as File | null
    const multiFiles = form.getAll('files[]') as File[]
    const allFiles = multiFiles.length > 0 ? multiFiles : singleFile ? [singleFile] : []

    if (!allFiles.length) return NextResponse.json({ error: 'Missing file' }, { status: 400 })
    for (const f of allFiles) {
      if (!ALLOWED_MIME.has(f.type)) return NextResponse.json({ error: 'File must be a JPEG, PNG, or WebP image' }, { status: 400 })
    }
    if (!prompt) return NextResponse.json({ error: 'Missing prompt' }, { status: 400 })

    // Upload all reference images in parallel
    const imageUrls = await Promise.all(allFiles.map(f => uploadToWavespeed(f)))

    const body: Record<string, unknown> = {
      images: imageUrls,
      prompt,
    }
    if (size) body.size = size
    if (seedRaw) {
      const n = Number(seedRaw)
      if (Number.isFinite(n)) body.seed = n
    }

    const initRes = await fetch(EDIT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const initData = await initRes.json()
    if (initData.code && initData.code !== 200) {
      throw new Error(initData.message ?? JSON.stringify(initData))
    }
    const requestId = initData?.data?.id ?? initData?.id
    if (!requestId) throw new Error('No request ID returned')

    const urls = await pollResult(requestId, abort)

    // Save to history DB if requested (e.g. from Poses & Variations)
    if (saveHistory && urls.length) {
      fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'wan_edit',
          prompt: historyPrompt,
          dimension: size ?? '9:16',
          batch: 1,
          wavespeedUrls: urls,
          userId: historyUserId,
        }),
      }).catch(e => console.error('[wan-edit] history save failed:', e))
    }

    return NextResponse.json({ urls, inputUrl: imageUrls[0] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
