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

async function listUnqueuedDriveFiles(accountId: string, folderId: string): Promise<DriveFile[]> {
  const accessToken = await getGoogleAccessToken()
  const q = encodeURIComponent(`'${folderId}' in parents and mimeType='video/mp4' and trashed=false`)
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,createdTime,size)&orderBy=createdTime&pageSize=100`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message ?? 'Drive API error')

  const used = await rows<{ drive_file_id: string }>(
    `SELECT drive_file_id FROM instagram_queue
     WHERE account_id=$1 AND status IN ('pending','pending_approval','publishing','done')`,
    [accountId],
  )
  const usedIds = new Set(used.map(r => r.drive_file_id))
  return ((data.files ?? []) as DriveFile[]).filter(f => !usedIds.has(f.id))
}

/**
 * Once-a-day content distribution: each connected account with a Drive folder
 * gets up to one post per schedule window (morning/afternoon/evening), pulled
 * from its own folder's not-yet-queued videos. "Proportional" here means each
 * account draws from what it actually has available — an account with fewer
 * new videos in Drive that day simply gets fewer posts, nothing is shared
 * across accounts' folders.
 *
 * Inserted rows use status 'pending_approval' — a value with no CHECK
 * constraint on instagram_queue.status, so the existing cron publish query
 * (WHERE status='pending') and every other existing consumer of this table
 * simply never sees them until a human approves.
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

  const accounts = await rows<{ id: string; google_drive_folder_id: string }>(
    `SELECT id, google_drive_folder_id FROM instagram_accounts
     WHERE google_drive_folder_id IS NOT NULL
       AND (ig_access_token IS NOT NULL OR ig_session IS NOT NULL)`,
  )

  let created = 0
  const day = new Date()

  for (const acc of accounts) {
    try {
      const files = await listUnqueuedDriveFiles(acc.id, acc.google_drive_folder_id)
      const picks = files.slice(0, WINDOWS.length)

      for (let i = 0; i < picks.length; i++) {
        const scheduledAt = randomTimeInWindow(day, WINDOWS[i])
        await query(
          `INSERT INTO instagram_queue (account_id, drive_file_id, filename, status, scheduled_at)
           VALUES ($1,$2,$3,'pending_approval',$4)`,
          [acc.id, picks[i].id, picks[i].name, scheduledAt.toISOString()],
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

  return { ran: true, created }
}
