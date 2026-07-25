import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { randomUUID } from 'crypto'

const BUCKET = 'generations'

// Auth handled here; this route is excluded from the proxy middleware matcher
// because Next.js middleware cannot buffer large uploads.
//
// Body is sent as a raw binary stream (not multipart/form-data) — Next's
// multipart parser was silently dropping the body for a subset of files in
// large batches, producing 0-byte uploads that "succeeded". Raw body + a
// filename header sidesteps that parser entirely.
export async function POST(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  try {
    const rawName = req.headers.get('x-file-name')
    if (!rawName) return NextResponse.json({ error: 'Missing x-file-name header' }, { status: 400 })
    const fileName = decodeURIComponent(rawName)
    const contentType = req.headers.get('content-type') || 'video/mp4'

    const supabaseUrl = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_KEY
    if (!supabaseUrl || !key) {
      return NextResponse.json({ error: 'Storage not configured' }, { status: 500 })
    }

    const ext = fileName.split('.').pop()?.toLowerCase() ?? 'mp4'
    const path = `inputs/${user.id}/${randomUUID()}.${ext}`
    const buffer = Buffer.from(await req.arrayBuffer())

    if (buffer.byteLength === 0) {
      return NextResponse.json({ error: `${fileName} arrived empty — retry the upload` }, { status: 400 })
    }

    const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': contentType,
        'x-upsert': 'true',
      },
      body: buffer,
    })

    if (!uploadRes.ok) {
      const err = await uploadRes.json().catch(() => ({}))
      return NextResponse.json(
        { error: (err as { message?: string }).message ?? 'Upload failed' },
        { status: 500 },
      )
    }

    const publicUrl = `${supabaseUrl}/storage/v1/object/public/${BUCKET}/${path}`
    return NextResponse.json({ url: publicUrl, name: fileName })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    )
  }
}
