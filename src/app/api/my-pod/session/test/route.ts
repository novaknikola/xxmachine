import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { testPodSession } from '@/lib/my-pod/session'

export async function POST(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user
  try {
    const session = await testPodSession(user.id)
    return NextResponse.json({ session })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Test failed' },
      { status: 400 },
    )
  }
}
