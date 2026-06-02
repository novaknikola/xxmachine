import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser(req)
    if (!user) return NextResponse.json({ user: null })
    return NextResponse.json({ user })
  } catch {
    return NextResponse.json({ user: null }, { status: 500 })
  }
}
