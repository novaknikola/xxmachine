import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { resolveKey } from '@/lib/user-keys'
import { query } from '@/lib/db'
import { resolveVideoUrlViaRapidApi } from '@/lib/instagram-scrape'

// On-demand re-resolution for a single reel whose cached video link has expired
// (Instagram/RapidAPI CDN links are signed and time-limited).
export async function POST(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const { permalink } = await req.json().catch(() => ({})) as { permalink?: string }
  if (!permalink?.trim()) return NextResponse.json({ error: 'permalink required' }, { status: 400 })

  const rapidApiKey = await resolveKey(user.id, 'RAPIDAPI_KEY')
  if (!rapidApiKey) {
    return NextResponse.json({ error: 'No RapidAPI key configured — add one in Settings to refresh expired links' }, { status: 400 })
  }

  try {
    const resolved = await resolveVideoUrlViaRapidApi(permalink, rapidApiKey)

    await query(
      `update ig_downloader_reels set video_url = $1, scraped_at = now()
        where user_id = $2 and permalink = $3`,
      [resolved.videoUrl, user.id, permalink],
    )

    return NextResponse.json({ ok: true, videoUrl: resolved.videoUrl })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Resolve failed' }, { status: 500 })
  }
}
