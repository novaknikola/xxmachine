import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import {
  getPodSessionPublic,
  savePodSession,
  deletePodSession,
  type SavePodSessionInput,
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

  const body = await req.json().catch(() => ({})) as Partial<SavePodSessionInput>
  try {
    const session = await savePodSession(user.id, {
      comfyBaseUrl: body.comfyBaseUrl ?? '',
      sshHost: body.sshHost ?? '',
      sshPort: body.sshPort,
      sshUser: body.sshUser,
      sshAuthType: body.sshAuthType === 'private_key' ? 'private_key' : 'password',
      sshSecret: body.sshSecret ?? '',
      comfyApiToken: body.comfyApiToken,
      remoteWorkRoot: body.remoteWorkRoot,
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
