import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import {
  listPodSessions,
  getWorkflowDefaults,
  savePodSession,
  deletePodSession,
  setWorkflowDefault,
  type PodWorkflowKey,
} from '@/lib/my-pod/session'

export async function GET(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user
  const sessions = await listPodSessions(user.id)
  const defaults = await getWorkflowDefaults(user.id)
  // Backward-compatible single `session` = first healthy, else first, else disconnected stub
  const session = sessions.find(s => s.healthy) ?? sessions[0] ?? {
    id: '',
    name: '',
    connected: false,
    healthy: false,
    comfyBaseUrl: null,
    sshHostMasked: null,
    sshPort: null,
    sshUser: null,
    remoteWorkRoot: null,
    hasFishApiKey: false,
    lastOkAt: null,
    lastError: null,
    expiresAt: null,
  }
  return NextResponse.json({ sessions, defaults, session })
}

export async function POST(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const body = await req.json().catch(() => ({})) as {
    id?: string
    name?: string
    comfyBaseUrl?: string
    sshCommand?: string
    fishApiKey?: string
    /** Optional: set a workflow default without reconnecting */
    setDefault?: { workflow: PodWorkflowKey; sessionId: string | null }
  }

  if (body.setDefault) {
    try {
      const defaults = await setWorkflowDefault(
        user.id,
        body.setDefault.workflow,
        body.setDefault.sessionId,
      )
      const sessions = await listPodSessions(user.id)
      return NextResponse.json({ defaults, sessions })
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Failed to set default' },
        { status: 400 },
      )
    }
  }

  try {
    const session = await savePodSession(user.id, {
      id: body.id,
      name: body.name,
      comfyBaseUrl: body.comfyBaseUrl ?? '',
      sshCommand: body.sshCommand ?? '',
      fishApiKey: body.fishApiKey,
    })
    const sessions = await listPodSessions(user.id)
    const defaults = await getWorkflowDefaults(user.id)
    return NextResponse.json({ session, sessions, defaults })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to save session' },
      { status: 400 },
    )
  }
}

export async function DELETE(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user
  const id = req.nextUrl.searchParams.get('id')
  if (!id?.trim()) {
    return NextResponse.json({ error: 'id query param required' }, { status: 400 })
  }
  await deletePodSession(user.id, id.trim())
  const sessions = await listPodSessions(user.id)
  const defaults = await getWorkflowDefaults(user.id)
  return NextResponse.json({ ok: true, sessions, defaults })
}
