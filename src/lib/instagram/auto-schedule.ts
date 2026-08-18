import { rows, one, query } from '@/lib/db'
import { getGoogleAccessToken } from '@/lib/google-auth'

interface DriveFile {
  id: string
  name: string
}

export interface ScheduleWindow {
  label: string
  startHour: number
  endHour: number
}

// Morning / afternoon / evening, roughly 6h apart, randomized within each window
// so posts don't all land at the exact same minute every day.
export const WINDOWS: ScheduleWindow[] = [
  { label: 'morning', startHour: 8, endHour: 11 },
  { label: 'afternoon', startHour: 14, endHour: 17 },
  { label: 'evening', startHour: 19, endHour: 22 },
]

export function randomTimeInWindow(day: Date, window: ScheduleWindow): Date {
  const start = new Date(day)
  start.setHours(window.startHour, 0, 0, 0)
  const end = new Date(day)
  end.setHours(window.endHour, 0, 0, 0)
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()))
}

// A shared pool folder needs its "already used" check to span every
// account, not just the one currently being scheduled — otherwise two
// different accounts pulling from the same folder would both grab the same
// oldest unqueued file, since neither one's own history excludes it.
async function listUnqueuedDriveFiles(folderId: string, accountId: string, poolIsShared: boolean): Promise<DriveFile[]> {
  const accessToken = await getGoogleAccessToken()
  const q = encodeURIComponent(`'${folderId}' in parents and mimeType='video/mp4' and trashed=false`)
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,createdTime,size)&orderBy=createdTime&pageSize=300`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message ?? 'Drive API error')

  const used = poolIsShared
    ? await rows<{ drive_file_id: string }>(
        `SELECT drive_file_id FROM instagram_queue WHERE status IN ('pending','pending_approval','publishing','done')`,
      )
    : await rows<{ drive_file_id: string }>(
        `SELECT drive_file_id FROM instagram_queue
         WHERE account_id=$1 AND status IN ('pending','pending_approval','publishing','done')`,
        [accountId],
      )
  const usedIds = new Set(used.map(r => r.drive_file_id))
  return ((data.files ?? []) as DriveFile[]).filter(f => !usedIds.has(f.id))
}

// Fallback content source for accounts with no dedicated google_drive_folder_id
// of their own — one shared pool of generic, pre-split, one-file-per-account
// videos (confirmed live 2026-08-13: 1000+ mp4s, already split into distinct
// numbered variants so no two accounts ever post the literal same file).
const SHARED_POOL_FOLDER_ID = process.env.CONTENT_POOL_DRIVE_FOLDER_ID

/**
 * Once-a-day content distribution: each connected account gets up to one
 * post per schedule window (morning/afternoon/evening) — an account with its
 * own google_drive_folder_id draws from that folder alone; an account
 * without one falls back to the shared pool (CONTENT_POOL_DRIVE_FOLDER_ID),
 * globally deduplicated across every account so the same file never gets
 * assigned twice.
 *
 * Own-folder accounts insert as 'pending_approval' (a human must approve
 * before the cron publish query — WHERE status='pending' — ever sees them).
 * Shared-pool accounts insert directly as 'pending' — no per-day approval
 * step, per an explicit decision to run these fully hands-off rather than
 * require someone to approve ~180 items/day across dozens of accounts.
 */
export async function runDailyAutoSchedule(): Promise<{ ran: boolean; created: number }> {
  const today = new Date().toISOString().slice(0, 10)

  // Atomic once-per-day claim: if another tick already ran today, this INSERT
  // hits the PK conflict and returns nothing.
  const claimed = await one<{ run_date: string }>(
    `INSERT INTO instagram_auto_schedule_runs (run_date) VALUES ($1)
     ON CONFLICT (run_date) DO NOTHING
     RETURNING run_date`,
    [today],
  )
  if (!claimed) return { ran: false, created: 0 }

  const accounts = await rows<{ id: string; google_drive_folder_id: string | null }>(
    `SELECT id, google_drive_folder_id FROM instagram_accounts
     WHERE (ig_access_token IS NOT NULL OR ig_session IS NOT NULL)`,
  )

  let created = 0
  const day = new Date()

  for (const acc of accounts) {
    const usesSharedPool = !acc.google_drive_folder_id
    if (usesSharedPool && !SHARED_POOL_FOLDER_ID) continue // no folder to draw from at all
    const folderId = acc.google_drive_folder_id ?? SHARED_POOL_FOLDER_ID!
    const status = usesSharedPool ? 'pending' : 'pending_approval'

    try {
      const files = await listUnqueuedDriveFiles(folderId, acc.id, usesSharedPool)
      const picks = files.slice(0, WINDOWS.length)

      for (let i = 0; i < picks.length; i++) {
        const scheduledAt = randomTimeInWindow(day, WINDOWS[i])
        await query(
          `INSERT INTO instagram_queue (account_id, drive_file_id, filename, status, scheduled_at)
           VALUES ($1,$2,$3,$4,$5)`,
          [acc.id, picks[i].id, picks[i].name, status, scheduledAt.toISOString()],
        )
        created++
      }
    } catch (err) {
      console.error('[auto-schedule]', acc.id, err instanceof Error ? err.message : err)
    }
  }

  await query(
    `UPDATE instagram_auto_schedule_runs SET items_created=$1 WHERE run_date=$2`,
    [created, today],
  )

  // Now fire-and-forget from cron/tick, so this is the only place its
  // outcome shows up — worth a success line, not just errors, since a
  // suspiciously low count (fewer than ~3x eligible accounts) is itself
  // the signal something truncated the run.
  console.log(`[auto-schedule] done: ${created} items created for ${accounts.length} eligible accounts`)

  return { ran: true, created }
}
