const GROK_URL = 'https://api.x.ai/v1/chat/completions'

export const GROK_FAST = 'grok-build-0.1'   // text + vision, cheaper
export const GROK_SMART = 'grok-4.3'         // vision + complex reasoning, premium

type TextContent = { type: 'text'; text: string }
type ImageContent = { type: 'image_url'; image_url: { url: string } }
type MessageContent = string | Array<TextContent | ImageContent>

export interface GrokMessage {
  role: 'system' | 'user' | 'assistant'
  content: MessageContent
}

interface GrokOptions {
  model?: string
  system?: string
  messages: GrokMessage[]
  maxTokens?: number
  temperature?: number
  json?: boolean
  /** Upper bound for a single call; a hung request must not pin the route forever. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 300_000
const RETRY_DELAY_MS = 3_000

class GrokTransientError extends Error {}

async function callGrokOnce(opts: GrokOptions): Promise<string> {
  const key = process.env.XAI_API_KEY
  if (!key) throw new Error('XAI_API_KEY is not configured')

  const messages: GrokMessage[] = opts.system
    ? [{ role: 'system', content: opts.system }, ...opts.messages]
    : [...opts.messages]

  const body: Record<string, unknown> = {
    model: opts.model ?? GROK_FAST,
    messages,
    max_tokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature ?? 0.7,
  }
  if (opts.json) body.response_format = { type: 'json_object' }

  let res: Response
  try {
    res = await fetch(GROK_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new GrokTransientError('Grok request timed out')
    }
    throw new GrokTransientError(err instanceof Error ? err.message : String(err))
  }

  const data = await res.json()
  if (!res.ok) {
    const message = data?.error?.message ?? `Grok error (${res.status})`
    if (res.status === 429 || res.status >= 500) throw new GrokTransientError(message)
    throw new Error(message)
  }

  const text: string | undefined = data?.choices?.[0]?.message?.content
  if (!text) throw new GrokTransientError('Empty response from Grok')
  return text
}

/** One retry on a transient failure (timeout, network error, 429, 5xx, empty body) — a bad model turn or a blip, not a bad request. */
export async function callGrok(opts: GrokOptions): Promise<string> {
  try {
    return await callGrokOnce(opts)
  } catch (err) {
    if (!(err instanceof GrokTransientError)) throw err
    console.warn('[grok] transient failure, retrying once:', err.message)
    await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
    return await callGrokOnce(opts)
  }
}

export function base64ImageContent(base64: string, mimeType = 'image/jpeg'): ImageContent {
  return { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
}
