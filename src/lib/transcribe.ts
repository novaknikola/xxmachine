import { unlinkSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { groupWordsIntoSegments, type CaptionSegment, type CaptionWord } from './captions'

const execFileAsync = promisify(execFile)

interface HFResponse {
  text?: string
  chunks?: Array<{ text: string; timestamp: [number, number | null] }>
  error?: string
  estimated_time?: number
}

/** Transcribes a local video file with word-level timestamps via HF Whisper, grouped into caption segments. */
export async function transcribeVideoFile(
  inputPath: string,
  hfToken: string,
  maxWords = 4,
  maxDuration = 3.0,
): Promise<CaptionSegment[]> {
  const audioPath = join(tmpdir(), `cap_audio_${randomUUID()}.mp3`)

  try {
    await execFileAsync('ffmpeg', [
      '-y', '-i', inputPath,
      '-vn', '-acodec', 'libmp3lame',
      '-ar', '16000', '-ac', '1', '-b:a', '32k',
      audioPath,
    ])
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    if (raw.includes('does not contain any stream')) {
      throw new Error('No audio track in this video')
    }
    throw new Error('Audio extraction failed')
  }

  const audioBuffer = readFileSync(audioPath)
  try { unlinkSync(audioPath) } catch {}
  const audioBase64 = audioBuffer.toString('base64')

  let hfData: HFResponse | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const hfRes = await fetch(
      'https://router.huggingface.co/hf-inference/models/openai/whisper-large-v3-turbo',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${hfToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputs: audioBase64,
          parameters: { return_timestamps: 'word' },
        }),
        signal: AbortSignal.timeout(180_000),
      },
    )

    if (hfRes.status === 503) {
      const body = await hfRes.json() as HFResponse
      const wait = Math.ceil((body.estimated_time ?? 20) * 1000)
      await new Promise(r => setTimeout(r, Math.min(wait, 40_000)))
      continue
    }

    if (!hfRes.ok) {
      const err = await hfRes.json().catch(() => ({})) as HFResponse
      throw new Error(err.error ?? `HF error ${hfRes.status}`)
    }

    hfData = await hfRes.json() as HFResponse
    break
  }

  if (!hfData) throw new Error('Transcription failed after retries')

  let words: CaptionWord[]

  if (hfData.chunks && hfData.chunks.length > 0) {
    words = hfData.chunks
      .filter(c => c.text.trim())
      .map(c => ({
        text: c.text.trim(),
        start: c.timestamp[0] ?? 0,
        end: c.timestamp[1] ?? (c.timestamp[0] ?? 0) + 0.5,
      }))
  } else if (hfData.text) {
    const wordList = hfData.text.trim().split(/\s+/).filter(Boolean)
    const estDuration = wordList.length * 0.4
    words = wordList.map((w, i) => ({
      text: w,
      start: (i / wordList.length) * estDuration,
      end: ((i + 1) / wordList.length) * estDuration,
    }))
  } else {
    throw new Error('No transcription returned from HF')
  }

  return groupWordsIntoSegments(words, maxWords, maxDuration)
}
