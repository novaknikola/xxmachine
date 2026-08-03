import { NextRequest, NextResponse } from 'next/server'
import { rows } from '@/lib/db'
import { requireUser } from '@/lib/session'
import { repurposeImageUrls } from '@/lib/drive-archive/image-repurpose'
import { enqueueDriveArchive } from '@/lib/drive-archive/enqueue'

/**
 * Bounded because each pin is an ffmpeg pass on a downloaded image and this
 * runs inside the request. Well under nginx's 300s at this size; raise it and
 * it belongs on the queue instead.
 */
const MAX_PINS = 20

/**
 * Save picked pins straight to story content.
 *
 * The pin is not regenerated — it goes through the same light repurpose every
 * other publishable asset gets (re-encode, subtle crop/level jitter, stripped
 * metadata) so the file is not a byte-identical copy of someone else's image,
 * then lands in Drive under the story folder. Same two steps, in the same
 * order, as finalizeDiscoveryReady.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const body = await req.json().catch(() => ({})) as {
    ids?: string[]
    folderName?: string
    strength?: 'dedupe' | 'distinct'
  }

  const ids = Array.isArray(body.ids) ? body.ids.filter(id => typeof id === 'string' && id) : []
  if (!ids.length) return NextResponse.json({ error: 'Pick at least one pin' }, { status: 400 })
  if (ids.length > MAX_PINS) {
    return NextResponse.json(
      { error: `Max ${MAX_PINS} pins per save — repurposing runs inline` },
      { status: 400 },
    )
  }

  const folderName = String(body.folderName ?? '').trim()
  if (!folderName) return NextResponse.json({ error: 'Enter a Drive folder name' }, { status: 400 })

  // Joined through the board so a user can only reach their own pins.
  const pins = await rows<{ id: string; image_url_hd: string; board_key: string }>(
    `SELECT p.id, p.image_url_hd, b.board_key
       FROM pinterest_pins p
       JOIN pinterest_boards b ON b.id = p.board_id
      WHERE b.user_id = $1 AND p.id = ANY($2::uuid[]) AND p.is_active`,
    [auth.id, ids],
  )
  if (!pins.length) return NextResponse.json({ error: 'No matching pins' }, { status: 404 })

  try {
    const { readyUrls, skipped } = await repurposeImageUrls({
      urls: pins.map(p => p.image_url_hd),
      format: 'stories',
      basePath: `pinterest/${auth.id}/stories/${Date.now()}`,
      // 'dedupe' is the light pass: enough that the file is not a byte-for-byte
      // reupload, not enough to visibly alter the image.
      strength: body.strength === 'distinct' ? 'distinct' : 'dedupe',
    })

    if (!readyUrls.length) {
      return NextResponse.json(
        { error: 'Repurpose produced no files — the pin images may be unreachable' },
        { status: 502 },
      )
    }

    const archived = await enqueueDriveArchive({
      userId: auth.id,
      sourceType: 'pinterest_pin',
      // Distinct per save, so saving the same pins twice is two sets rather
      // than a no-op against the archive's dedupe key.
      sourceId: `stories:${Date.now()}:${pins.map(p => p.id).join(',').slice(0, 200)}`,
      urls: readyUrls,
      characterKey: folderName,
      kind: 'stories',
      stage: 'ready',
      modelKey: 'pinterest',
    })

    return NextResponse.json({
      saved: readyUrls.length,
      skipped,
      archiveQueued: archived.enqueued,
      // Surfaced rather than swallowed: enqueueDriveArchive no-ops when Drive
      // is not connected, and silently saving nothing would look like success.
      archiveSkippedReason: archived.skipped ? archived.reason ?? 'drive_not_connected' : null,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Save failed'
    console.error('[pinterest/stories] failed:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
