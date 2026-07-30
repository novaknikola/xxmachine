/** Fish Audio TTS — same contract as InfiniteTalk sheet poller. */

const FISH_TTS_URL = 'https://api.fish.audio/v1/tts'
const FISH_MODEL = process.env.FISH_MODEL || 's2-pro'

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu

export function stripForTts(text: string): string {
  let spoken = text.replace(EMOJI_RE, '').replace(/\s+/g, ' ').trim()
  if (spoken && !/[.!?]$/.test(spoken)) spoken += '.'
  return spoken
}

export async function fishTts(opts: {
  apiKey: string
  voiceId: string
  text: string
  style?: string
}): Promise<Buffer> {
  let spoken = stripForTts(opts.text)
  if (opts.style?.trim()) spoken = `${opts.style.trim()} ${spoken}`
  if (!spoken) throw new Error('Text is empty after stripping emoji')

  const res = await fetch(FISH_TTS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
      model: FISH_MODEL,
    },
    body: JSON.stringify({
      text: spoken,
      reference_id: opts.voiceId,
      format: 'wav',
      normalize: true,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Fish Audio HTTP ${res.status}: ${body.slice(0, 300)}`)
  }
  return Buffer.from(await res.arrayBuffer())
}
