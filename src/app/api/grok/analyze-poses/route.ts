import { NextRequest, NextResponse } from 'next/server'
import { callGrok, GROK_SMART, base64ImageContent } from '@/lib/grok'

const SYSTEM = `You are an expert adult content prompt writer for WAN 2.7 image editing AI.

Your job: analyze the reference photo and write exactly 5 short, direct image editing prompts.

Each prompt instructs WAN 2.7 how to transform the reference image into a new variation — keeping the same person, same face, same body, but changing the pose, situation, outfit or expression.

RULES:
- Each prompt must be 1-2 sentences max, very visual and direct
- Describe exactly what changes: pose, clothing, action, expression, camera angle
- Keep what stays the same implicit — WAN will preserve the person automatically
- NSFW content is allowed and expected — be explicit and detailed
- Do NOT use the word "she" or any name — describe actions and states only
- Do NOT include quality tags like "photorealistic", "high quality" etc — those come from suffix
- English only

Return ONLY a JSON array of exactly 5 strings. No explanation, no markdown. Example:
["prompt one", "prompt two", "prompt three", "prompt four", "prompt five"]`

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()

    const files = form.getAll('files[]') as File[]
    const singleFile = form.get('file') as File | null
    const allFiles = files.length > 0 ? files : singleFile ? [singleFile] : []
    const hint = (form.get('hint') as string | null)?.trim() ?? ''
    const count = Number(form.get('count') ?? 5)

    if (!allFiles.length) {
      return NextResponse.json({ error: 'No image provided' }, { status: 400 })
    }

    // Convert all files to base64
    const base64Images = await Promise.all(
      allFiles.map(async f => {
        const buf = await f.arrayBuffer()
        return { base64: Buffer.from(buf).toString('base64'), mime: f.type || 'image/jpeg' }
      })
    )

    const userContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
      ...base64Images.map(img => base64ImageContent(img.base64, img.mime)),
      {
        type: 'text',
        text: `Analyze the reference photo${base64Images.length > 1 ? 's' : ''} and generate ${count} NSFW WAN 2.7 editing prompts.${hint ? `\n\nUser direction: ${hint}` : ''}`,
      },
    ]

    const text = await callGrok({
      model: GROK_SMART,
      system: SYSTEM,
      messages: [{ role: 'user', content: userContent as never }],
      maxTokens: 1024,
      temperature: 0.9,
      json: true,
    })

    let prompts: string[]
    try {
      const parsed = JSON.parse(text)
      prompts = Array.isArray(parsed) ? parsed.filter(p => typeof p === 'string') : []
    } catch {
      // Try to extract array from text if JSON parse fails
      const match = text.match(/\[[\s\S]*\]/)
      if (match) {
        try { prompts = JSON.parse(match[0]) } catch { prompts = [] }
      } else {
        prompts = []
      }
    }

    if (!prompts.length) {
      return NextResponse.json({ error: 'Failed to generate prompts', raw: text }, { status: 502 })
    }

    // Pad to requested count if needed
    while (prompts.length < count) prompts.push('')

    return NextResponse.json({ prompts: prompts.slice(0, count) })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}
