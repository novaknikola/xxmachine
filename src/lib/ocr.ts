import { readFileSync, unlinkSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { callGrok, GROK_FAST, base64ImageContent } from './grok'

const execFileAsync = promisify(execFile)

const OCR_PROMPT = `Read ONLY the text that is visibly written or overlaid on this video frame — burned-in captions, subtitles, meme text, on-screen graphics, UI labels, etc.

Output the exact text verbatim, preserving line breaks where they appear on screen, and include any emoji exactly as shown. Do not describe the image or add any commentary.

If there is no visible on-screen text, respond with exactly: (no on-screen text detected)`

/** Grabs a frame ~1s into the video and reads any burned-in on-screen text via Grok vision. */
export async function extractOnScreenText(inputPath: string): Promise<string> {
  const framePath = join(tmpdir(), `ocr_frame_${randomUUID()}.jpg`)

  try {
    await execFileAsync('ffmpeg', [
      '-y', '-i', inputPath, '-ss', '1', '-vframes', '1', '-q:v', '2', framePath,
    ])
    if (!existsSync(framePath)) throw new Error('Frame extraction failed')

    const imageBase64 = readFileSync(framePath).toString('base64')

    const text = await callGrok({
      model: GROK_FAST,
      messages: [{
        role: 'user',
        content: [base64ImageContent(imageBase64), { type: 'text', text: OCR_PROMPT }],
      }],
      maxTokens: 512,
      temperature: 0.1,
    })

    return text.trim() || '(no on-screen text detected)'
  } finally {
    try { if (existsSync(framePath)) unlinkSync(framePath) } catch {}
  }
}
