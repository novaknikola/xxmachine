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
}

export async function callGrok(opts: GrokOptions): Promise<string> {
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

  const res = await fetch(GROK_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  const data = await res.json()
  if (!res.ok) throw new Error(data?.error?.message ?? `Grok error (${res.status})`)

  const text: string | undefined = data?.choices?.[0]?.message?.content
  if (!text) throw new Error('Empty response from Grok')
  return text
}

export function base64ImageContent(base64: string, mimeType = 'image/jpeg'): ImageContent {
  return { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
}
