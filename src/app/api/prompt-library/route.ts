import { NextRequest, NextResponse } from 'next/server'
import { rows, query, one } from '@/lib/db'
import { GLOBAL_CHARACTER_ID } from '@/lib/prompt-library-tags'

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
  const tag = req.nextUrl.searchParams.get('tag')?.trim()
  const search = req.nextUrl.searchParams.get('search')?.trim().toLowerCase()
  const limit = Math.min(Number(req.nextUrl.searchParams.get('limit') ?? 200), 500)

  const conditions: string[] = []
  const params: unknown[] = []
  let p = 1

  if (characterId) {
    conditions.push(`character_id = $${p++}`)
    params.push(characterId)
  }
  if (tag) {
    conditions.push(`$${p++} = ANY(tags)`)
    params.push(tag)
  }
  if (search) {
    conditions.push(`(lower(prompt) LIKE $${p} OR lower(coalesce(label, '')) LIKE $${p})`)
    params.push(`%${search}%`)
    p++
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const data = await rows<PromptRow>(
    `SELECT * FROM prompt_library ${where}
     ORDER BY created_at DESC
     LIMIT $${p}`,
    [...params, limit],
  )
  return NextResponse.json({ prompts: data })
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const {
    characterId = GLOBAL_CHARACTER_ID,
    prompt,
    prompts,
    label,
    tags,
    skipDuplicates = true,
  } = body as {
    characterId?: string
    prompt?: string
    prompts?: string[]
    label?: string
    tags?: string[]
    skipDuplicates?: boolean
  }

  if (Array.isArray(prompts) && prompts.length) {
    const tagList = tags ?? []
    let saved = 0
    let skipped = 0

    for (const raw of prompts) {
      const text = String(raw).trim()
      if (!text) continue

      if (skipDuplicates && tagList.length) {
        const dup = await one<{ id: string }>(
          `SELECT id FROM prompt_library
           WHERE character_id = $1 AND lower(prompt) = lower($2) AND tags @> $3::text[]
           LIMIT 1`,
          [characterId, text, tagList],
        )
        if (dup) { skipped++; continue }
      }

      await query(
        `INSERT INTO prompt_library (character_id, prompt, label, tags)
         VALUES ($1, $2, $3, $4)`,
        [characterId, text, label?.trim() || null, tagList],
      )
      saved++
    }

    return NextResponse.json({ ok: true, saved, skipped })
  }

  if (!prompt?.trim()) {
    return NextResponse.json({ error: 'Missing prompt or prompts array' }, { status: 400 })
  }

  const row = await one<PromptRow>(
    `INSERT INTO prompt_library (character_id, prompt, label, tags)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [characterId, prompt.trim(), label?.trim() || null, tags ?? []],
  )
  return NextResponse.json({ prompt: row })
}

export async function PATCH(req: NextRequest) {
  const { id, prompt, label, tags } = await req.json()
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })
  await query(
    'UPDATE prompt_library SET prompt = COALESCE($2, prompt), label = COALESCE($3, label), tags = COALESCE($4, tags) WHERE id = $1',
    [id, prompt ?? null, label ?? null, tags ?? null],
  )
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const { id } = await req.json()
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })
  await query('DELETE FROM prompt_library WHERE id = $1', [id])
  return NextResponse.json({ ok: true })
}
