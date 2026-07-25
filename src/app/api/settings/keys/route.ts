import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { getUserKeys, setUserKey, BYOK_KEY_DEFS } from '@/lib/user-keys'

export async function GET(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const keys = await getUserKeys(user.id)
  // Return which keys are set (not the values) + key defs for the UI
  const status = BYOK_KEY_DEFS.map(def => ({
    name:     def.name,
    label:    def.label,
    placeholder: def.placeholder,
    required: def.required,
    isSet:    !!keys[def.name],
  }))
  return NextResponse.json({ keys: status })
}

export async function POST(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const body = await req.json() as Record<string, string>
  for (const [keyName, value] of Object.entries(body)) {
    if (typeof value !== 'string') continue
    await setUserKey(user.id, keyName, value)
  }
  return NextResponse.json({ ok: true })
}
