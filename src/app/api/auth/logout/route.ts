import { NextRequest, NextResponse } from 'next/server'
import { destroySession, clearSessionCookie } from '@/lib/session'

export async function POST(req: NextRequest) {
  await destroySession(req)
  const res = NextResponse.json({ ok: true })
  clearSessionCookie(res)
  return res
}
