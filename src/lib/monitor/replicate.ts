const WAVESPEED_KEY = process.env.WAVESPEED_API_KEY!
const IMAGE_MODEL = 'wavespeed-ai/z-image/turbo-lora'
const VIDEO_MODEL = 'kwaivgi/kling-v2.6-std/motion-control'
const API_V2 = 'https://api.wavespeed.ai/api/v2'
const API_V3 = 'https://api.wavespeed.ai/api/v3'

async function pollV2(requestId: string, signal: AbortSignal): Promise<string> {
  for (let i = 0; i < 40; i++) {
    if (signal.aborted) throw new Error('Aborted')
    await new Promise(r => setTimeout(r, 3000))
    const res = await fetch(`${API_V2}/predictions/${requestId}/result`, {
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
    if (status === 'failed') throw new Error('Wavespeed failed: ' + JSON.stringify(data?.data?.error))
  }
  throw new Error('Wavespeed image timeout')
}

async function pollV3(requestId: string, signal: AbortSignal): Promise<string> {
  for (let i = 0; i < 60; i++) {
    if (signal.aborted) throw new Error('Aborted')
    await new Promise(r => setTimeout(r, 5000))
    const res = await fetch(`${API_V3}/predictions/${requestId}/result`, {
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
    if (status === 'failed') throw new Error('Kling failed: ' + JSON.stringify(data?.data?.error))
  }
  throw new Error('Kling video timeout')
}

export async function generateReplicaImage(opts: {
  scenePrompt: string
  loraUrl?: string | null
  loraScale?: number
  triggerWord?: string | null
  basePromptStyle?: string | null
}): Promise<string> {
  if (!WAVESPEED_KEY) throw new Error('WAVESPEED_API_KEY not configured')

  const parts = [
    opts.triggerWord?.trim(),
    opts.basePromptStyle?.trim(),
    opts.scenePrompt.trim(),
  ].filter(Boolean)

  const payload: Record<string, unknown> = {
    prompt: parts.join(', '),
    size: '756*1344',
    enable_safety_checker: false,
  }
  if (opts.loraUrl) {
    payload.loras = [{ path: opts.loraUrl, scale: opts.loraScale ?? 0.8 }]
  }

  const initRes = await fetch(`${API_V2}/${IMAGE_MODEL}`, {
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

  return pollV2(requestId, AbortSignal.timeout(130_000))
}

export async function generateReplicaVideo(imageUrl: string, sourceVideoUrl: string): Promise<string> {
  if (!WAVESPEED_KEY) throw new Error('WAVESPEED_API_KEY not configured')

  const initRes = await fetch(`${API_V3}/${VIDEO_MODEL}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WAVESPEED_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      image: imageUrl,
      video: sourceVideoUrl,
      character_orientation: 'image',
    }),
  })
  const initData = await initRes.json()
  if (initData.code && initData.code !== 200) {
    throw new Error(initData.message ?? JSON.stringify(initData))
  }
  const requestId = initData?.data?.id ?? initData?.id
  if (!requestId) throw new Error('No request ID from Kling')

  return pollV3(requestId, AbortSignal.timeout(310_000))
}
