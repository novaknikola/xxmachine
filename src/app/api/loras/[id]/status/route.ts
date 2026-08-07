import { NextRequest, NextResponse } from 'next/server'
import { one } from '@/lib/db'
import type { LoraRow } from '../../route'
import { requireUser } from '@/lib/session'
import { getUserApiKey } from '@/lib/user-config'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const { id } = await params

  const lora = await one<LoraRow & { user_id: string | null; is_public: boolean }>(
    'SELECT * FROM loras WHERE id = $1', [id],
  )
  if (!lora) return NextResponse.json({ error: 'LoRA not found' }, { status: 404 })
  if (auth.role !== 'admin' && lora.user_id !== auth.id && !lora.is_public) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Already resolved
  if (lora.status === 'ready' || lora.status === 'failed') {
    return NextResponse.json({ lora })
  }

  const apiKey = await getUserApiKey(auth.id, 'wavespeed_api_key').catch(() => '')
  if (!lora.wavespeed_request_id || !apiKey) {
    return NextResponse.json({ lora })
  }

  // Poll Wavespeed for current status
  try {
    const res = await fetch(
      `https://api.wavespeed.ai/api/v3/predictions/${lora.wavespeed_request_id}/result`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
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
