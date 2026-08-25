import { getGoogleAccessToken } from '@/lib/google-auth'
import { SHEET_ID, SHEET_RANGE } from './config'

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly'

/** Pulls the username out of an instagram.com profile URL (or a bare handle). */
function extractUsername(cell: string): string | null {
  const trimmed = cell.trim().replace(/^@/, '')
  if (!trimmed) return null

  if (!/instagram\.com/i.test(trimmed)) {
    // Bare handle, e.g. "somehandle"
    return /^[A-Za-z0-9._]{1,30}$/.test(trimmed) ? trimmed : null
  }

  try {
    const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    const url = new URL(withProto)
    const username = url.pathname.split('/').filter(Boolean)[0]
    return username || null
  } catch {
    return null
  }
}

/**
 * Reads the configured range from the profile-list Google Sheet via the
 * shared service account (Sheets scope) and returns deduped usernames.
 */
export async function getTrackedProfileUsernames(): Promise<string[]> {
  if (!SHEET_ID) {
    throw new Error('VIRAL_MONITOR_SHEET_ID is not configured')
  }

  const accessToken = await getGoogleAccessToken(SHEETS_SCOPE)
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(SHEET_RANGE)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) {
    throw new Error(`Sheets read failed: ${res.status} ${await res.text()}`)
  }
  const data = await res.json() as { values?: string[][] }
  const cells = (data.values ?? []).map(row => row[0]).filter((v): v is string => !!v)

  const usernames = new Set<string>()
  for (const cell of cells) {
    const username = extractUsername(cell)
    if (username) usernames.add(username)
  }
  return Array.from(usernames)
}
