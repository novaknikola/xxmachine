import { NextRequest, NextResponse } from 'next/server'
import { rows, one, query } from '@/lib/db'

export async function GET() {
  try {
    const mappings = await rows(`
      SELECT
        m.id,
        m.sheet_name,
        m.instagram_account_id,
        a.name AS instagram_account_name,
        a.ig_username,
        m.active,
        m.created_at,
        m.updated_at
      FROM content_source_mappings m
      LEFT JOIN instagram_accounts a ON a.id = m.instagram_account_id
      ORDER BY lower(m.sheet_name)
    `)

    return NextResponse.json(mappings)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null) as {
      sheetName?: string
      instagramAccountId?: string | null
    } | null

    const sheetName = body?.sheetName?.trim()
    const instagramAccountId = body?.instagramAccountId || null

    if (!sheetName) {
      return NextResponse.json({ error: 'sheetName required' }, { status: 400 })
    }

    if (instagramAccountId) {
      const account = await one<{ id: string }>(
        `SELECT id FROM instagram_accounts WHERE id = $1 LIMIT 1`,
        [instagramAccountId],
      )

      if (!account) {
        return NextResponse.json({ error: 'instagram account not found' }, { status: 404 })
      }
    }

    const mapping = await one(`
      INSERT INTO content_source_mappings (sheet_name, instagram_account_id, updated_at)
      VALUES ($1, $2, now())
      ON CONFLICT (sheet_name)
      DO UPDATE SET
        instagram_account_id = EXCLUDED.instagram_account_id,
        active = TRUE,
        updated_at = now()
      RETURNING id, sheet_name, instagram_account_id, active, created_at, updated_at
    `, [sheetName, instagramAccountId])

    return NextResponse.json({ ok: true, mapping })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null) as { sheetName?: string } | null
    const sheetName = body?.sheetName?.trim()

    if (!sheetName) {
      return NextResponse.json({ error: 'sheetName required' }, { status: 400 })
    }

    await query(
      `UPDATE content_source_mappings
       SET instagram_account_id = NULL, updated_at = now()
       WHERE lower(sheet_name) = lower($1)`,
      [sheetName],
    )

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
