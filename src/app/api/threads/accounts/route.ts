import { NextRequest, NextResponse } from 'next/server'
import { rows, one } from '@/lib/db'

export async function GET() {
  try {
    const accounts = await rows(
      `SELECT id, name, threads_username, threads_user_id,
              (access_token IS NOT NULL) AS connected,
              token_expires_at
       FROM threads_accounts ORDER BY name`
    )
    return NextResponse.json(accounts)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { name, threadsUsername } = await req.json()
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })
    const row = await one<{ id: string }>(
      `INSERT INTO threads_accounts (name, threads_username) VALUES ($1, $2) RETURNING id`,
      [name, threadsUsername ?? null]
    )
    return NextResponse.json({ id: row!.id })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { id, ids, name, clearToken } = await req.json()

    // Bulk disconnect
    if (ids && clearToken) {
      const placeholders = (ids as string[]).map((_: string, i: number) => `$${i + 1}`).join(', ')
      await one(`UPDATE threads_accounts SET access_token = NULL, token_expires_at = NULL WHERE id IN (${placeholders})`, ids)
      return NextResponse.json({ ok: true })
    }

    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    await one(`UPDATE threads_accounts SET name=COALESCE($1, name) WHERE id=$2`, [name ?? null, id])
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { id } = await req.json()
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    await one(`DELETE FROM threads_accounts WHERE id=$1`, [id])
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
