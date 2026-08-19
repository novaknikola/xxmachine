import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { one, rows } from '@/lib/db'
import { generateScript } from '@/lib/content-engine/script-writer'

/** List this user's generated scripts, newest first. */
export async function GET(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const items = await rows(
    `SELECT id, topic, script, created_at, updated_at
       FROM content_engine_scripts
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 100`,
    [user.id],
  )
  return NextResponse.json({ items })
}

/** Generate a new script draft from a topic and save it. No WaveSpeed billing here -- Grok only. */
export async function POST(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  let body: { topic?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const topic = (body.topic ?? '').trim()
  if (!topic) return NextResponse.json({ error: 'topic is required' }, { status: 400 })

  let result: Awaited<ReturnType<typeof generateScript>>
  try {
    result = await generateScript(topic)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Script generation failed' },
      { status: 502 },
    )
  }

  const saved = await one<{ id: string; topic: string; script: unknown; created_at: string; updated_at: string }>(
    `INSERT INTO content_engine_scripts (user_id, topic, script)
     VALUES ($1, $2, $3)
     RETURNING id, topic, script, created_at, updated_at`,
    [user.id, topic, JSON.stringify(result.script)],
  )

  return NextResponse.json({ item: saved, warnings: result.warnings })
}
