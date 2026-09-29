import { NextRequest, NextResponse } from 'next/server'
import { requireApiToken } from '@/lib/api-token'
import { enqueueRepurposeJob } from '@/lib/repurpose/enqueue-from-drive'
import { getRepurposeSettings } from '@/lib/monitor/telegram-repurpose'
import { sanitizeDriveKey } from '@/lib/drive-archive/paths'

const MAX_VARIANTS = 20
const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/

/**
 * One repurpose job for a raw Drive reel: `count` variants, one per farm
 * device of that character. Uses the account's own /settings effects, same as
 * the Telegram folder command. Poll GET ./[id] for the variant URLs.
 */
export async function POST(req: NextRequest) {
  const auth = await requireApiToken(req)
  if (auth instanceof NextResponse) return auth

  const body = await req.json().catch(() => null) as {
    driveFileId?: unknown
    fileName?: unknown
    count?: unknown
    characterKey?: unknown
  } | null

  const driveFileId = typeof body?.driveFileId === 'string' ? body.driveFileId.trim() : ''
  const count = Number(body?.count)
  if (!DRIVE_ID.test(driveFileId)) {
    return NextResponse.json({ error: 'driveFileId is required' }, { status: 400 })
  }
  if (!Number.isInteger(count) || count < 1 || count > MAX_VARIANTS) {
    return NextResponse.json({ error: `count must be 1-${MAX_VARIANTS}` }, { status: 400 })
  }
  const fileName = typeof body?.fileName === 'string' && body.fileName.trim()
    ? body.fileName.trim().slice(0, 200)
    : `${driveFileId}.mp4`
  const characterKey = typeof body?.characterKey === 'string' ? sanitizeDriveKey(body.characterKey) : null

  const settings = await getRepurposeSettings(auth.id)
  const jobId = await enqueueRepurposeJob({
    userId: auth.id,
    videoUrl: '',
    videoName: fileName,
    count,
    effects: settings.effects,
    characterKey,
    seriesLabel: fileName.replace(/\.[^.]+$/, ''),
    driveFileId,
    notifyTelegram: false,
  })
  if (!jobId) return NextResponse.json({ error: 'Could not queue the job' }, { status: 500 })

  return NextResponse.json({ jobId, count })
}
