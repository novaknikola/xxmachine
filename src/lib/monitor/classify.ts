import { callGrok, GROK_SMART, base64ImageContent } from '@/lib/grok'
import type { SourceProbe } from './analyze'
import type { ContentType, VideoTechnique } from './types'

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
  if (!VALID_CONTENT_TYPES.includes(parsed.content_type)) parsed.content_type = 'other'
  return parsed
}

const VALID_CONTENT_TYPES: ContentType[] = ['video_gen', 'image_gen', 'carousel', 'real_photo', 'other']
const VALID_TECHNIQUES: VideoTechnique[] = [
  'motion_transfer', 'image_to_video', 'first_last_frame', 'multi_shot', 'extend', 'unknown',
]

/** Below this the detection is discarded and the caller falls back to a safe default. */
const MIN_TECHNIQUE_CONFIDENCE = 0.5
/** Two or more detected cuts is treated as a real sequence; a single hit may be motion blur. */
const MULTI_SHOT_CUT_THRESHOLD = 2
/** Longest clip a single generation call can cover. */
const MAX_SINGLE_GENERATION_SECONDS = 12

const TECHNIQUE_PROMPT = `You are given frames sampled in order from a short vertical video, plus measured facts about it.

Decide two things and return JSON only:
{
  "content_type": "video_gen" | "image_gen" | "carousel" | "real_photo" | "other",
  "video_technique": "motion_transfer" | "image_to_video" | "first_last_frame" | "multi_shot" | "extend" | "unknown",
  "technique_confidence": 0.0-1.0,
  "reasoning": "one or two sentences citing what you actually observed"
}

content_type rules:
- video_gen: AI-generated person in motion (synthetic skin, uncanny smoothness, AI motion artifacts)
- image_gen: a single AI still presented as a video (no real motion, only zoom/pan on a static image)
- carousel: multi-panel or slideshow content
- real_photo: authentic non-AI footage
- other: memes, screenshots, reposts, no person

video_technique — pick by what the SHOT REQUIRES to be reproduced. Do NOT try to guess
which commercial product made it; generated video carries no reliable fingerprint of its
origin model. Judge only the motion structure:

- motion_transfer: a person performs continuous body motion (dancing, walking, gesturing,
  turning) through one unbroken shot. Reproducing it requires copying that motion.
- image_to_video: one continuous shot where the subject barely moves (breathing, blinking,
  hair drift) and/or the camera does the work (slow push in, pull back, pan, orbit).
- first_last_frame: the clip clearly starts in state A and ends in a visibly DIFFERENT
  state B — outfit change, location change, object appearing/disappearing, a transformation
  or reveal — with the change driving the clip rather than incidental movement.
- multi_shot: the frames show separate scenes or angles that cannot belong to one take.
- extend: one continuous shot that simply runs longer than a short generated clip.
- unknown: the frames are too ambiguous, or no clear human subject is present.

Weigh the measured facts heavily — they are objective, your visual impression is not.`

export interface VideoAnalysis {
  content_type: ContentType
  video_technique: VideoTechnique
  technique_confidence: number
  reasoning: string
  /** Set when a measured signal overruled the model's choice. */
  overrodeModel: boolean
}

/**
 * Classifies content type and required technique in a single vision call, then lets
 * the measured signals override the model where they are decisive.
 */
export async function analyzeVideoContent(probe: SourceProbe): Promise<VideoAnalysis> {
  const facts = [
    `Measured duration: ${probe.duration ? `${probe.duration.toFixed(1)}s` : 'unknown'}`,
    `Hard cuts detected in source: ${probe.cutCount}`,
    `Audio track present: ${probe.hasAudio ? 'yes' : 'no'}`,
    `Frames provided: ${probe.frames.length}, evenly spaced from start to end`,
  ].join('\n')

  const raw = await callGrok({
    model: GROK_SMART,
    json: true,
    messages: [{
      role: 'user',
      content: [
        ...probe.frames.map(f => base64ImageContent(f)),
        { type: 'text', text: `${TECHNIQUE_PROMPT}\n\nMeasured facts:\n${facts}` },
      ],
    }],
    maxTokens: 1024,
    temperature: 0.2,
  })

  const parsed = JSON.parse(raw) as Partial<VideoAnalysis>

  const contentType = VALID_CONTENT_TYPES.includes(parsed.content_type as ContentType)
    ? parsed.content_type as ContentType
    : 'other'

  let technique = VALID_TECHNIQUES.includes(parsed.video_technique as VideoTechnique)
    ? parsed.video_technique as VideoTechnique
    : 'unknown'
  let confidence = Number(parsed.technique_confidence ?? 0)
  if (!Number.isFinite(confidence)) confidence = 0

  let overrodeModel = false

  // A clip with real cuts cannot be reproduced by any single generation call,
  // whatever the frames look like.
  if (probe.cutCount >= MULTI_SHOT_CUT_THRESHOLD && technique !== 'multi_shot') {
    technique = 'multi_shot'
    confidence = 0.9
    overrodeModel = true
  } else if (
    probe.duration &&
    probe.duration > MAX_SINGLE_GENERATION_SECONDS &&
    probe.cutCount < MULTI_SHOT_CUT_THRESHOLD &&
    technique !== 'extend'
  ) {
    technique = 'extend'
    confidence = 0.85
    overrodeModel = true
  } else if (confidence < MIN_TECHNIQUE_CONFIDENCE) {
    technique = 'unknown'
  }

  return {
    content_type: contentType,
    video_technique: technique,
    technique_confidence: confidence,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    overrodeModel,
  }
}
