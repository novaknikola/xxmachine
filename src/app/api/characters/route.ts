import { NextRequest, NextResponse } from 'next/server'
import { rows, one, query } from '@/lib/db'
import { requireAdmin } from '@/lib/session'

export async function GET() {
  try {
    const chars = await rows(
      `SELECT
        id,
        name,
        lora_url AS "loraUrl",
        COALESCE(lora_scale, 0.8)::float AS "loraScale",
        COALESCE(base_prompt_style, '') AS "basePromptStyle",
        COALESCE(story, '') AS story,
        COALESCE(start_date, '') AS "startDate",
        COALESCE(default_mode, 'SFW') AS "defaultMode",
        instagram_user_id,
        instagram_username,
        instagram_access_token,
        instagram_token_expires_at,
        proxy_url,
        ig_username,
        google_drive_folder_id
       FROM characters
       ORDER BY name`
    )

    return NextResponse.json(chars)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req)
  if (admin instanceof NextResponse) return admin

  try {
    const body = await req.json()

    if (!body.name?.trim()) {
      return NextResponse.json({ error: 'name required' }, { status: 400 })
    }

    const char = await one(
      `INSERT INTO characters
       (name, lora_url, lora_scale, base_prompt_style, story, start_date, default_mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING
        id,
        name,
        lora_url AS "loraUrl",
        COALESCE(lora_scale, 0.8)::float AS "loraScale",
        COALESCE(base_prompt_style, '') AS "basePromptStyle",
        COALESCE(story, '') AS story,
        COALESCE(start_date, '') AS "startDate",
        COALESCE(default_mode, 'SFW') AS "defaultMode"`,
      [
        body.name.trim(),
        body.loraUrl ?? '',
        body.loraScale ?? 0.8,
        body.basePromptStyle ?? '',
        body.story ?? '',
        body.startDate ?? '',
        body.defaultMode ?? 'SFW',
      ]
    )

    return NextResponse.json({ ok: true, character: char })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin(req)
  if (admin instanceof NextResponse) return admin

  try {
    const body = await req.json()

    if (!body.id) {
      return NextResponse.json({ error: 'id required' }, { status: 400 })
    }

    await query(
      `UPDATE characters SET
        name = COALESCE($1, name),
        lora_url = COALESCE($2, lora_url),
        lora_scale = COALESCE($3, lora_scale),
        base_prompt_style = COALESCE($4, base_prompt_style),
        story = COALESCE($5, story),
        start_date = COALESCE($6, start_date),
        default_mode = COALESCE($7, default_mode)
       WHERE id=$8`,
      [
        body.name ?? null,
        body.loraUrl ?? null,
        body.loraScale ?? null,
        body.basePromptStyle ?? null,
        body.story ?? null,
        body.startDate ?? null,
        body.defaultMode ?? null,
        body.id,
      ]
    )

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin(req)
  if (admin instanceof NextResponse) return admin

  try {
    const { id } = await req.json()

    if (!id) {
      return NextResponse.json({ error: 'id required' }, { status: 400 })
    }

    await query(`DELETE FROM characters WHERE id=$1`, [id])

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
