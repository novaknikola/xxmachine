import { NextRequest, NextResponse } from 'next/server'
import { rows, query, one } from '@/lib/db'
import { callGrok, GROK_SMART } from '@/lib/grok'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params

    const fan = await one<{ name: string; age: number | null; location: string | null; occupation: string | null; totalSpendCents: number; notes: string }>(
      `SELECT name, age, location, occupation, total_spend_cents AS "totalSpendCents", notes FROM fans WHERE id = $1`,
      [id],
    )
    if (!fan) return NextResponse.json({ error: 'Fan not found' }, { status: 404 })

    const messages = await rows<{ text: string; isCreator: boolean }>(
      `SELECT text, is_creator AS "isCreator"
       FROM fan_messages WHERE fan_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [id],
    )
    const recentMessages = messages.reverse()

    const msgText = recentMessages.length
      ? recentMessages.map(m => `${m.isCreator ? 'Creator' : 'Fan'}: ${m.text}`).join('\n')
      : '(no messages yet)'

    const body = await req.json().catch(() => ({}))
    const characterStory = body.characterStory ?? ''

    const text = await callGrok({
      model: GROK_SMART,
      system: `You are an expert OnlyFans/Fanvue agency coach. ${characterStory ? `The creator's story: ${characterStory}` : ''}

Analyze the fan's chat history and profile, then return a JSON object matching this TypeScript type exactly:
{
  "paydayPattern": string | null,
  "preferences": string[],
  "mood": string,
  "lastOfferResponse": string,
  "conversationTone": string,
  "keyFacts": string[],
  "dailyHooks": string[],
  "weeklyStrategy": string
}

Return ONLY the raw JSON, no markdown, no explanation.`,
      messages: [{
        role: 'user',
        content: `Fan: ${fan.name}${fan.age ? `, ${fan.age}yo` : ''}${fan.location ? `, ${fan.location}` : ''}${fan.occupation ? `, ${fan.occupation}` : ''}
Total spend: $${(fan.totalSpendCents / 100).toFixed(0)}
Notes: ${fan.notes || 'none'}

Recent conversation:
${msgText}`,
      }],
      maxTokens: 800,
      temperature: 0.4,
      json: true,
    })

    let aiSummary
    try {
      aiSummary = JSON.parse(text)
    } catch {
      return NextResponse.json({ error: 'Failed to parse AI response', raw: text }, { status: 500 })
    }

    await query(
      'UPDATE fans SET ai_summary = $1, ai_summary_at = now() WHERE id = $2',
      [JSON.stringify(aiSummary), id],
    )

    return NextResponse.json({ aiSummary })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
