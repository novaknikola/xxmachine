import { callGrok, GROK_SMART, base64ImageContent } from '@/lib/grok'
import type { ContentType } from './types'

const CLASSIFY_PROMPT = `Analyze this Instagram content frame and classify it.

Return JSON only:
{
  "content_type": "video_gen" | "image_gen" | "carousel" | "real_photo" | "other",
  "confidence": 0.0-1.0,
  "reasoning": "one sentence",
  "suggested_pipeline": "motion_replicate" | "image_generate" | "carousel_generate" | "skip"
}

Rules:
- video_gen: AI-generated person in a video/reel with synthetic look, uncanny smooth skin, or obvious AI motion
- image_gen: single AI-generated photo of a person
- carousel: multi-slide post (text overlays, multiple panels)
- real_photo: authentic non-AI photography
- other: memes, screenshots, reposts, no person

For AI influencer accounts, most reels are video_gen.`

export interface ClassifyResult {
  content_type: ContentType
  confidence: number
  reasoning: string
  suggested_pipeline: string
}

export async function classifyContentImage(imageBase64: string): Promise<ClassifyResult> {
  const raw = await callGrok({
    model: GROK_SMART,
    json: true,
    messages: [{
      role: 'user',
      content: [
        base64ImageContent(imageBase64),
        { type: 'text', text: CLASSIFY_PROMPT },
      ],
    }],
    maxTokens: 512,
    temperature: 0.2,
  })

  const parsed = JSON.parse(raw) as ClassifyResult
  const valid: ContentType[] = ['video_gen', 'image_gen', 'carousel', 'real_photo', 'other']
  if (!valid.includes(parsed.content_type)) parsed.content_type = 'other'
  return parsed
}
