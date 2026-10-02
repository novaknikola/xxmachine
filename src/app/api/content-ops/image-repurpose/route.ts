import { NextRequest, NextResponse } from 'next/server'
import { requireApiToken } from '@/lib/api-token'
import { FarmImageOrderError, orderFarmImageRepurpose } from '@/lib/content-ops/image-repurpose'

/**
 * One image repurpose job for an approved photo on Drive raw: a post/story
 * (one file) or a carousel set (its files in slide order), `count` variants —
 * one per farm account of that character. Re-sending the same order returns
 * the same job. Poll GET ./[id] for the variant sets.
 */
export async function POST(req: NextRequest) {
  const auth = await requireApiToken(req)
  if (auth instanceof NextResponse) return auth

  const body = await req.json().catch(() => null)
  try {
    return NextResponse.json(await orderFarmImageRepurpose(auth.id, body))
  } catch (err) {
    if (err instanceof FarmImageOrderError) return NextResponse.json({ error: err.message }, { status: err.status })
    throw err
  }
}
