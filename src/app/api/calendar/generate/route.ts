import { NextRequest, NextResponse } from 'next/server'
import { PROMPT_TYPE_MAP } from '@/lib/types'
import { callGrok, GROK_FAST, GROK_SMART } from '@/lib/grok'

interface CharacterConfig {
  name: string
  basePromptStyle: string
  story: string
}

interface DayContext {
  date: string
  notes?: string
  topic?: string
  keywords?: string
}

function characterHeader(character: CharacterConfig, mode: string): string {
  const isNSFW = mode === 'NSFW'
  return `CHARACTER: ${character.name}
${character.story}

IMAGE STYLE: ${character.basePromptStyle}

MODE: ${mode} — ${isNSFW
    ? 'Content can include intimate/adult themes, lingerie, sensual scenarios.'
    : 'All content must be appropriate and tasteful, no explicit content.'}`
}

function dayHeader(day: DayContext): string {
  const formatted = new Date(day.date).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  })
  const lines = [`DATE: ${formatted}`]
  if (day.notes?.trim()) lines.push(`USER NOTES (what she is doing on this day, source of truth): ${day.notes.trim()}`)
  if (day.topic?.trim()) lines.push(`TOPIC: ${day.topic.trim()}`)
  if (day.keywords?.trim()) lines.push(`KEYWORDS: ${day.keywords.trim()}`)
  return lines.join('\n')
}

function buildContextSystem(character: CharacterConfig, mode: string): string {
  const isNSFW = mode === 'NSFW'
  return `You are a creative content planner for an AI social media model.

${characterHeader(character, mode)}

TASK: Given a single date and (optionally) the user's notes about what she does that day, produce concise day metadata.

RULES:
- topic: 3-6 words, evocative, in English
- keywords: 4-7 comma separated keywords in English
- description: 1-2 sentences in first person as ${character.name}, warm and personal, NOT long
- fanvue_description: a single short caption for Fanvue/Telegram (1 sentence, slightly teasing${isNSFW ? ', can be suggestive' : ', SFW'})
- If user notes are present, stay faithful to them — do not invent activities that contradict them
- If user notes are EMPTY, invent a plausible everyday moment that fits ${character.name}'s lifestyle (gym, cafe, walk, work, beach, getting ready, etc.) — never ask for clarification

OUTPUT FORMAT — STRICT:
- Reply with a single JSON object and nothing else
- No prose before or after, no markdown fences, no explanations, no apologies
- Even if information is missing, you MUST still return JSON; invent naturally

Schema:
{"topic":"...","keywords":"...","description":"...","fanvue_description":"..."}`
}

function buildPromptSystem(character: CharacterConfig, mode: string, instruction: string): string {
  const isNSFW = mode === 'NSFW'
  return `You write a single image prompt for an AI image generator (Wavespeed z-image).

${characterHeader(character, mode)}

PROMPT TYPE INSTRUCTION:
${instruction}

UNIVERSAL RULES (very important):
- The photo MUST look like she took it herself — no professional photographer, no third person shooting her
- Include natural details: slightly messy hair, real lighting, everyday backgrounds, subtle imperfection
- Never use words like "professional photography", "studio", "photographer", "model shoot"
- Describe what is actually visible in the frame, not the story
- Stay coherent with the user's notes for this day
${isNSFW ? '- Tasteful sensuality is allowed when natural to the scene' : '- Keep the prompt fully SFW'}

Return ONLY the image prompt as plain text. No quotes, no JSON, no explanation, no labels — just the prompt.`
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

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { mode: contentMode, character, day, promptTypeId } = body as {
      mode: 'context' | 'prompt'
      character: CharacterConfig & { mode?: string }
      day: DayContext
      promptTypeId?: string
    }
    const sceneMode = character.mode ?? 'SFW'

    if (!character?.name || !day?.date) {
      return NextResponse.json({ error: 'Missing character or day' }, { status: 400 })
    }

    if (contentMode === 'context') {
      const text = await callGrok({
        model: GROK_SMART,
        system: buildContextSystem(character, sceneMode),
        messages: [{ role: 'user', content: `Generate metadata for this day:\n${dayHeader(day)}` }],
        maxTokens: 800,
        temperature: 0.4,
        json: true,
      })
      const parsed = extractJsonObject(text) as {
        topic?: string; keywords?: string; description?: string; fanvue_description?: string
      }
      return NextResponse.json({
        topic: parsed.topic ?? '',
        keywords: parsed.keywords ?? '',
        description: parsed.description ?? '',
        fanvue_description: parsed.fanvue_description ?? '',
      })
    }

    if (contentMode === 'prompt') {
      if (!promptTypeId) return NextResponse.json({ error: 'Missing promptTypeId' }, { status: 400 })
      const promptType = PROMPT_TYPE_MAP[promptTypeId]
      if (!promptType) return NextResponse.json({ error: `Unknown promptTypeId: ${promptTypeId}` }, { status: 400 })

      const text = await callGrok({
        model: GROK_FAST,
        system: buildPromptSystem(character, sceneMode, promptType.instruction),
        messages: [{ role: 'user', content: `Write the image prompt for this day:\n${dayHeader(day)}` }],
        maxTokens: 600,
        temperature: 0.7,
      })
      return NextResponse.json({ prompt: text })
    }

    return NextResponse.json({ error: 'Invalid mode (use "context" or "prompt")' }, { status: 400 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
