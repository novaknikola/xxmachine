import { NextRequest, NextResponse } from 'next/server'
import { rows, one } from '@/lib/db'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const messages = await rows(
      `SELECT
        id,
        fan_id      AS "fanId",
        text,
        is_creator  AS "isCreator",
        chatter_id  AS "chatterId",
        created_at  AS "createdAt"
       FROM fan_messages
       WHERE fan_id = $1
       ORDER BY created_at ASC`,
      [id],
    )
    return NextResponse.json(messages)
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { text, isCreator, chatterId } = await req.json()

    if (!text) return NextResponse.json({ error: 'text is required' }, { status: 400 })

    const msg = await one(
      `INSERT INTO fan_messages (fan_id, text, is_creator, chatter_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, fan_id AS "fanId", text, is_creator AS "isCreator", chatter_id AS "chatterId", created_at AS "createdAt"`,
      [id, text, isCreator ?? false, chatterId ?? null],
    )
    return NextResponse.json(msg, { status: 201 })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
