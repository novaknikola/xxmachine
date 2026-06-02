import { NextRequest, NextResponse } from 'next/server'
import { rows } from '@/lib/db'
import type { ViralReel } from '@/lib/types'

export async function GET(req: NextRequest) {
  try {
    const limit = Math.min(Number(req.nextUrl.searchParams.get('limit') ?? 100), 500)
    const offset = Number(req.nextUrl.searchParams.get('offset') ?? 0)
    const reels = await rows<ViralReel>(
      'SELECT * FROM viral_reels ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    )
    return NextResponse.json({ reels })
  } catch (err) {
    return NextResponse.json({ reels: [], error: String(err) }, { status: 500 })
  }
}
