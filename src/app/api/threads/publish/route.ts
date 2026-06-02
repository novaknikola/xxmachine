import { NextRequest, NextResponse } from 'next/server'
import { one } from '@/lib/db'

export async function POST(req: NextRequest) {
  try {
    const { queueItemId } = await req.json()
    if (!queueItemId) return NextResponse.json({ error: 'queueItemId required' }, { status: 400 })

    const item = await one<{
      id: string
      content: string
      media_url: string | null
      media_type: string
      account_id: string
      access_token: string | null
      threads_user_id: string | null
    }>(
      `SELECT q.*, a.access_token, a.threads_user_id
       FROM threads_queue q JOIN threads_accounts a ON a.id = q.account_id
       WHERE q.id=$1 AND q.status IN ('pending','failed')`,
      [queueItemId]
    )

    if (!item) return NextResponse.json({ error: 'Queue item not found' }, { status: 404 })
    if (!item.access_token || !item.threads_user_id) {
      return NextResponse.json({ error: 'Account not connected — run OAuth first' }, { status: 400 })
    }

    await one(`UPDATE threads_queue SET status='publishing' WHERE id=$1`, [queueItemId])

    try {
      const userId = item.threads_user_id
      const token = item.access_token

      // Step 1: Create media container
      const containerBody: Record<string, string> = {
        media_type: item.media_type,
        text: item.content,
        access_token: token,
      }
      if (item.media_url) {
        if (item.media_type === 'IMAGE') containerBody.image_url = item.media_url
        else if (item.media_type === 'VIDEO') containerBody.video_url = item.media_url
      }

      const containerRes = await fetch(
        `https://graph.threads.net/v1.0/${userId}/threads`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(containerBody),
        }
      )
      const containerData = await containerRes.json()
      if (!containerRes.ok) {
        throw new Error(containerData.error?.message ?? `Container creation failed: ${containerRes.status}`)
      }
      const containerId: string = containerData.id

      // Step 2: Wait for video processing if needed
      if (item.media_type === 'VIDEO') {
        await waitForContainer(userId, containerId, token)
      }

      // Step 3: Publish
      const publishRes = await fetch(
        `https://graph.threads.net/v1.0/${userId}/threads_publish`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ creation_id: containerId, access_token: token }),
        }
      )
      const publishData = await publishRes.json()
      if (!publishRes.ok) {
        throw new Error(publishData.error?.message ?? `Publish failed: ${publishRes.status}`)
      }

      const mediaId: string = publishData.id

      await one(
        `UPDATE threads_queue SET status='done', threads_media_id=$1, published_at=NOW() WHERE id=$2`,
        [mediaId, queueItemId]
      )
      return NextResponse.json({ ok: true, mediaId })
    } catch (innerErr) {
      await one(
        `UPDATE threads_queue SET status='failed', error_message=$1 WHERE id=$2`,
        [String(innerErr), queueItemId]
      )
      throw innerErr
    }
  } catch (err) {
    console.error('[threads/publish]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

async function waitForContainer(
  userId: string,
  containerId: string,
  token: string,
  maxAttempts = 20,
  intervalMs = 3000
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs))
    const res = await fetch(
      `https://graph.threads.net/v1.0/${containerId}?fields=status,error_message&access_token=${token}`
    )
    const data = await res.json()
    if (data.status === 'FINISHED') return
    if (data.status === 'ERROR') throw new Error(`Container error: ${data.error_message ?? 'unknown'}`)
    // PUBLISHED, IN_PROGRESS — keep waiting
  }
  throw new Error('Container processing timed out')
}
