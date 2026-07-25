import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { rows } from '@/lib/db'

interface ProfileRow {
  username: string
  last_scanned_at: string
  reels_found: number
}

export async function GET(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const profiles = await rows<ProfileRow>(
    `select username, last_scanned_at, reels_found
       from ig_downloader_profiles
      where user_id = $1
      order by last_scanned_at desc
      limit 50`,
    [user.id],
  )

  return NextResponse.json({ profiles })
}
