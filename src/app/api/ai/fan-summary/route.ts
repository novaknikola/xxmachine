import { NextRequest, NextResponse } from 'next/server'
import type { AiSummary } from '@/lib/types'
import { callGrok, GROK_SMART } from '@/lib/grok'

interface ChatMessageLite {
  fromCreator: boolean
  text: string
  sentAt: string | null
  hasMedia?: boolean
  type?: string | null
  ppvCents?: number
  purchased?: boolean
}

interface FanContext {
  displayName?: string
  handle?: string
  status?: string
  lifetimeGrossCents?: number
  lastPurchaseAt?: string
  subscriptionCreatedAt?: string
  spendingSources?: Record<string, number>
}

const SYSTEM = `You are an expert OnlyFans/Fanvue chat strategist analyzing one fan's conversation history with a creator.
You produce a structured JSON summary that helps a chatter craft personalized, high-conversion messages.
You read between the lines — payment patterns, language tone, what the fan asks for, what they ignored, and what they reveal about their life.
You never invent facts. If the conversation doesn't show payday/preferences/etc, leave those fields empty arrays or null.

OUTPUT — STRICT JSON with this exact shape, no prose, no markdown:
{
  "paydayPattern": string or null,
  "preferences": [string],
  "mood": string,
  "lastOfferResponse": string or null,
  "conversationTone": string,
  "keyFacts": [string],
  "dailyHooks": [string],
  "weeklyStrategy": string
}`

function buildUserPrompt(fan: FanContext, messages: ChatMessageLite[]): string {
  const fanLine = `Fan: ${fan.displayName ?? '(no name)'}${fan.handle ? ` · @${fan.handle}` : ''}`
  const stats: string[] = []
  if (fan.lifetimeGrossCents != null) stats.push(`Lifetime spend $${(fan.lifetimeGrossCents / 100).toFixed(2)}`)
  if (fan.status) stats.push(`Status ${fan.status}`)
  if (fan.subscriptionCreatedAt) stats.push(`Subscribed since ${fan.subscriptionCreatedAt}`)
  if (fan.lastPurchaseAt) stats.push(`Last purchase ${fan.lastPurchaseAt}`)
  if (fan.spendingSources) {
    const src = Object.entries(fan.spendingSources)
      .map(([k, v]) => `${k}=$${(v / 100).toFixed(0)}`).join(', ')
    if (src) stats.push(`Sources: ${src}`)
  }
  const transcript = messages.map(m => {
    const who = m.fromCreator ? 'CREATOR' : 'FAN'
    const meta: string[] = []
    if (m.ppvCents) meta.push(`[PPV $${(m.ppvCents / 100).toFixed(2)}${m.purchased ? ' BOUGHT' : ' offered'}]`)
    if (m.hasMedia) meta.push(m.purchased === false ? '[media offered]' : '[media]')
    return `${who}${meta.length ? ' ' + meta.join(' ') : ''}: ${m.text || '(empty)'}`
  }).join('\n')

  return `${fanLine}
${stats.join(' · ') || '(no stats)'}

CHAT TRANSCRIPT (oldest first, ${messages.length} messages):
${transcript}

Produce the JSON summary now.`
}

function extractJsonObject(raw: string): unknown {
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  try { return JSON.parse(cleaned) } catch {}
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)) } catch {}
  }
  throw new Error(`Model did not return JSON: ${cleaned.slice(0, 200)}`)
}

function normalizeSummary(parsed: unknown): AiSummary {
  const p = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
  const arr = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 10) : []
  const str = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v.trim() : undefined
  return {
    paydayPattern: str(p.paydayPattern) ?? null,
    preferences: arr(p.preferences),
    mood: str(p.mood),
    lastOfferResponse: str(p.lastOfferResponse),
    conversationTone: str(p.conversationTone),
    keyFacts: arr(p.keyFacts),
    dailyHooks: arr(p.dailyHooks).slice(0, 3),
    weeklyStrategy: str(p.weeklyStrategy),
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as {
    fan?: FanContext
    messages?: ChatMessageLite[]
  } | null
  if (!body?.fan || !Array.isArray(body.messages)) {
    return NextResponse.json({ error: 'missing fan or messages' }, { status: 400 })
  }
  if (body.messages.length === 0) {
    return NextResponse.json({
      ok: true,
      summary: {
        paydayPattern: null,
        preferences: [],
        keyFacts: [],
        dailyHooks: [
          'Hey love — how was your day?',
          'I was thinking about you earlier 😘',
          'You up to anything fun this week?',
        ],
        weeklyStrategy: 'No chat history yet — open with a soft check-in to start a thread.',
      } satisfies AiSummary,
    })
  }

  try {
    const text = await callGrok({
      model: GROK_SMART,
      system: SYSTEM,
      messages: [{ role: 'user', content: buildUserPrompt(body.fan, body.messages) }],
      maxTokens: 4096,
      temperature: 0.4,
      json: true,
    })
    const parsed = extractJsonObject(text)
    const summary = normalizeSummary(parsed)
    return NextResponse.json({ ok: true, summary })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    )
  }
}
