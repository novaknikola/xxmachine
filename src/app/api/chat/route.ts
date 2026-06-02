import { NextRequest, NextResponse } from 'next/server'
import { callGrok, GROK_FAST } from '@/lib/grok'

const SYSTEM = `You are a prompt-craft assistant inside XXmachine, a tool for creating AI-generated social-media content for AI influencers.

Your job:
- Help the user write, refine, brainstorm and translate image prompts for two image models:
  • Wavespeed z-image (text-to-image with LoRA character)
  • Wavespeed Wan 2.7 (image-to-image edit — change angle, pose, styling, outfit)
- All photos must look like the influencer took them herself: front camera selfies, mirror selfies, POV, self-timer. Never suggest professional/studio photography wording.
- Keep prompts concrete, visual, short (1-3 sentences). Describe what is in the frame, not the story.
- When the user pastes a draft prompt, return an improved version plus a one-line explanation of what changed.
- Reply in the same language the user is writing (English, Serbian, Bosnian, etc.).
- Never refuse SFW lifestyle prompts. For NSFW edits, stay tasteful — lingerie / sensual ok, no explicit acts.

Format: short, scannable. Use a code block when returning a final prompt.`

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export async function POST(req: NextRequest) {
  try {
    const { messages } = await req.json() as { messages: ChatMessage[] }
    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: 'Missing messages' }, { status: 400 })
    }

    const reply = await callGrok({
      model: GROK_FAST,
      system: SYSTEM,
      messages,
      maxTokens: 1024,
      temperature: 0.8,
    })

    return NextResponse.json({ reply })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
