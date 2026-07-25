import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { one } from '@/lib/db'

function clean(value: unknown): string {
  return String(value ?? '').trim()
}

function extractDriveFileId(url: string): string | null {
  if (!url) return null

  const patterns = [
    /\/d\/([a-zA-Z0-9_-]+)/,
    /id=([a-zA-Z0-9_-]+)/,
    /file\/d\/([a-zA-Z0-9_-]+)/,
  ]

  for (const pattern of patterns) {
    const match = url.match(pattern)
    if (match?.[1]) return match[1]
  }

  return null
}

async function getMappedAccountId(sheetName: string, fallbackAccountName: string): Promise<string | null> {
  const mapped = await one<{ instagram_account_id: string | null }>(
    `SELECT instagram_account_id
     FROM content_source_mappings
     WHERE lower(sheet_name) = lower($1)
       AND active = true
     LIMIT 1`,
    [sheetName],
  )

  if (mapped?.instagram_account_id) {
    return mapped.instagram_account_id
  }

  // Backward compatibility: if an old workbook row still directly matches an account,
  // allow it to import while the new mapping system is being used.
  const account = await one<{ id: string }>(
    `SELECT id
     FROM instagram_accounts
     WHERE lower(name)=lower($1)
        OR lower(ig_username)=lower($1)
     LIMIT 1`,
    [fallbackAccountName],
  )

  return account?.id ?? null
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get('file')

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'file required' }, { status: 400 })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true })

    let inserted = 0
    const skipped: Array<{ sheet: string; row: number; reason: string }> = []
    const unassignedSheets = new Set<string>()

    for (const sheetName of workbook.SheetNames) {
      if (sheetName.toLowerCase() === 'all urls') continue

      const sheet = workbook.Sheets[sheetName]
      const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: '',
      })

      // Make sure every workbook sheet exists as a content source, even if it is not assigned yet.
      await one(
        `INSERT INTO content_source_mappings (sheet_name)
         VALUES ($1)
         ON CONFLICT (sheet_name) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [sheetName],
      )

      for (let i = 0; i < records.length; i++) {
        const row = records[i]
        const rowNumber = i + 2

        const content = clean(row['Content'])
        const postTitle = clean(row['Post Title'])
        const firstComment = clean(row['First Comment'])
        const videoUrl = clean(row['Video URL'])
        const imageUrl = clean(row['Image URL'])
        const category = clean(row['Category Name'])
        const socialAccountName = clean(row['Social Account Name']) || sheetName
        const platform = clean(row['Platform']).toLowerCase()
        const dateTimeRaw = row['Date Time']

        if (!content && !postTitle && !firstComment && !videoUrl && !imageUrl) {
          continue
        }

        if (platform && !platform.includes('instagram')) {
          skipped.push({ sheet: sheetName, row: rowNumber, reason: `platform not instagram: ${platform}` })
          continue
        }

        const driveFileId = extractDriveFileId(videoUrl || imageUrl)
        if (!driveFileId) {
          skipped.push({ sheet: sheetName, row: rowNumber, reason: 'missing drive file id from Video URL/Image URL' })
          continue
        }

        const accountId = await getMappedAccountId(sheetName, socialAccountName)

        if (!accountId) {
          unassignedSheets.add(sheetName)
          skipped.push({
            sheet: sheetName,
            row: rowNumber,
            reason: `content source not assigned to Instagram account: ${sheetName}`,
          })
          continue
        }

        let scheduledAt: string | null = null
        if (dateTimeRaw instanceof Date) {
          scheduledAt = dateTimeRaw.toISOString()
        } else if (clean(dateTimeRaw)) {
          const parsed = new Date(clean(dateTimeRaw))
          if (!Number.isNaN(parsed.getTime())) scheduledAt = parsed.toISOString()
        }

        const caption = [content, postTitle, firstComment].filter(Boolean).join('\n\n')

        const insertedRow = await one<{ id: string }>(
          `INSERT INTO instagram_queue
            (account_id, drive_file_id, filename, caption, scheduled_at, category)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            accountId,
            driveFileId,
            `${sheetName}-${rowNumber}`,
            caption,
            scheduledAt,
            category || null,
          ],
        )

        if (insertedRow) inserted++
      }
    }

    return NextResponse.json({
      ok: true,
      inserted,
      skippedCount: skipped.length,
      unassignedSheets: Array.from(unassignedSheets),
      skippedPreview: skipped.slice(0, 25),
      message: unassignedSheets.size
        ? 'Some content sources are not assigned to Instagram accounts yet. Assign them in content source mappings, then re-import.'
        : 'Spreadsheet imported successfully.',
    })
  } catch (err) {
    console.error('[spreadsheet/import-xlsx]', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
