import { NextRequest, NextResponse } from 'next/server'
import { rows, query, one } from '@/lib/db'

interface PromptRow {
  id: string
  character_id: string
  prompt: string
  label: string | null
  tags: string[]
  used_count: number
  created_at: string
}

export async function GET(req: NextRequest) {
  const characterId = req.nextUrl.searchParams.get('characterId')
  if (!characterId) return NextResponse.json({ error: 'Missing characterId' }, { status: 400 })

  const data = await rows<PromptRow>(
    'SELECT * FROM prompt_library WHERE character_id = $1 ORDER BY used_count DESC, created_at DESC',
    [characterId]
  )
  return NextResponse.json({ prompts: data })
}

export async function POST(req: NextRequest) {
  const { characterId, prompt, label, tags } = await req.json()
  if (!characterId || !prompt?.trim()) {
    return NextResponse.json({ error: 'Missing characterId or prompt' }, { status: 400 })
  }
  const row = await one<PromptRow>(
    `INSERT INTO prompt_library (character_id, prompt, label, tags)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [characterId, prompt.trim(), label?.trim() || null, tags ?? []]
  )
  return NextResponse.json({ prompt: row })
}

export async function PATCH(req: NextRequest) {
  const { id, prompt, label, tags } = await req.json()
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })
  await query(
    'UPDATE prompt_library SET prompt = COALESCE($2, prompt), label = COALESCE($3, label), tags = COALESCE($4, tags) WHERE id = $1',
    [id, prompt ?? null, label ?? null, tags ?? null]
  )
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const { id } = await req.json()
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })
  await query('DELETE FROM prompt_library WHERE id = $1', [id])
  return NextResponse.json({ ok: true })
}
