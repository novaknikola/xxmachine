import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { one, query } from '@/lib/db'

/**
 * PATCH scene_prompt / motion_prompt for a discovery item before Replicate.
 * Empty string clears the field (next Replicate will regenerate).
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const { id } = await params
  const body = await req.json().catch(() => ({})) as {
    scene_prompt?: string | null
    motion_prompt?: string | null
  }

  const existing = await one<{ id: string }>(
    `SELECT id FROM discovery_items WHERE id = $1 AND user_id = $2`,
    [id, auth.id],
  )
  if (!existing) {
    return NextResponse.json({ error: 'Item not found' }, { status: 404 })
  }

  const sets: string[] = []
  const values: unknown[] = [id, auth.id]
  let i = 3

  if ('scene_prompt' in body) {
    const v = typeof body.scene_prompt === 'string' ? body.scene_prompt.trim() : null
    sets.push(`scene_prompt = $${i++}`)
    values.push(v || null)
  }
  if ('motion_prompt' in body) {
    const v = typeof body.motion_prompt === 'string' ? body.motion_prompt.trim() : null
    sets.push(`motion_prompt = $${i++}`)
    values.push(v || null)
  }

  if (!sets.length) {
    return NextResponse.json({ error: 'No prompt fields to update' }, { status: 400 })
  }

  await query(
    `UPDATE discovery_items SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2`,
    values,
  )

  const row = await one<{
    id: string
    scene_prompt: string | null
    motion_prompt: string | null
  }>(
    `SELECT id, scene_prompt, motion_prompt FROM discovery_items WHERE id = $1`,
    [id],
  )

  return NextResponse.json({ ok: true, item: row })
}
