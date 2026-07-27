import { NextRequest, NextResponse } from 'next/server'
import { rows, one, query } from '@/lib/db'
import { requireAdmin, requireUser } from '@/lib/session'

/** Accept string[] or newline/comma-separated string; keep http(s) URLs only. */
function normalizeUrlList(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === 'string'
      ? raw.split(/[\n,]+/)
      : []
  return list
    .map(s => s.trim())
    .filter(s => /^https?:\/\//i.test(s))
    .slice(0, 9)
}

export async function GET(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

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
        COALESCE(trigger_word, '') AS "triggerWord",
        COALESCE(face_ref_urls, '{}') AS "faceRefUrls",
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

    const faceRefUrls = normalizeUrlList(body.faceRefUrls)
    const char = await one(
      `INSERT INTO characters
       (name, lora_url, lora_scale, base_prompt_style, story, start_date, default_mode, face_ref_urls)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING
        id,
        name,
        lora_url AS "loraUrl",
        COALESCE(lora_scale, 0.8)::float AS "loraScale",
        COALESCE(base_prompt_style, '') AS "basePromptStyle",
        COALESCE(story, '') AS story,
        COALESCE(start_date, '') AS "startDate",
        COALESCE(default_mode, 'SFW') AS "defaultMode",
        COALESCE(face_ref_urls, '{}') AS "faceRefUrls"`,
      [
        body.name.trim(),
        body.loraUrl ?? '',
        body.loraScale ?? 0.8,
        body.basePromptStyle ?? '',
        body.story ?? '',
        body.startDate ?? '',
        body.defaultMode ?? 'SFW',
        faceRefUrls,
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

    const faceRefUrls =
      body.faceRefUrls !== undefined ? normalizeUrlList(body.faceRefUrls) : null

    await query(
      `UPDATE characters SET
        name = COALESCE($1, name),
        lora_url = COALESCE($2, lora_url),
        lora_scale = COALESCE($3, lora_scale),
        base_prompt_style = COALESCE($4, base_prompt_style),
        story = COALESCE($5, story),
        start_date = COALESCE($6, start_date),
        default_mode = COALESCE($7, default_mode),
        face_ref_urls = COALESCE($8, face_ref_urls)
       WHERE id=$9`,
      [
        body.name ?? null,
        body.loraUrl ?? null,
        body.loraScale ?? null,
        body.basePromptStyle ?? null,
        body.story ?? null,
        body.startDate ?? null,
        body.defaultMode ?? null,
        faceRefUrls,
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
