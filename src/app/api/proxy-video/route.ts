import { NextRequest, NextResponse } from 'next/server'
import { fetchPublicUrl, UnsafeUrlError } from '@/lib/public-fetch'

// Instagram/Facebook CDN video URLs don't send CORS headers, so the browser can't
// fetch() them directly cross-origin. Proxying server-side sidesteps that entirely —
// CORS is a browser-enforced policy, not a server one.
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url')
  if (!url) return NextResponse.json({ error: 'Missing url param' }, { status: 400 })

  let referer: string
  try {
    referer = new URL(url).origin
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })
  }

  try {
    const res = await fetchPublicUrl(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': referer,
      },
    })

    if (!res.ok) {
      return NextResponse.json({ error: `Upstream returned ${res.status}` }, { status: 502 })
    }

    const contentType = res.headers.get('content-type') ?? 'video/mp4'
    const buf = await res.arrayBuffer()
    return new NextResponse(buf, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    console.error('[proxy-video] fetch failed:', err)
    return NextResponse.json({ error: 'Fetch failed' }, { status: 500 })
  }
}
