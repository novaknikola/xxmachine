import { NextRequest, NextResponse } from 'next/server'
import { one } from '@/lib/db'
import JSZip from 'jszip'

export const maxDuration = 30

const API_KEY = process.env.WAVESPEED_API_KEY
const UPLOAD_URL = 'https://api.wavespeed.ai/api/v3/media/upload/binary'
const TRAINER_URL = 'https://api.wavespeed.ai/api/v3/wavespeed-ai/z-image-lora-trainer'

async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`Failed to download image: ${res.status} ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

async function uploadZipToWavespeed(zipBuffer: Buffer): Promise<string> {
  const res = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'X-Entity-Type': 'application/zip',
      'X-Entity-Name': `dataset_${Date.now()}.zip`,
      'X-Entity-Length': String(zipBuffer.length),
      'Offset': '0',
      'Content-Type': 'application/octet-stream',
    },
    body: new Uint8Array(zipBuffer),
  })
  const data = await res.json()
  if (!res.ok || !data.download_url) {
    throw new Error(`ZIP upload failed: ${JSON.stringify(data)}`)
  }
  return data.download_url as string
}

export async function POST(req: NextRequest) {
  if (!API_KEY) return NextResponse.json({ error: 'WAVESPEED_API_KEY not configured' }, { status: 500 })

  try {
    const { imageUrls, name, triggerWord, steps, learningRate, loraRank } = await req.json() as {
      imageUrls: string[]
      name: string
      triggerWord: string
      steps: number
      learningRate: number
      loraRank: number
    }

    if (!imageUrls?.length) return NextResponse.json({ error: 'imageUrls required' }, { status: 400 })
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })
    if (!triggerWord) return NextResponse.json({ error: 'triggerWord required' }, { status: 400 })

    // 1. Download all dataset images and pack into ZIP
    const zip = new JSZip()
    await Promise.all(
      imageUrls.map(async (url, i) => {
        const buf = await downloadImage(url)
        const ext = url.split('?')[0].split('.').pop() ?? 'jpg'
        zip.file(`image_${String(i + 1).padStart(3, '0')}.${ext}`, buf)
      })
    )
    const zipBuffer = Buffer.from(
      await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
    )

    // 2. Upload ZIP to Wavespeed media
    const zipUrl = await uploadZipToWavespeed(zipBuffer)

    // 3. Start LoRA training
    const trainRes = await fetch(TRAINER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: zipUrl,
        trigger_word: triggerWord,
        steps: steps ?? 1000,
        learning_rate: learningRate ?? 0.0001,
        lora_rank: loraRank ?? 16,
      }),
    })
    const trainData = await trainRes.json()
    if (!trainRes.ok || (trainData.code && trainData.code !== 200)) {
      throw new Error(trainData.message ?? JSON.stringify(trainData))
    }

    const requestId = trainData?.data?.id ?? trainData?.id
    if (!requestId) throw new Error('No request ID from Wavespeed trainer')

    // 4. Save to DB as 'training'
    const row = await one<{ id: string }>(
      `INSERT INTO loras (name, trigger_word, steps, learning_rate, lora_rank, wavespeed_request_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [name, triggerWord, steps ?? 1000, learningRate ?? 0.0001, loraRank ?? 16, requestId]
    )

    return NextResponse.json({ ok: true, loraId: row!.id, requestId })
  } catch (err) {
    console.error('[loras/train]', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}
