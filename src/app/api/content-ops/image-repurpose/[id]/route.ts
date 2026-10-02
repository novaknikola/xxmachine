import { NextRequest, NextResponse } from 'next/server'
import { requireApiToken } from '@/lib/api-token'
import { farmImageRepurposeStatus } from '@/lib/content-ops/image-repurpose'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * sets[i] is target i's variant: its slides' URLs in slide order (one URL for
 * a post or story). A target whose render failed stays in the list as
 * "error:<reason>" so indexes keep matching the accounts they were ordered for.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiToken(req)
  if (auth instanceof NextResponse) return auth

  const { id } = await ctx.params
  if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const status = await farmImageRepurposeStatus(auth.id, id)
  if (!status) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json(status)
}
