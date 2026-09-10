import { NextRequest, NextResponse } from 'next/server'
import { one } from '@/lib/db'
import { getGoogleAccessToken } from '@/lib/google-auth'
import { callGrok, base64ImageContent, GROK_FAST } from '@/lib/grok'
import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import os from 'os'
import fs from 'fs'

const execFileAsync = promisify(execFile)
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'C:\\Users\\naeem\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe'
const GRAPH_API = 'https://graph.facebook.com/v25.0'

const CAPTION_PROMPT = `This is the first frame of a short vertical Reel video for a Facebook Page. Write a short, catchy Facebook caption (1-2 sentences, can include 1-2 relevant emojis, max 2 hashtags) based on what you see in this image. Return ONLY the caption text, nothing else.`

// Auto-scheduled items (drawn straight from Drive, never touched the bulk
// upload form) land here with an empty caption — generate one from the
// video's first frame right before publishing rather than at schedule time,
// since by now the raw file is already downloaded and every item that does
// get a manual caption (via the upload route or hand-edited in the queue)
// skips this entirely.
async function generateCaptionFromFrame(videoPath: string): Promise<string> {
  const framePath = path.join(os.tmpdir(), `fb_caption_frame_${Date.now()}.jpg`)
  try {
    await execFileAsync(FFMPEG_BIN, ['-y', '-i', videoPath, '-vframes', '1', '-q:v', '2', framePath])
    const frameB64 = fs.readFileSync(framePath).toString('base64')
    const caption = await callGrok({
      model: GROK_FAST,
      messages: [{ role: 'user', content: [{ type: 'text', text: CAPTION_PROMPT }, base64ImageContent(frameB64)] }],
      maxTokens: 200,
      temperature: 0.8,
    })
    return caption.trim()
  } catch (err) {
    console.error('[fb publish-reel] caption generation failed:', err)
    return ''
  } finally {
    if (fs.existsSync(framePath)) fs.unlinkSync(framePath)
  }
}

async function transcodeForReels(inputPath: string, outputPath: string): Promise<void> {
  await execFileAsync(FFMPEG_BIN, [
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

async function startUpload(pageId: string, token: string): Promise<{ videoId: string; uploadUrl: string }> {
  const res = await fetch(`${GRAPH_API}/${pageId}/video_reels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ upload_phase: 'start', access_token: token }),
  })
  const data = await res.json()
  console.log('[fb publish-reel] start upload:', JSON.stringify(data))
  if (!res.ok || !data.video_id || !data.upload_url) {
    throw new Error(data.error?.message ?? `Start upload failed (${res.status}): ${JSON.stringify(data)}`)
  }
  return { videoId: data.video_id as string, uploadUrl: data.upload_url as string }
}

async function uploadVideoBinary(uploadUrl: string, token: string, videoBuffer: Buffer): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': `OAuth ${token}`,
      'offset': '0',
      'file_size': String(videoBuffer.length),
      'Content-Type': 'application/octet-stream',
    },
    body: new Uint8Array(videoBuffer),
  })
  const data = await res.json()
  console.log('[fb publish-reel] upload binary:', JSON.stringify(data))
  if (!res.ok || data.success !== true) {
    throw new Error(data.error?.message ?? `Video upload failed (${res.status}): ${JSON.stringify(data)}`)
  }
}

async function finishUpload(
  pageId: string,
  token: string,
  videoId: string,
  description: string,
): Promise<void> {
  const body: Record<string, string> = {
    upload_phase: 'finish',
    video_id: videoId,
    description,
    access_token: token,
    video_state: 'PUBLISHED',
  }

  const res = await fetch(`${GRAPH_API}/${pageId}/video_reels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  console.log('[fb publish-reel] finish upload:', JSON.stringify(data))
  if (!res.ok || data.success !== true) {
    throw new Error(data.error?.message ?? `Finish upload failed (${res.status}): ${JSON.stringify(data)}`)
  }
}

async function waitForProcessing(videoId: string, token: string, maxAttempts = 60, intervalMs = 5000): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs))
    const res = await fetch(`${GRAPH_API}/${videoId}?fields=status&access_token=${token}`)
    const data = await res.json()
    const phase = data.status?.video_status
    console.log(`[fb publish-reel] processing status: ${phase}`)
    if (phase === 'ready') return
    if (phase === 'error') throw new Error(`Video processing error: ${JSON.stringify(data.status)}`)
  }
  throw new Error('Video processing timed out (5 minutes)')
}

export async function POST(req: NextRequest) {
  let tempVideoPath: string | null = null
  let tempTranscodedPath: string | null = null

  try {
    const { queueItemId } = await req.json()
    if (!queueItemId) return NextResponse.json({ error: 'queueItemId required' }, { status: 400 })

    // Atomic claim: the old SELECT-then-UPDATE here raced two callers that
    // both pass the SELECT before either flips the row — a real risk once a
    // second process (e.g. the VPS's own PM2-managed server) is also
    // ticking this same queue on the same schedule. Folding the pending
    // check into the UPDATE's WHERE clause means only one caller's UPDATE
    // ever actually matches a row, so only one caller proceeds — same
    // claim pattern generation_queue jobs already use elsewhere in
    // cron/tick.
    const claimed = await one<{ id: string }>(
      `UPDATE facebook_queue SET status='publishing' WHERE id=$1 AND status='pending' RETURNING id`,
      [queueItemId],
    )
    if (!claimed) return NextResponse.json({ error: 'Queue item not found or not pending' }, { status: 404 })

    const item = await one<{
      id: string
      drive_file_id: string | null
      filename: string
      caption: string
      page_id: string
      access_token: string
    }>(
      `SELECT q.id, q.drive_file_id, q.filename, q.caption,
              p.page_id, p.access_token
       FROM facebook_queue q JOIN facebook_pages p ON p.id = q.page_id
       WHERE q.id=$1`,
      [queueItemId],
    )
    if (!item) throw new Error('Queue item vanished after being claimed')
    if (!item.drive_file_id) throw new Error('No drive_file_id — cannot download video')

    try {
      const accessToken = await getGoogleAccessToken()
      const driveRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${item.drive_file_id}?alt=media`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      if (!driveRes.ok) throw new Error(`Drive download failed: ${driveRes.status}`)
      const videoBuffer = Buffer.from(await driveRes.arrayBuffer())

      tempVideoPath = path.join(os.tmpdir(), `fb_src_${queueItemId}.mp4`)
      tempTranscodedPath = path.join(os.tmpdir(), `fb_out_${queueItemId}.mp4`)
      fs.writeFileSync(tempVideoPath, videoBuffer)

      let caption = item.caption?.trim() ?? ''
      if (!caption) {
        console.log('[fb publish-reel] No caption set — generating one from the first frame via Grok...')
        caption = await generateCaptionFromFrame(tempVideoPath)
        if (caption) {
          await one(`UPDATE facebook_queue SET caption=$1 WHERE id=$2`, [caption, queueItemId])
        }
      }

      console.log('[fb publish-reel] Transcoding...')
      await transcodeForReels(tempVideoPath, tempTranscodedPath)
      const transcodedBuffer = fs.readFileSync(tempTranscodedPath)
      console.log(`[fb publish-reel] Transcoded: ${(transcodedBuffer.length / 1024 / 1024).toFixed(1)}MB`)

      const { videoId, uploadUrl } = await startUpload(item.page_id, item.access_token)
      await uploadVideoBinary(uploadUrl, item.access_token, transcodedBuffer)

      // Scheduling itself is handled by facebook_queue.scheduled_at + cron/tick
      // (same model as instagram_queue) — by the time this route runs, the
      // item is already due, so it always publishes immediately here.
      await finishUpload(item.page_id, item.access_token, videoId, caption)
      await waitForProcessing(videoId, item.access_token)

      console.log(`[fb publish-reel] Done, video_id: ${videoId}`)

      await one(
        `UPDATE facebook_queue SET status='done', facebook_video_id=$1, published_at=NOW() WHERE id=$2`,
        [videoId, queueItemId],
      )

      return NextResponse.json({ ok: true, videoId })
    } catch (innerErr) {
      await one(
        `UPDATE facebook_queue SET status='failed', error_message=$1 WHERE id=$2`,
        [String(innerErr), queueItemId],
      )
      throw innerErr
    }
  } catch (err) {
    console.error('[fb publish-reel]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  } finally {
    if (tempVideoPath && fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath)
    if (tempTranscodedPath && fs.existsSync(tempTranscodedPath)) fs.unlinkSync(tempTranscodedPath)
  }
}
