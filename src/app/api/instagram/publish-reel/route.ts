import { NextRequest, NextResponse } from 'next/server'
import { one } from '@/lib/db'
import { getGoogleAccessToken } from '@/lib/google-auth'
import { getIgClient } from '@/lib/ig-private-api'
import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import os from 'os'
import fs from 'fs'

const execFileAsync = promisify(execFile)
const IG_API = 'https://graph.instagram.com/v22.0'
const RUPLOAD = 'https://rupload.facebook.com/ig-api-upload/v22.0'

async function extractCoverFrame(videoPath: string, outputPath: string): Promise<void> {
  await execFileAsync('ffmpeg', ['-y', '-i', videoPath, '-vframes', '1', '-q:v', '2', outputPath])
}

async function publishViaPrivateApi(
  accountId: string,
  videoPath: string,
  caption: string,
): Promise<string> {
  const ig = await getIgClient(accountId)
  const videoBuffer = fs.readFileSync(videoPath)

  const coverPath = videoPath.replace('.mp4', '_cover.jpg')
  try { await extractCoverFrame(videoPath, coverPath) } catch {}
  const coverBuffer = fs.existsSync(coverPath) ? fs.readFileSync(coverPath) : Buffer.alloc(0)
  if (fs.existsSync(coverPath)) fs.unlinkSync(coverPath)

  const result = await ig.publish.video({
    video: videoBuffer,
    coverImage: coverBuffer.length > 0 ? coverBuffer : undefined,
    caption,
  })
  return result.media.id_str ?? String(result.media.id)
}

async function transcodeForInstagram(inputPath: string, outputPath: string): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-movflags', '+faststart',
    outputPath,
  ], { maxBuffer: 512 * 1024 * 1024 })
}

async function uploadVideoToMeta(videoBuffer: Buffer, token: string, igUserId: string): Promise<string> {
  const uploadId = Date.now().toString()
  const res = await fetch(`${RUPLOAD}/${igUserId}`, {
    method: 'POST',
    headers: {
      'Authorization': `OAuth ${token}`,
      'X-Entity-Type': 'video/mp4',
      'X-Entity-Name': `reel_${uploadId}.mp4`,
      'X-Entity-Length': String(videoBuffer.length),
      'Offset': '0',
      'Content-Type': 'application/octet-stream',
    },
    body: videoBuffer,
  })
  const data = await res.json()
  if (!res.ok || !data.video_id) {
    throw new Error(`Upload failed (${res.status}): ${JSON.stringify(data)}`)
  }
  return data.video_id as string
}

async function createReelContainer(
  igUserId: string,
  token: string,
  videoId: string,
  caption: string
): Promise<string> {
  const res = await fetch(`${IG_API}/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      media_type: 'REELS',
      upload_id: videoId,
      caption,
      access_token: token,
    }),
  })
  const data = await res.json()
  if (!res.ok || !data.id) {
    throw new Error(data.error?.message ?? `Container creation failed (${res.status})`)
  }
  return data.id as string
}

async function waitForContainer(
  containerId: string,
  token: string,
  maxAttempts = 60,
  intervalMs = 5000
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs))
    const res = await fetch(
      `${IG_API}/${containerId}?fields=status_code,status&access_token=${token}`
    )
    const data = await res.json()
    console.log(`[publish-reel] container status: ${data.status_code}`)
    if (data.status_code === 'FINISHED') return
    if (data.status_code === 'ERROR') {
      throw new Error(`Container processing error: ${data.status ?? 'unknown'}`)
    }
  }
  throw new Error('Container processing timed out (5 minutes)')
}

async function publishContainer(igUserId: string, containerId: string, token: string): Promise<string> {
  const res = await fetch(`${IG_API}/${igUserId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: containerId, access_token: token }),
  })
  const data = await res.json()
  if (!res.ok || !data.id) {
    throw new Error(data.error?.message ?? `Publish failed (${res.status})`)
  }
  return data.id as string
}

export async function POST(req: NextRequest) {
  let tempVideoPath: string | null = null
  let tempTranscodedPath: string | null = null

  try {
    const { queueItemId } = await req.json()
    if (!queueItemId) return NextResponse.json({ error: 'queueItemId required' }, { status: 400 })

    const item = await one<{
      id: string
      drive_file_id: string | null
      filename: string
      caption: string
      account_id: string
      ig_access_token: string | null
      ig_user_id: string | null
      ig_session: object | null
    }>(
      `SELECT q.id, q.drive_file_id, q.filename, q.caption, q.account_id,
              a.ig_access_token, a.ig_user_id, a.ig_session
       FROM instagram_queue q JOIN instagram_accounts a ON a.id = q.account_id
       WHERE q.id=$1 AND q.status='pending'`,
      [queueItemId]
    )

    if (!item) return NextResponse.json({ error: 'Queue item not found or not pending' }, { status: 404 })

    const useGraphApi = !!(item.ig_access_token && item.ig_user_id)
    const usePrivateApi = !useGraphApi && !!item.ig_session

    if (!useGraphApi && !usePrivateApi) {
      return NextResponse.json({ error: 'Instagram not connected — connect via browser or OAuth first' }, { status: 400 })
    }

    await one(`UPDATE instagram_queue SET status='publishing' WHERE id=$1`, [queueItemId])

    try {
      if (!item.drive_file_id) throw new Error('No drive_file_id — cannot download video')

      const accessToken = await getGoogleAccessToken()
      const driveRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${item.drive_file_id}?alt=media`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      )
      if (!driveRes.ok) throw new Error(`Drive download failed: ${driveRes.status}`)
      const videoBuffer = Buffer.from(await driveRes.arrayBuffer())

      fetch(`https://www.googleapis.com/drive/v3/files/${item.drive_file_id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      }).catch(() => {})

      tempVideoPath = path.join(os.tmpdir(), `ig_src_${queueItemId}.mp4`)
      tempTranscodedPath = path.join(os.tmpdir(), `ig_out_${queueItemId}.mp4`)
      fs.writeFileSync(tempVideoPath, videoBuffer)

      console.log('[publish-reel] Transcoding...')
      await transcodeForInstagram(tempVideoPath, tempTranscodedPath)
      const transcodedBuffer = fs.readFileSync(tempTranscodedPath)
      console.log(`[publish-reel] Transcoded: ${(transcodedBuffer.length / 1024 / 1024).toFixed(1)}MB`)

      let mediaId: string

      if (useGraphApi) {
        console.log('[publish-reel] Publishing via Graph API...')
        const videoId = await uploadVideoToMeta(transcodedBuffer, item.ig_access_token!, item.ig_user_id!)
        console.log(`[publish-reel] video_id: ${videoId}`)
        const containerId = await createReelContainer(item.ig_user_id!, item.ig_access_token!, videoId, item.caption ?? '')
        console.log(`[publish-reel] container_id: ${containerId}`)
        await waitForContainer(containerId, item.ig_access_token!)
        mediaId = await publishContainer(item.ig_user_id!, containerId, item.ig_access_token!)
      } else {
        console.log('[publish-reel] Publishing via Private API (ig_session)...')
        mediaId = await publishViaPrivateApi(item.account_id, tempTranscodedPath!, item.caption ?? '')
      }
      console.log(`[publish-reel] Done, media_id: ${mediaId}`)

      await one(
        `UPDATE instagram_queue SET status='done', instagram_media_id=$1, published_at=NOW() WHERE id=$2`,
        [mediaId, queueItemId]
      )

      return NextResponse.json({ ok: true, mediaId })
    } catch (innerErr) {
      await one(
        `UPDATE instagram_queue SET status='failed', error_message=$1 WHERE id=$2`,
        [String(innerErr), queueItemId]
      )
      throw innerErr
    }
  } catch (err) {
    console.error('[publish-reel]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  } finally {
    if (tempVideoPath && fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath)
    if (tempTranscodedPath && fs.existsSync(tempTranscodedPath)) fs.unlinkSync(tempTranscodedPath)
  }
}
