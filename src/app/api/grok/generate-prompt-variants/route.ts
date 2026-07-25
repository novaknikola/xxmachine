import { NextRequest, NextResponse } from 'next/server'
import { generatePromptVariants } from '@/lib/prompt-variants'

export async function POST(req: NextRequest) {
  try {
    const { examples, count, hint } = await req.json()

    if (!Array.isArray(examples) || examples.length === 0) {
      return NextResponse.json({ error: 'examples required' }, { status: 400 })
    }
    const n = Number(count) || 10
    if (n < 1 || n > 20) {
      return NextResponse.json({ error: 'count must be between 1 and 20' }, { status: 400 })
    }

    const prompts = await generatePromptVariants(examples.map(String), n, hint ? String(hint) : undefined)
    if (!prompts.length) {
      return NextResponse.json({ error: 'Failed to generate prompts' }, { status: 502 })
    }

    return NextResponse.json({ prompts })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}
