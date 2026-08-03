import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { listDriveImages } from '@/lib/google-drive'
import { getUserGoogleAccessToken } from '@/lib/drive-archive/user-google-auth'

/**
 * List the images in a Drive folder as URLs the app can hand to a generator.
 *
 * Uses the caller's own Google token, not the platform one, so a user can only
 * read folders their own account can see.
 *
 * The URLs are Drive's `uc?export=view` form, which works for anything shared
 * link-visible. A folder that is private to the account will list here but the
 * URL will not be fetchable by a third party such as RunPod — see the note on
 * the response.
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
    return NextResponse.json({
      urls: files.map(f => `https://drive.google.com/uc?export=view&id=${f.id}`),
      files: files.map(f => ({ id: f.id, name: f.name })),
      count: files.length,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Drive read failed'
    console.error('[drive/images]', msg)
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
