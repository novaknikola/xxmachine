import { NextResponse } from 'next/server'
import { one } from '@/lib/db'

interface CountRow { count: string }

export async function GET() {
  try {
    const row = await one<CountRow>('select count(*)::text as count from users')
    return NextResponse.json({ needsBootstrap: Number(row?.count ?? 0) === 0 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'db_error'
    // If the users table doesn't exist yet (migrations not run), bootstrap is needed
    const tableNotFound = msg.includes('does not exist') || msg.includes('relation')
    return NextResponse.json(
      { error: msg, needsBootstrap: tableNotFound },
      { status: 500 },
    )
  }
}
