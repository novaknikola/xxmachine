import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { one } from '@/lib/db'
import { syncFacebookPageFromDrive } from '@/lib/facebook/auto-schedule'
import { enrichPendingFacebookQueueItems } from '@/lib/facebook/enrich'

/**
 * Manual catch-up for files added straight to the page's Drive folder
 * outside the app's own upload button — queues everything not already in
 * facebook_queue instead of waiting for the daily cron to trickle them in
 * 3 at a time. The insert itself is fast (just a Drive listing + DB
 * writes); caption+thumbnail generation for the newly-created rows runs
 * afterward via next/server's after() — confirmed live 2026-09-09 that a
 * plain un-awaited call here (the fire-and-forget pattern cron/tick uses
 * for its own background jobs) never actually ran: App Router tears down
 * work tied to a request's execution context once the response is sent
 * unless it's registered with after(), and this route returns almost
 * immediately after kicking the enrichment off, giving it no window to
 * make progress before that teardown. cron/tick's own fire-and-forget
 * calls get away with it only because the request stays open doing more
 * awaited work for another 50-90s first.
 */
export async function POST(req: NextRequest) {
  try {
    const { pageId } = await req.json()
    if (!pageId) return NextResponse.json({ error: 'pageId required' }, { status: 400 })

    const page = await one<{ id: string; google_drive_folder_id: string | null }>(
      `SELECT id, google_drive_folder_id FROM facebook_pages WHERE id=$1`,
      [pageId],
    )
    if (!page) return NextResponse.json({ error: 'page not found' }, { status: 404 })
    if (!page.google_drive_folder_id) {
      return NextResponse.json({ error: 'This page has no Drive folder configured yet' }, { status: 400 })
    }

    const created = await syncFacebookPageFromDrive(page.id, page.google_drive_folder_id)

    after(() =>
      enrichPendingFacebookQueueItems(page.id).catch(err =>
        console.error('[facebook/sync-drive] enrichment error:', err),
      ),
    )

    return NextResponse.json({ created })
  } catch (err) {
    console.error('[facebook/sync-drive]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
