import { NextRequest, NextResponse } from 'next/server'
import { rows, query } from '@/lib/db'

export async function GET(req: NextRequest) {
  try {
    const chatterId = req.nextUrl.searchParams.get('chatterId')
    const creatorUuid = req.nextUrl.searchParams.get('creatorUuid')

    const conditions: string[] = []
    const params: unknown[] = []
    let p = 1

    if (chatterId) { conditions.push(`chatter_id=$${p++}`); params.push(chatterId) }
    if (creatorUuid) { conditions.push(`creator_uuid=$${p++}`); params.push(creatorUuid) }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const data = await rows(
      `SELECT fan_uuid AS "fanUuid", creator_uuid AS "creatorUuid",
              chatter_id AS "chatterId", assigned_at AS "assignedAt", notes
       FROM fan_assignments
       ${where}
       ORDER BY assigned_at DESC`,
      params
    )

    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    if (!body.fanUuid || !body.creatorUuid || !body.chatterId) {
      return NextResponse.json({ error: 'fanUuid, creatorUuid, chatterId required' }, { status: 400 })
    }

    await query(
      `INSERT INTO fan_assignments (fan_uuid, creator_uuid, chatter_id, notes)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (fan_uuid, creator_uuid) DO UPDATE SET
        chatter_id=EXCLUDED.chatter_id,
        notes=EXCLUDED.notes,
        assigned_at=now()`,
      [body.fanUuid, body.creatorUuid, body.chatterId, body.notes ?? '']
    )

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { fanUuid, creatorUuid } = await req.json()
    if (!fanUuid || !creatorUuid) {
      return NextResponse.json({ error: 'fanUuid, creatorUuid required' }, { status: 400 })
    }

    await query(
      `DELETE FROM fan_assignments WHERE fan_uuid=$1 AND creator_uuid=$2`,
      [fanUuid, creatorUuid]
    )

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}