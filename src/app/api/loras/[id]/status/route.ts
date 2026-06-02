import { NextRequest, NextResponse } from 'next/server'
import { one } from '@/lib/db'
import type { LoraRow } from '../../route'

const API_KEY = process.env.WAVESPEED_API_KEY

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const lora = await one<LoraRow>('SELECT * FROM loras WHERE id = $1', [id])
  if (!lora) return NextResponse.json({ error: 'LoRA not found' }, { status: 404 })

  // Already resolved
  if (lora.status === 'ready' || lora.status === 'failed') {
    return NextResponse.json({ lora })
  }

  if (!lora.wavespeed_request_id || !API_KEY) {
    return NextResponse.json({ lora })
  }

  // Poll Wavespeed for current status
  try {
    const res = await fetch(
      `https://api.wavespeed.ai/api/v3/predictions/${lora.wavespeed_request_id}/result`,
      { headers: { Authorization: `Bearer ${API_KEY}` } }
    )
    const data = await res.json()
    const status = data?.data?.status ?? data?.status

    if (status === 'completed') {
      const outputs = data?.data?.outputs ?? data?.outputs
      const loraUrl = Array.isArray(outputs) ? outputs[0] : null
      if (loraUrl) {
        await one(
          `UPDATE loras SET status = 'ready', lora_url = $1 WHERE id = $2`,
          [loraUrl, id]
        )
        return NextResponse.json({ lora: { ...lora, status: 'ready', lora_url: loraUrl } })
      }
    }

    if (status === 'failed') {
      const errorMsg = JSON.stringify(data?.data?.error ?? data?.error ?? 'Training failed')
      await one(
        `UPDATE loras SET status = 'failed', error_message = $1 WHERE id = $2`,
        [errorMsg, id]
      )
      return NextResponse.json({ lora: { ...lora, status: 'failed', error_message: errorMsg } })
    }

    // Still training
    return NextResponse.json({ lora: { ...lora, wavespeed_status: status } })
  } catch {
    return NextResponse.json({ lora })
  }
}
