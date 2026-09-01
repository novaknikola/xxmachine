import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { requireUser } from '@/lib/session'
import { listDriveImages, downloadDriveFile } from '@/lib/google-drive'
import { getUserGoogleAccessToken } from '@/lib/drive-archive/user-google-auth'
import { uploadBuffer } from '@/lib/supabase-storage'

const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', heic: 'image/heic', bmp: 'image/bmp',
}

/** Bounded concurrency so a big folder doesn't fire 100s of Drive calls at once. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R | null>): Promise<R[]> {
  const out: R[] = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      const r = await fn(items[i])
      if (r != null) out.push(r)
    }
  }))
  return out
}

/**
 * List the images in a Drive folder as URLs the app can hand to a generator.
 *
 * Uses the caller's own Google token, not the platform one, so a user can only
 * read folders their own account can see.
 *
 * Each file is pulled through Drive's `files/{id}?alt=media` API (authenticated,
 * raw bytes) and re-hosted in Supabase Storage — the same place `/api/queue/
 * upload-input` puts uploaded files. Handing out Drive's public `uc?export=view`
 * link directly used to be the shape here, but that link 303-redirects to
 * `drive.usercontent.google.com` and third-party fetchers (Grok's vision call,
 * RunPod's image loader) don't reliably follow it — every image loaded that way
 * failed with "Grok error (400)" before generation ever started.
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const folderId = req.nextUrl.searchParams.get('folderId')?.trim()
  if (!folderId) return NextResponse.json({ error: 'folderId required' }, { status: 400 })

  try {
    const accessToken = await getUserGoogleAccessToken(auth.id)
    if (!accessToken) {
      return NextResponse.json(
        { error: 'Google Drive is not connected for this account' },
        { status: 400 },
      )
    }

    const files = await listDriveImages(folderId, accessToken)

    const rehosted = await mapLimited(files, 5, async f => {
      try {
        const buffer = await downloadDriveFile(f.id, accessToken)
        const ext = f.name.split('.').pop()?.toLowerCase() ?? 'jpg'
        const path = `inputs/${auth.id}/${randomUUID()}.${ext}`
        const url = await uploadBuffer(buffer, path, EXT_TO_MIME[ext] ?? 'image/jpeg')
        return { id: f.id, name: f.name, url }
      } catch (err) {
        console.error(`[drive/images] rehost failed for ${f.name} (${f.id}):`, err instanceof Error ? err.message : err)
        return null
      }
    })

    return NextResponse.json({
      urls: rehosted.map(f => f.url),
      files: rehosted.map(f => ({ id: f.id, name: f.name })),
      count: rehosted.length,
      skipped: files.length - rehosted.length,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Drive read failed'
    console.error('[drive/images]', msg)
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
