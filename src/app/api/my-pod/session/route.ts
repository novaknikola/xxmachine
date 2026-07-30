import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import {
  getPodSessionPublic,
  savePodSession,
  deletePodSession,
} from '@/lib/my-pod/session'

export async function GET(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user
  const session = await getPodSessionPublic(user.id)
  return NextResponse.json({ session })
}

export async function POST(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const body = await req.json().catch(() => ({})) as {
    comfyBaseUrl?: string
    sshCommand?: string
  }
  try {
    const session = await savePodSession(user.id, {
      comfyBaseUrl: body.comfyBaseUrl ?? '',
      sshCommand: body.sshCommand ?? '',
    })
    return NextResponse.json({ session })
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
  await deletePodSession(user.id)
  return NextResponse.json({ ok: true })
}
