import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { one, query } from '@/lib/db'

/**
 * PATCH rendered_prompt for a discovery item before Replicate.
 * Empty string clears the field (next Replicate will re-render from copy_paste_spec).
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const { id } = await params
  const body = await req.json().catch(() => ({})) as {
    rendered_prompt?: string | null
  }

  if (!('rendered_prompt' in body)) {
    return NextResponse.json({ error: 'No prompt fields to update' }, { status: 400 })
  }

  const existing = await one<{ id: string }>(
    `SELECT id FROM discovery_items WHERE id = $1 AND user_id = $2`,
    [id, auth.id],
  )
  if (!existing) {
    return NextResponse.json({ error: 'Item not found' }, { status: 404 })
  }

  const v = typeof body.rendered_prompt === 'string' ? body.rendered_prompt.trim() : null
  // Re-analyze must not overwrite a prompt a human wrote, and it cannot tell one
  // from a stale render — so the edit is recorded here, at the only place one can
  // happen. Clearing the prompt clears the flag too, which keeps the documented
  // "empty string re-renders next time" behaviour and doubles as the escape hatch.
  await query(
    `UPDATE discovery_items
        SET rendered_prompt = $3,
            prompt_edited_at = CASE WHEN $3::text IS NULL THEN NULL ELSE now() END
      WHERE id = $1 AND user_id = $2`,
    [id, auth.id, v || null],
  )

  const row = await one<{ id: string; rendered_prompt: string | null }>(
    `SELECT id, rendered_prompt FROM discovery_items WHERE id = $1`,
    [id],
  )

  return NextResponse.json({ ok: true, item: row })
}
