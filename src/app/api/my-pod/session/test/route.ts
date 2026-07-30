import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { testPodSession, listPodSessions, getWorkflowDefaults } from '@/lib/my-pod/session'

export async function POST(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user
  const body = await req.json().catch(() => ({})) as { sessionId?: string }
  const sessionId = body.sessionId ?? req.nextUrl.searchParams.get('id')
  try {
    const session = await testPodSession(user.id, sessionId)
    const sessions = await listPodSessions(user.id)
    const defaults = await getWorkflowDefaults(user.id)
    return NextResponse.json({ session, sessions, defaults })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Test failed' },
      { status: 400 },
    )
  }
}
