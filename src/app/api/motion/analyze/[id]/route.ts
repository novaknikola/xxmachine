import { NextRequest, NextResponse } from 'next/server'
import { one, query } from '@/lib/db'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ViralReel } from '@/lib/types'
import { callGrok, GROK_SMART, base64ImageContent } from '@/lib/grok'

const execFileAsync = promisify(execFile)

const SYSTEM_PROMPT = `You are analyzing an Instagram Reel frame to generate a detailed image generation prompt.

Your goal: write a rich, detailed prompt so that AI can place a DIFFERENT person in the EXACT SAME scene — same angle, same setting, same pose, same outfit style.

You MUST describe all 4 elements with full detail:

1. CAMERA ANGLE (most important — be very precise):
   - Distance: close-up / medium shot / full body / waist-up / etc.
   - Angle: front-facing / 3/4 from left / side profile / slightly above / low angle / eye level / POV
   - Framing: centered / off-center / cropped at waist / etc.

2. SETTING & AMBIANCE (be specific):
   - Location: bedroom / outdoor park / beach / café / gym / car / street / etc.
   - Background: blurred / sharp / what's visible
   - Lighting: golden hour sunlight / soft window light / warm indoor lamp / harsh overhead / ring light glow / etc.
   - Overall mood: cozy / energetic / moody / bright / cinematic

3. POSE (describe precisely):
   - Body position and what person is doing
   - Arms/hands placement
   - Head tilt and direction of gaze
   Example: "Standing slightly turned, right hand on hip, looking directly at camera with relaxed expression"

4. CLOTHING (describe everything visible):
   - Garment types, colors, style, fit
   - Visible accessories
   Example: "Wearing a fitted white ribbed tank top, low-rise light wash jeans, small gold hoop earrings"

RULES:
- DO NOT describe face features, hair color, skin tone, eye color, ethnicity
- DO include specific colors, textures, materials you can see
- Write minimum 80 words

OUTPUT: One flowing paragraph combining all 4 elements. Start with the camera angle.`

async function extractVideoFrame(videoUrl: string, reelId: number): Promise<string | null> {
  const videoPath = join(tmpdir(), `motion_vid_${reelId}.mp4`)
  const framePath = join(tmpdir(), `motion_frame_${reelId}.jpg`)
  try {
    const res = await fetch(videoUrl, {
      headers: { Range: 'bytes=0-5000000' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(videoPath, buf)
    await execFileAsync('ffmpeg', [
      '-y', '-i', videoPath, '-ss', '1.5', '-vframes', '1', '-q:v', '2', framePath,
    ]).catch(err => { throw err })
    if (!existsSync(framePath)) return null
    return readFileSync(framePath).toString('base64')
  } catch {
    return null
  } finally {
    try { if (existsSync(videoPath)) unlinkSync(videoPath) } catch {}
    try { if (existsSync(framePath)) unlinkSync(framePath) } catch {}
  }
}

async function fetchImageAsBase64(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`)
  const contentLength = res.headers.get('content-length')
  if (contentLength && Number(contentLength) > 10_000_000) throw new Error('Image too large')
  const buffer = await res.arrayBuffer()
  if (buffer.byteLength > 10_000_000) throw new Error('Image too large')
  return Buffer.from(buffer).toString('base64')
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const reel = await one<ViralReel>('SELECT * FROM viral_reels WHERE id = $1', [id])
  if (!reel) return NextResponse.json({ error: 'Reel not found' }, { status: 404 })
  if (!['viral_detected', 'approved'].includes(reel.status)) {
    return NextResponse.json({ error: `Cannot analyze reel with status: ${reel.status}` }, { status: 400 })
  }

  try {
    let imageBase64: string | null = null
    let imageSource = 'thumbnail'

    if (reel.video_url) {
      console.log(`[analyze] Extracting frame from video for reel ${id}`)
      imageBase64 = await extractVideoFrame(reel.video_url, Number(id))
      if (imageBase64) imageSource = 'video_frame'
    }
    if (!imageBase64 && reel.thumbnail_url) {
      console.log(`[analyze] Using thumbnail for reel ${id}`)
      imageBase64 = await fetchImageAsBase64(reel.thumbnail_url)
    }
    if (!imageBase64) {
      return NextResponse.json({ error: 'No image available (no thumbnail or video URL)' }, { status: 400 })
    }

    console.log(`[analyze] Sending to Grok (source: ${imageSource})`)

    const prompt = await callGrok({
      model: GROK_SMART,
      messages: [{
        role: 'user',
        content: [
          base64ImageContent(imageBase64),
          { type: 'text', text: SYSTEM_PROMPT },
        ],
      }],
      maxTokens: 2048,
      temperature: 0.4,
    })

    if (!prompt?.trim()) return NextResponse.json({ error: 'Empty response from Grok' }, { status: 502 })

    await query(
      'UPDATE viral_reels SET gemini_prompt = $1, status = $2 WHERE id = $3',
      [prompt.trim(), 'cover_analyzed', id]
    )

    return NextResponse.json({ ok: true, prompt: prompt.trim(), imageSource })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}
