import { NextRequest, NextResponse } from 'next/server'
import { rows, query } from '@/lib/db'
import { uploadImagesFromUrls } from '@/lib/supabase-storage'

interface SaveBody {
  kind: 'text2img' | 'wan_edit'
  characterId?: string
  characterName?: string
  prompt: string
  dimension?: string
  batch?: number
  wavespeedUrls: string[]
  userId?: string
}

// POST — save a generation, upload images to Storage, persist to DB
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as SaveBody

    if (!body.wavespeedUrls?.length) {
      return NextResponse.json({ error: 'No URLs provided' }, { status: 400 })
    }
    if (!body.prompt) {
      return NextResponse.json({ error: 'Missing prompt' }, { status: 400 })
    }

    // Generate a generation ID first so we can use it as the storage path
    const genId = crypto.randomUUID()
    const basePath = `${body.userId ?? 'anon'}/${genId}`

    // Upload all images to Supabase Storage (permanent)
    const permanentUrls = await uploadImagesFromUrls(body.wavespeedUrls, basePath)

    // Save to DB
    await query(
      `INSERT INTO generations
        (id, kind, character_id, character_name, prompt, dimension, batch, image_urls, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        genId,
        body.kind ?? 'text2img',
        body.characterId ?? null,
        body.characterName ?? null,
        body.prompt,
        body.dimension ?? null,
        body.batch ?? 1,
        permanentUrls,
        body.userId ?? null,
      ]
    )

    return NextResponse.json({ ok: true, id: genId, imageUrls: permanentUrls })
  } catch (err) {
    console.error('[generations] save error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}

// GET — list generations, newest first
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const userId = searchParams.get('userId')
    const kind = searchParams.get('kind')
    const limit = Math.min(Number(searchParams.get('limit') ?? 200), 500)
    const offset = Number(searchParams.get('offset') ?? 0)

    const conditions: string[] = []
    const params: unknown[] = []
    let p = 1

    if (userId) { conditions.push(`user_id = $${p++}`); params.push(userId) }
    if (kind) { conditions.push(`kind = $${p++}`); params.push(kind) }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const data = await rows<{
      id: string
      kind: string
      character_id: string | null
      character_name: string | null
      prompt: string
      dimension: string | null
      batch: number
      image_urls: string[]
      user_id: string | null
      created_at: string
    }>(
      `SELECT * FROM generations ${where} ORDER BY created_at DESC LIMIT $${p++} OFFSET $${p++}`,
      [...params, limit, offset]
    )

    const total = await rows<{ count: string }>(
      `SELECT COUNT(*) as count FROM generations ${where}`,
      params
    )

    return NextResponse.json({ generations: data, total: Number(total[0]?.count ?? 0) })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}

// DELETE — delete a generation and its images
export async function DELETE(req: NextRequest) {
  try {
    const { id } = await req.json()
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })
    await query('DELETE FROM generations WHERE id = $1', [id])
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}
