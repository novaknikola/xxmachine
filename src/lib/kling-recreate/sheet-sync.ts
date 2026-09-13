/**
 * Best-effort mirror of Kling recreate analysis + banked ideas into the
 * existing viral-monitor spreadsheet (VIRAL_MONITOR_SHEET_ID).
 *
 * Creates `Kling Analysis` and `Kling Ideas` tabs if missing. Never clears
 * or writes the Videos tab or Sheet1 — writeVideosReport stays the only
 * Videos writer.
 */
import { getGoogleAccessToken } from '@/lib/google-auth'
import { one, rows } from '@/lib/db'
import { SHEET_ID } from '@/lib/viral-monitor/config'
import type { HashedIdea } from './ideas'
import type { KlingVideoContext } from './types'
import {
  EMPTY_VIRAL_FIELDS,
  KLING_ANALYSIS_HEADERS,
  KLING_ANALYSIS_TAB,
  KLING_IDEA_HEADERS,
  KLING_IDEAS_TAB,
  buildAnalysisSheetRow,
  buildIdeaSheetRow,
  existingIdeaHashes,
  findAnalysisRowNumber,
  ideasNotAlreadyInSheet,
  instagramShortcode,
  matchViralRow,
  viralFieldsFromRow,
  type ViralLookupRow,
  type ViralSheetFields,
} from './sheet-rows'

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets'

async function sheetsRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const accessToken = await getGoogleAccessToken(SHEETS_SCOPE)
  return fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  })
}

interface SheetProps {
  sheetId: number
  title: string
  frozenRowCount: number
}

async function listSheets(): Promise<SheetProps[]> {
  const res = await sheetsRequest(
    `${SHEET_ID}?fields=sheets.properties(sheetId,title,gridProperties.frozenRowCount)`,
  )
  if (!res.ok) throw new Error(`Failed to read spreadsheet metadata: ${res.status} ${await res.text()}`)
  const data = await res.json() as {
    sheets?: { properties?: { sheetId?: number; title?: string; gridProperties?: { frozenRowCount?: number } } }[]
  }
  return (data.sheets ?? [])
    .map(s => ({
      sheetId: s.properties?.sheetId ?? -1,
      title: s.properties?.title ?? '',
      frozenRowCount: s.properties?.gridProperties?.frozenRowCount ?? 0,
    }))
    .filter(s => s.sheetId >= 0 && s.title)
}

async function ensureTab(title: string, headers: readonly string[]): Promise<void> {
  if (!SHEET_ID) return
  const sheets = await listSheets()
  let tab = sheets.find(s => s.title === title)
  if (!tab) {
    const res = await sheetsRequest(`${SHEET_ID}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{
          addSheet: {
            properties: {
              title,
              gridProperties: { frozenRowCount: 1 },
            },
          },
        }],
      }),
    })
    if (!res.ok) throw new Error(`Failed to create "${title}" tab: ${res.status} ${await res.text()}`)
    const created = await res.json() as {
      replies?: { addSheet?: { properties?: { sheetId?: number } } }[]
    }
    tab = {
      sheetId: created.replies?.[0]?.addSheet?.properties?.sheetId ?? -1,
      title,
      frozenRowCount: 1,
    }
  } else if (tab.frozenRowCount < 1 && tab.sheetId >= 0) {
    const freeze = await sheetsRequest(`${SHEET_ID}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{
          updateSheetProperties: {
            properties: { sheetId: tab.sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount',
          },
        }],
      }),
    })
    if (!freeze.ok) {
      console.warn(`[kling-recreate] could not freeze header on "${title}": ${freeze.status}`)
    }
  }

  const headerRes = await sheetsRequest(
    `${SHEET_ID}/values/${encodeURIComponent(`${title}!A1:Z1`)}`,
  )
  if (!headerRes.ok) throw new Error(`Failed to read "${title}" header: ${headerRes.status} ${await headerRes.text()}`)
  const headerData = await headerRes.json() as { values?: string[][] }
  const existing = headerData.values?.[0] ?? []
  if (existing.length === 0) {
    const write = await sheetsRequest(
      `${SHEET_ID}/values/${encodeURIComponent(`${title}!A1`)}?valueInputOption=RAW`,
      { method: 'PUT', body: JSON.stringify({ values: [headers] }) },
    )
    if (!write.ok) throw new Error(`Failed to write "${title}" header: ${write.status} ${await write.text()}`)
  }
}

async function readRange(title: string, range: string): Promise<string[][]> {
  const res = await sheetsRequest(
    `${SHEET_ID}/values/${encodeURIComponent(`${title}!${range}`)}`,
  )
  if (!res.ok) throw new Error(`Failed to read "${title}!${range}": ${res.status} ${await res.text()}`)
  const data = await res.json() as { values?: string[][] }
  return data.values ?? []
}

async function lookupViral(sourceUrl: string): Promise<ViralSheetFields> {
  const code = instagramShortcode(sourceUrl)
  if (!code) return { ...EMPTY_VIRAL_FIELDS }

  const row = await one<ViralLookupRow>(
    `SELECT profile_username, video_url, shortcode, last_views, reported_at
       FROM viral_monitor_videos
      WHERE lower(coalesce(shortcode, '')) = $1
         OR video_url ILIKE '%instagram.com/reel/' || $1 || '%'
         OR video_url ILIKE '%instagram.com/reels/' || $1 || '%'
         OR video_url ILIKE '%instagram.com/p/' || $1 || '%'
      LIMIT 1`,
    [code],
  )
  if (row) return viralFieldsFromRow(row)

  // Fallback: pull a small candidate set and match in JS (/tv/, username paths).
  const candidates = await rows<ViralLookupRow>(
    `SELECT profile_username, video_url, shortcode, last_views, reported_at
       FROM viral_monitor_videos
      WHERE lower(coalesce(shortcode, '')) = $1
         OR video_url ILIKE '%' || $1 || '%'
      LIMIT 20`,
    [code],
  )
  return viralFieldsFromRow(matchViralRow(sourceUrl, candidates))
}

export async function upsertKlingAnalysisSheet(opts: {
  jobId: string
  sourceUrl: string
  durationSec: number | string | null
  context: Partial<KlingVideoContext> | null
  masterPrompt: string | null
  status: string
  klingVideoUrl: string | null
  addedAt?: string
}): Promise<void> {
  if (!SHEET_ID) return
  await ensureTab(KLING_ANALYSIS_TAB, KLING_ANALYSIS_HEADERS)

  const viral = await lookupViral(opts.sourceUrl)
  const existing = await readRange(KLING_ANALYSIS_TAB, 'A:B')
  const rowNumber = findAnalysisRowNumber(existing, opts.jobId)
  const addedAt = rowNumber
    ? (existing[rowNumber - 1]?.[1] || opts.addedAt || new Date().toISOString())
    : (opts.addedAt || new Date().toISOString())

  const values = [buildAnalysisSheetRow({
    jobId: opts.jobId,
    addedAt,
    sourceUrl: opts.sourceUrl,
    viral,
    durationSec: opts.durationSec,
    context: opts.context,
    masterPrompt: opts.masterPrompt,
    status: opts.status,
    klingVideoUrl: opts.klingVideoUrl,
  })]

  if (rowNumber) {
    const res = await sheetsRequest(
      `${SHEET_ID}/values/${encodeURIComponent(`${KLING_ANALYSIS_TAB}!A${rowNumber}:P${rowNumber}`)}?valueInputOption=RAW`,
      { method: 'PUT', body: JSON.stringify({ values }) },
    )
    if (!res.ok) throw new Error(`Failed to update analysis row: ${res.status} ${await res.text()}`)
    return
  }

  const res = await sheetsRequest(
    `${SHEET_ID}/values/${encodeURIComponent(`${KLING_ANALYSIS_TAB}!A:P`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: JSON.stringify({ values }) },
  )
  if (!res.ok) throw new Error(`Failed to append analysis row: ${res.status} ${await res.text()}`)
}

export async function appendKlingIdeasSheet(opts: {
  ideas: HashedIdea[]
  sourceUrl: string
  jobId: string | null
}): Promise<void> {
  if (!SHEET_ID || !opts.ideas.length) return
  await ensureTab(KLING_IDEAS_TAB, KLING_IDEA_HEADERS)

  const hashCol = await readRange(KLING_IDEAS_TAB, 'A:H')
  const fresh = ideasNotAlreadyInSheet(opts.ideas, existingIdeaHashes(hashCol))
  if (!fresh.length) return

  const viral = await lookupViral(opts.sourceUrl)
  const addedAt = new Date().toISOString()
  const values = fresh.map(idea => buildIdeaSheetRow({
    addedAt,
    idea,
    sourceUrl: opts.sourceUrl,
    viral,
    jobId: opts.jobId,
  }))

  const res = await sheetsRequest(
    `${SHEET_ID}/values/${encodeURIComponent(`${KLING_IDEAS_TAB}!A:J`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: JSON.stringify({ values }) },
  )
  if (!res.ok) throw new Error(`Failed to append idea rows: ${res.status} ${await res.text()}`)
}

export async function syncKlingAnalysisSheetSafe(opts: Parameters<typeof upsertKlingAnalysisSheet>[0]): Promise<void> {
  try {
    await upsertKlingAnalysisSheet(opts)
  } catch (err) {
    console.error('[kling-recreate] sheet analysis sync failed:', err)
  }
}

export async function syncKlingIdeasSheetSafe(opts: Parameters<typeof appendKlingIdeasSheet>[0]): Promise<void> {
  try {
    await appendKlingIdeasSheet(opts)
  } catch (err) {
    console.error('[kling-recreate] sheet ideas sync failed:', err)
  }
}
