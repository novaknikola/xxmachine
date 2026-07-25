import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser, clearSessionCookie } from '@/lib/session'

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser(req)
    if (!user) {
      const res = NextResponse.json({ user: null })
      if (req.cookies.get('xm_sid')?.value) clearSessionCookie(res)
      return res
    }
    return NextResponse.json({ user })
  } catch {
    return NextResponse.json({ user: null }, { status: 500 })
  }
}
