import { NextRequest, NextResponse } from 'next/server'
import { rows, one, query } from '@/lib/db'

export interface LoraRow {
  id: string
  name: string
  trigger_word: string | null
  lora_url: string | null
  status: 'training' | 'ready' | 'failed'
  steps: number
  learning_rate: number
  lora_rank: number
  wavespeed_request_id: string | null
  error_message: string | null
  created_at: string
}

export async function GET() {
  try {
    const loras = await rows<LoraRow>(
      'SELECT * FROM loras ORDER BY created_at DESC'
    )
    return NextResponse.json({ loras })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { name, triggerWord, steps, learningRate, loraRank, wavespeedRequestId } = await req.json()
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })

    const row = await one<{ id: string }>(
      `INSERT INTO loras (name, trigger_word, steps, learning_rate, lora_rank, wavespeed_request_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [name, triggerWord ?? null, steps ?? 1000, learningRate ?? 0.0001, loraRank ?? 16, wavespeedRequestId ?? null]
    )
    return NextResponse.json({ id: row!.id })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { id, name, loraUrl, status, errorMessage } = await req.json()
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    await query(
      `UPDATE loras SET
        name = COALESCE($1, name),
        lora_url = COALESCE($2, lora_url),
        status = COALESCE($3, status),
        error_message = COALESCE($4, error_message)
       WHERE id = $5`,
      [name ?? null, loraUrl ?? null, status ?? null, errorMessage ?? null, id]
    )
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { id } = await req.json()
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    await query('DELETE FROM loras WHERE id = $1', [id])
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
