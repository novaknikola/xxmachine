import { NextRequest, NextResponse } from 'next/server'
import { callGrok, GROK_FAST } from '@/lib/grok'

export async function POST(req: NextRequest) {
  try {
    const { prompt, slideCount, characterStory } = await req.json()

    if (!prompt || !slideCount) {
      return NextResponse.json({ error: 'prompt and slideCount required' }, { status: 400 })
    }

    const system = `You are a social media caption writer for Instagram Reels and TikTok carousels.${characterStory ? ` Creator context: ${characterStory}` : ''}

Generate exactly ${slideCount} short overlay captions for a carousel post. Each caption should be 3-7 words max, punchy, and work as text overlaid on a photo. They should flow together as a story or theme.

Return ONLY a JSON array of strings, no other text. Example: ["Caption one", "Caption two", "Caption three"]`

    const text = await callGrok({
      model: GROK_FAST,
      system,
      messages: [{ role: 'user', content: `Generate ${slideCount} captions for a carousel about: ${prompt}` }],
      maxTokens: 400,
      temperature: 0.8,
      json: true,
    })

    let captions: string[]
    try {
      captions = JSON.parse(text)
    } catch {
      return NextResponse.json({ error: 'Failed to parse captions', raw: text }, { status: 500 })
    }

    return NextResponse.json({ captions })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
