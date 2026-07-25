import { execFile } from 'child_process'
import { promisify } from 'util'
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { callGrok, GROK_SMART, base64ImageContent } from '@/lib/grok'

const execFileAsync = promisify(execFile)

export const SCENE_PROMPT_SYSTEM = `You are analyzing an Instagram Reel frame to generate a detailed image generation prompt.

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

4. CLOTHING (describe everything visible):
   - Garment types, colors, style, fit
   - Visible accessories

RULES:
- DO NOT describe face features, hair color, skin tone, eye color, ethnicity
- DO include specific colors, textures, materials you can see
- Write minimum 80 words

OUTPUT: One flowing paragraph combining all 4 elements. Start with the camera angle.`

export async function extractVideoFrame(videoUrl: string, tag: string): Promise<string | null> {
  const videoPath = join(tmpdir(), `mon_vid_${tag}.mp4`)
  const framePath = join(tmpdir(), `mon_frame_${tag}.jpg`)
  try {
    const res = await fetch(videoUrl, {
      headers: { Range: 'bytes=0-5000000' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return null
    writeFileSync(videoPath, Buffer.from(await res.arrayBuffer()))
    await execFileAsync('ffmpeg', [
      '-y', '-i', videoPath, '-ss', '1.5', '-vframes', '1', '-q:v', '2', framePath,
    ])
    if (!existsSync(framePath)) return null
    return readFileSync(framePath).toString('base64')
  } catch {
    return null
  } finally {
    try { if (existsSync(videoPath)) unlinkSync(videoPath) } catch {}
    try { if (existsSync(framePath)) unlinkSync(framePath) } catch {}
  }
}

export async function fetchImageAsBase64(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`)
  const buffer = await res.arrayBuffer()
  if (buffer.byteLength > 10_000_000) throw new Error('Image too large')
  return Buffer.from(buffer).toString('base64')
}

export async function extractScenePrompt(opts: {
  videoUrl?: string | null
  thumbnailUrl?: string | null
  tag: string
}): Promise<string> {
  let imageBase64: string | null = null

  if (opts.videoUrl) {
    imageBase64 = await extractVideoFrame(opts.videoUrl, opts.tag)
  }
  if (!imageBase64 && opts.thumbnailUrl) {
    imageBase64 = await fetchImageAsBase64(opts.thumbnailUrl)
  }
  if (!imageBase64) throw new Error('No image available for scene analysis')

  const prompt = await callGrok({
    model: GROK_SMART,
    messages: [{
      role: 'user',
      content: [
        base64ImageContent(imageBase64),
        { type: 'text', text: SCENE_PROMPT_SYSTEM },
      ],
    }],
    maxTokens: 2048,
    temperature: 0.4,
  })

  if (!prompt?.trim()) throw new Error('Empty scene prompt from Grok')
  return prompt.trim()
}

export async function getFrameBase64(opts: {
  videoUrl?: string | null
  thumbnailUrl?: string | null
  tag: string
}): Promise<string> {
  if (opts.videoUrl) {
    const frame = await extractVideoFrame(opts.videoUrl, opts.tag)
    if (frame) return frame
  }
  if (opts.thumbnailUrl) return fetchImageAsBase64(opts.thumbnailUrl)
  throw new Error('No image available')
}
