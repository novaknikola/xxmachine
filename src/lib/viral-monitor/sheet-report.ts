import { getGoogleAccessToken } from '@/lib/google-auth'
import { rows } from '@/lib/db'
import { SHEET_ID, REPORT_SHEET_NAME } from './config'

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets'

interface VideoRow {
  profile_username: string
  video_url: string
  last_views: string | null
  followers: string | null
  posted_at: Date | null
  last_checked_at: Date | null
  reported_at: Date | null
}

async function sheetsRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const accessToken = await getGoogleAccessToken(SHEETS_SCOPE)
  return fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  })
}

async function ensureReportTabExists(): Promise<void> {
  const res = await sheetsRequest(`${SHEET_ID}?fields=sheets.properties.title`)
  if (!res.ok) throw new Error(`Failed to read spreadsheet metadata: ${res.status} ${await res.text()}`)
  const data = await res.json() as { sheets?: { properties?: { title?: string } }[] }
  const exists = (data.sheets ?? []).some(s => s.properties?.title === REPORT_SHEET_NAME)
  if (exists) return

  const res2 = await sheetsRequest(`${SHEET_ID}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: REPORT_SHEET_NAME } } }] }),
  })
  if (!res2.ok) throw new Error(`Failed to create "${REPORT_SHEET_NAME}" tab: ${res2.status} ${await res2.text()}`)
}

/**
 * Best-effort mirror of viral_monitor_videos into its own sheet tab, so the
 * scan data (views, followers, dates) is visible outside the DB without
 * touching the input tab/column at all. Full overwrite every run — simplest
 * and self-correcting, no incremental row-tracking to drift out of sync.
 */
export async function writeVideosReport(): Promise<void> {
  if (!SHEET_ID) return
  await ensureReportTabExists()

  const data = await rows<VideoRow>(
    `SELECT profile_username, video_url, last_views, followers, posted_at, last_checked_at, reported_at
       FROM viral_monitor_videos
      ORDER BY last_views DESC NULLS LAST`,
  )

  const header = ['Profile', 'Video URL', 'Views', 'Followers', 'Posted At', 'Last Checked', 'Reported As Viral']
  const values = [
    header,
    ...data.map(r => [
      r.profile_username,
      r.video_url,
      r.last_views ?? '',
      r.followers ?? '',
      r.posted_at ?? '',
      r.last_checked_at ?? '',
      r.reported_at ? 'YES' : '',
    ]),
  ]

  // Clear first so a shrinking result set doesn't leave stale trailing rows.
  const clearRes = await sheetsRequest(`${SHEET_ID}/values/${encodeURIComponent(REPORT_SHEET_NAME)}:clear`, { method: 'POST' })
  if (!clearRes.ok) throw new Error(`Failed to clear "${REPORT_SHEET_NAME}": ${clearRes.status} ${await clearRes.text()}`)

  const writeRes = await sheetsRequest(
    `${SHEET_ID}/values/${encodeURIComponent(`${REPORT_SHEET_NAME}!A1`)}?valueInputOption=RAW`,
    { method: 'PUT', body: JSON.stringify({ values }) },
  )
  if (!writeRes.ok) throw new Error(`Failed to write "${REPORT_SHEET_NAME}": ${writeRes.status} ${await writeRes.text()}`)
}
