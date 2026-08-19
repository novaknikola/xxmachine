import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { rows } from '@/lib/db'
import { generateTopicIdeas } from '@/lib/content-engine/idea-generator'

/**
 * Suggest new topic ideas, avoiding this user's past topics. Not saved -- pick one to fill the
 * topic field. Optional body { seed } steers suggestions toward riffs on that specific premise
 * instead of brainstorming brand-new ones.
 */
export async function POST(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  let seed: string | undefined
  try {
    const body = await req.json()
    if (typeof body?.seed === 'string' && body.seed.trim()) seed = body.seed
  } catch {
    // no/invalid body -- fine, seed stays undefined
  }

  const existing = await rows<{ topic: string }>(
    `SELECT DISTINCT topic FROM content_engine_scripts WHERE user_id = $1 ORDER BY topic LIMIT 200`,
    [user.id],
  )

  let ideas: string[]
  try {
    ideas = await generateTopicIdeas(existing.map(r => r.topic), { seed })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Idea generation failed' },
      { status: 502 },
    )
  }

  return NextResponse.json({ ideas })
}
