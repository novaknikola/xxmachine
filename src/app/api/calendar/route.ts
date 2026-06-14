import { NextRequest, NextResponse } from 'next/server'
import { rows, one, query } from '@/lib/db'

export async function GET(req: NextRequest) {
  try {
    const characterId = req.nextUrl.searchParams.get('characterId')
    const params: unknown[] = []
    const where = characterId ? 'WHERE character_id=$1' : ''
    if (characterId) params.push(characterId)

    const days = await rows(
      `SELECT id, character_id AS "characterId", date, topic, keywords,
              description, fanvue_description AS "fanvueDescription",
              notes, prompts, status, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM calendar_days
       ${where}
       ORDER BY date ASC`,
      params
    )

    return NextResponse.json(days)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    if (!body.id || !body.characterId || !body.date) {
      return NextResponse.json({ error: 'id, characterId, date required' }, { status: 400 })
    }

    const day = await one(
      `INSERT INTO calendar_days
       (id, character_id, date, topic, keywords, description, fanvue_description, notes, prompts, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (character_id, date) DO UPDATE SET
        topic=EXCLUDED.topic,
        keywords=EXCLUDED.keywords,
        description=EXCLUDED.description,
        fanvue_description=EXCLUDED.fanvue_description,
        notes=EXCLUDED.notes,
        prompts=EXCLUDED.prompts,
        status=EXCLUDED.status,
        updated_at=now()
       RETURNING id`,
      [
        body.id,
        body.characterId,
        body.date,
        body.topic ?? '',
        body.keywords ?? '',
        body.description ?? '',
        body.fanvueDescription ?? '',
        body.notes ?? '',
        body.prompts ?? {},
        body.status ?? 'empty',
      ]
    )

    return NextResponse.json({ ok: true, id: day?.id })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { id } = await req.json()
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    await query(`DELETE FROM calendar_days WHERE id=$1`, [id])
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}