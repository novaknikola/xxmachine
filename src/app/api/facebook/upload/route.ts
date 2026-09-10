import { NextRequest, NextResponse } from 'next/server'
import { one } from '@/lib/db'
import { uploadBufferToDriveFolder } from '@/lib/google-drive'
import { nextFacebookSlot } from '@/lib/facebook/auto-schedule'
import { extractFirstFrame, makeThumbnailDataUri, generateCaptionFromFrame } from '@/lib/facebook/enrich'
import path from 'path'
import os from 'os'
import fs from 'fs'
import crypto from 'crypto'

export async function POST(req: NextRequest) {
  const form = await req.formData()
  const pageId = form.get('pageId') as string | null
  const category = (form.get('category') as string | null)?.trim() || null
  const files = form.getAll('files') as File[]

  if (!pageId) return NextResponse.json({ error: 'pageId required' }, { status: 400 })
  if (!files.length) return NextResponse.json({ error: 'no files provided' }, { status: 400 })

  const page = await one<{ id: string; google_drive_folder_id: string | null }>(
    `SELECT id, google_drive_folder_id FROM facebook_pages WHERE id=$1`,
    [pageId],
  )
  if (!page) return NextResponse.json({ error: 'page not found' }, { status: 404 })
  if (!page.google_drive_folder_id) {
    return NextResponse.json({ error: 'This page has no Drive folder configured yet' }, { status: 400 })
  }

  const results: Array<{ filename: string; ok: boolean; caption?: string; scheduledAt?: string; error?: string }> = []

  // Each upload lands with everything already decided — caption, thumbnail,
  // and its slot in the 3/day rotation — so there's no separate "mass
  // schedule" step left to run before it's a real planner entry.
  let slotOffset = 0

  for (const file of files) {
    let tempPath: string | null = null
    try {
      const buffer = Buffer.from(await file.arrayBuffer())
      tempPath = path.join(os.tmpdir(), `fb_upload_${crypto.randomUUID()}.mp4`)
      fs.writeFileSync(tempPath, buffer)

      const [driveResult, frame, scheduledAt] = await Promise.all([
        uploadBufferToDriveFolder(page.google_drive_folder_id, file.name, buffer, 'video/mp4'),
        extractFirstFrame(tempPath),
        nextFacebookSlot(page.id, slotOffset),
      ])
      slotOffset++

      const [caption, thumbnailUrl] = await Promise.all([
        generateCaptionFromFrame(frame),
        makeThumbnailDataUri(frame),
      ])

      await one(
        `INSERT INTO facebook_queue (page_id, drive_file_id, filename, caption, category, thumbnail_url, scheduled_at, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')`,
        [page.id, driveResult.id, file.name, caption, category, thumbnailUrl, scheduledAt.toISOString()],
      )

      results.push({ filename: file.name, ok: true, caption, scheduledAt: scheduledAt.toISOString() })
    } catch (err) {
      console.error('[facebook/upload]', file.name, err)
      results.push({ filename: file.name, ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
    }
  }

  return NextResponse.json({ results })
}
