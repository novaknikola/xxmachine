import { getUserGoogleAccessToken, forceRefreshUserGoogleAccessToken } from '@/lib/drive-archive/user-google-auth'

/**
 * Thin fetch wrapper around the Sheets v4 REST API, same pattern as
 * google-drive.ts. Retries once with a forced token refresh on 401 — same
 * reasoning as Drive's own retry (long-running batches can outlive the
 * access token's ~1hr lifetime).
 */
async function sheetsRequest(userId: string, path: string, init: RequestInit = {}): Promise<Response> {
  const accessToken = await getUserGoogleAccessToken(userId)
  const doFetch = (token: string) => fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  })

  let res = await doFetch(accessToken)
  if (res.status === 401) {
    const refreshed = await forceRefreshUserGoogleAccessToken(userId)
    res = await doFetch(refreshed)
  }
  return res
}

/** Reads a range (e.g. "Sheet1!A1:D100") as a 2D array of cell strings. */
export async function readSheetRange(userId: string, spreadsheetId: string, range: string): Promise<string[][]> {
  const res = await sheetsRequest(userId, `${spreadsheetId}/values/${encodeURIComponent(range)}`)
  if (!res.ok) throw new Error(`Sheets read failed: ${res.status} ${await res.text()}`)
  const data = await res.json() as { values?: string[][] }
  return data.values ?? []
}

/** Writes a single cell (e.g. "Sheet1!D5"), overwriting whatever's there. */
export async function writeSheetCell(userId: string, spreadsheetId: string, cell: string, value: string): Promise<void> {
  const res = await sheetsRequest(
    userId,
    `${spreadsheetId}/values/${encodeURIComponent(cell)}?valueInputOption=RAW`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [[value]] }) },
  )
  if (!res.ok) throw new Error(`Sheets write failed: ${res.status} ${await res.text()}`)
}
