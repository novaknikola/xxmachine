import { rows, one, query } from '@/lib/db'
import { getGoogleAccessToken } from '@/lib/google-auth'
import { WINDOWS, randomTimeInWindow } from '@/lib/instagram/auto-schedule'
import { enrichPendingFacebookQueueItems } from '@/lib/facebook/enrich'

interface DriveFile {
  id: string
  name: string
}

/**
 * How many pending items for this page already carry a scheduled_at — used
 * as a continuation cursor so newly-uploaded videos append after whatever's
 * already queued instead of colliding with it.
 */
async function pendingScheduledCount(pageId: string): Promise<number> {
  const result = await one<{ count: number }>(
    `SELECT count(*)::int AS count FROM facebook_queue
     WHERE page_id=$1 AND status='pending' AND scheduled_at IS NOT NULL`,
    [pageId],
  )
  return result?.count ?? 0
}

/**
 * Pure slot math: position `i` in the 3/day rotation maps to a window on
 * day floor(i/3) from today. Shared by nextFacebookSlot (single item, DB
 * cursor) and the bulk sync/auto-schedule paths (many items, one cursor
 * read up front instead of one query per item).
 */
function slotForIndex(i: number): Date {
  const dayOffset = Math.floor(i / WINDOWS.length)
  const window = WINDOWS[i % WINDOWS.length]
  const day = new Date()
  day.setDate(day.getDate() + dayOffset)
  return randomTimeInWindow(day, window)
}

/**
 * Fills the same morning/afternoon/evening windows as mass-schedule and the
 * daily auto-schedule, 3/day, but keyed off how many are already queued for
 * this page rather than a start date + explicit id list — so each bulk
 * upload just appends onto the tail of whatever's already scheduled.
 */
export async function nextFacebookSlot(pageId: string, offset: number): Promise<Date> {
  const base = await pendingScheduledCount(pageId)
  return slotForIndex(base + offset)
}

export async function listAllDriveFiles(folderId: string): Promise<DriveFile[]> {
  const accessToken = await getGoogleAccessToken()
  const q = encodeURIComponent(`'${folderId}' in parents and mimeType='video/mp4' and trashed=false`)
  const all: DriveFile[] = []
  let pageToken: string | undefined
  do {
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,createdTime,size),nextPageToken&orderBy=createdTime&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ''}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error?.message ?? 'Drive API error')
    all.push(...((data.files ?? []) as DriveFile[]))
    pageToken = data.nextPageToken
  } while (pageToken)
  return all
}

/**
 * Once-a-day content distribution for Facebook Pages, mirroring
 * runDailyAutoSchedule in [[project-xxmachine-instagram-oauth-app-review]]'s
 * sibling module. Each connected Page has its own dedicated
 * google_drive_folder_id (a deliberate choice — separate content pool per
 * page, not a cross-post of the Instagram folder).
 *
 * Queues every unqueued Drive file in one pass, not just today's 3 —
 * confirmed live 2026-09-09 that capping this to WINDOWS.length meant a
 * 66-file Drive folder took 22 days to even become visible in the planner,
 * one straggler a day, regardless of how many videos were actually sitting
 * there ready to go. Posting itself still lands 3/day: each file gets the
 * next slot in the same rotation nextFacebookSlot uses, so a big folder
 * just spreads forward across as many future days as it needs instead of
 * trickling into existence.
 */
export async function runDailyFacebookAutoSchedule(): Promise<{ ran: boolean; created: number }> {
  const today = new Date().toISOString().slice(0, 10)

  const claimed = await one<{ run_date: string }>(
    `INSERT INTO facebook_auto_schedule_runs (run_date) VALUES ($1)
     ON CONFLICT (run_date) DO NOTHING
     RETURNING run_date`,
    [today],
  )
  if (!claimed) return { ran: false, created: 0 }

  const pages = await rows<{ id: string; google_drive_folder_id: string | null }>(
    `SELECT id, google_drive_folder_id FROM facebook_pages WHERE google_drive_folder_id IS NOT NULL`,
  )

  let created = 0

  for (const page of pages) {
    try {
      created += await syncFacebookPageFromDrive(page.id, page.google_drive_folder_id!)
      // Awaited, not fire-and-forget: this whole function is already called
      // un-awaited from cron/tick, so there's no request/response to avoid
      // blocking here — and a detached call here specifically was
      // confirmed (2026-09-09, see sync-drive's own comment) to just never
      // run at all once its enclosing request context tears down.
      await enrichPendingFacebookQueueItems(page.id)
    } catch (err) {
      console.error('[facebook auto-schedule]', page.id, err instanceof Error ? err.message : err)
    }
  }

  await query(
    `UPDATE facebook_auto_schedule_runs SET items_created=$1 WHERE run_date=$2`,
    [created, today],
  )

  console.log(`[facebook auto-schedule] done: ${created} items created for ${pages.length} eligible pages`)
  return { ran: true, created }
}

/**
 * Queues every Drive file not already in facebook_queue for this page,
 * each landing on the next slot in the 3/day rotation. Shared by the daily
 * cron above and the manual "Sync Drive" button — same logic either way,
 * the button just doesn't wait for tomorrow's tick to catch up a folder
 * someone just bulk-added files to outside the app's own upload button.
 */
export async function syncFacebookPageFromDrive(pageId: string, folderId: string): Promise<number> {
  const files = await listAllDriveFiles(folderId)
  const used = await rows<{ drive_file_id: string }>(
    `SELECT drive_file_id FROM facebook_queue
     WHERE page_id=$1 AND status IN ('pending','publishing','done')`,
    [pageId],
  )
  const usedIds = new Set(used.map(r => r.drive_file_id))
  const unqueued = files.filter(f => !usedIds.has(f.id))
  if (!unqueued.length) return 0

  const base = await pendingScheduledCount(pageId)
  let created = 0
  for (let i = 0; i < unqueued.length; i++) {
    const scheduledAt = slotForIndex(base + i)
    await query(
      `INSERT INTO facebook_queue (page_id, drive_file_id, filename, status, scheduled_at)
       VALUES ($1,$2,$3,'pending',$4)`,
      [pageId, unqueued[i].id, unqueued[i].name, scheduledAt.toISOString()],
    )
    created++
  }
  return created
}
