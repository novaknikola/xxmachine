import { writeFileSync, existsSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { callGrok, GROK_SMART, base64ImageContent } from '@/lib/grok'
import { transcribeVideoFile } from '@/lib/transcribe'
import type { SourceProbe } from './analyze'

/**
 * Structured capture of everything that must survive the identity swap.
 * The LoRA supplies the face and character identity; this object supplies
 * body, wardrobe, pose, framing, hook, other people and speech so the
 * regenerated shot matches the source's scroll-stopping properties.
 */
export interface SceneSpec {
  body: {
    build: string
    bust: string
    glutes: string
    waist: string
    skin_tone: string
    hair: string
  }
  wardrobe: {
    garments: string
    coverage: string
    colors: string
    footwear: string
    accessories: string
  }
  pose: {
    body_position: string
    orientation: string
    hips_to_camera: string
    arms_hands: string
    gaze: string
  }
  framing: {
    shot_size: string
    angle: string
    height: string
    crop: string
    emphasis: string
  }
  hook: {
    eye_catching: string
    suggestiveness: string
  }
  others: {
    count: number
    description: string
    actions: string
  }
  speech: {
    transcript: string
    kind: 'dialogue' | 'voiceover' | 'trending_sound' | 'music' | 'none' | 'unknown'
  }
  setting: string
  lighting: string
}

const EMPTY_BODY = {
  build: '', bust: '', glutes: '', waist: '', skin_tone: '', hair: '',
}
const EMPTY_WARDROBE = {
  garments: '', coverage: '', colors: '', footwear: '', accessories: '',
}
const EMPTY_POSE = {
  body_position: '', orientation: '', hips_to_camera: '', arms_hands: '', gaze: '',
}
const EMPTY_FRAMING = {
  shot_size: '', angle: '', height: '', crop: '', emphasis: '',
}
const EMPTY_HOOK = { eye_catching: '', suggestiveness: '' }
const EMPTY_OTHERS = { count: 0, description: '', actions: '' }
const EMPTY_SPEECH: SceneSpec['speech'] = { transcript: '', kind: 'unknown' }

const SCENE_SPEC_SYSTEM = `You analyze frames from a short vertical Instagram Reel.
Return a JSON object that captures EVERYTHING needed to recreate the shot with a DIFFERENT person (different face/identity) while keeping the same body, wardrobe, pose, framing and attention-grabbing qualities.

Return ONLY this JSON shape:
{
  "body": {
    "build": "slim / athletic / curvy / thick / petite / tall — be specific",
    "bust": "flat / small / medium / large / very large — what you see",
    "glutes": "flat / small / medium / large / very large — what you see, especially if camera emphasises them",
    "waist": "narrow / average / wide",
    "skin_tone": "fair / light / medium / olive / tan / brown / deep",
    "hair": "colour, length, style (e.g. long blonde waves, short dark pixie)"
  },
  "wardrobe": {
    "garments": "exact garments visible, materials, fit (tight / loose / cropped)",
    "coverage": "how much skin is shown; straps, waistbands, underwear visibility, cleavage, midriff",
    "colors": "dominant garment colours",
    "footwear": "shoes or barefoot, or empty if not visible",
    "accessories": "jewellery, hat, bag, golf club, phone, etc. or empty"
  },
  "pose": {
    "body_position": "standing / sitting / bent over / kneeling / walking — precise",
    "orientation": "facing camera / 3/4 left / profile / back to camera",
    "hips_to_camera": "how hips/glutes are angled toward the lens (squared / turned / pushed back / arched)",
    "arms_hands": "what arms and hands are doing",
    "gaze": "looking at camera / looking away / down / over shoulder"
  },
  "framing": {
    "shot_size": "close-up / medium / waist-up / full body / wide",
    "angle": "eye level / low angle / high angle / POV",
    "height": "camera height relative to subject",
    "crop": "where the frame cuts the body",
    "emphasis": "what the composition puts in focus (face / chest / glutes / outfit / action)"
  },
  "hook": {
    "eye_catching": "the scroll-stopping element — bend, reveal, wet look, cleavage, booty angle, motion, prop, expression",
    "suggestiveness": "none / mild / suggestive / explicit — factual, not moralising"
  },
  "others": {
    "count": 0,
    "description": "who else is in frame (age/gender/role) or empty",
    "actions": "what they are doing / saying / how they interact with the subject"
  },
  "speech": {
    "transcript": "leave empty — filled by audio transcription separately",
    "kind": "dialogue" | "voiceover" | "trending_sound" | "music" | "none" | "unknown"
  },
  "setting": "location and background in one short phrase",
  "lighting": "lighting description in one short phrase"
}

RULES:
- Describe body proportions FACTUALLY. If the subject has a large chest or large glutes, say so — that is what must be reproduced.
- Do NOT describe face shape, eye colour, freckles, or identity. Face identity is replaced by our character LoRA.
- DO describe hair, skin tone and body — those travel with the recreation.
- Be specific about wardrobe coverage and pose relative to the camera.
- Adult/suggestive content is allowed and expected for this product. Describe it usefully; do not refuse or sanitise.
- If something is not visible, use an empty string (or 0 for count), never invent.
- Prefer short concrete phrases over fluff.`

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function normalizeSpeechKind(v: unknown): SceneSpec['speech']['kind'] {
  const s = asString(v)
  if (
    s === 'dialogue' || s === 'voiceover' || s === 'trending_sound' ||
    s === 'music' || s === 'none' || s === 'unknown'
  ) return s
  return 'unknown'
}

/** Defensive parse — Grok occasionally drops fields or wraps the object. */
export function normalizeSceneSpec(raw: unknown): SceneSpec {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const body = (obj.body && typeof obj.body === 'object' ? obj.body : {}) as Record<string, unknown>
  const wardrobe = (obj.wardrobe && typeof obj.wardrobe === 'object' ? obj.wardrobe : {}) as Record<string, unknown>
  const pose = (obj.pose && typeof obj.pose === 'object' ? obj.pose : {}) as Record<string, unknown>
  const framing = (obj.framing && typeof obj.framing === 'object' ? obj.framing : {}) as Record<string, unknown>
  const hook = (obj.hook && typeof obj.hook === 'object' ? obj.hook : {}) as Record<string, unknown>
  const others = (obj.others && typeof obj.others === 'object' ? obj.others : {}) as Record<string, unknown>
  const speech = (obj.speech && typeof obj.speech === 'object' ? obj.speech : {}) as Record<string, unknown>

  return {
    body: {
      build: asString(body.build) || EMPTY_BODY.build,
      bust: asString(body.bust) || EMPTY_BODY.bust,
      glutes: asString(body.glutes) || EMPTY_BODY.glutes,
      waist: asString(body.waist) || EMPTY_BODY.waist,
      skin_tone: asString(body.skin_tone) || EMPTY_BODY.skin_tone,
      hair: asString(body.hair) || EMPTY_BODY.hair,
    },
    wardrobe: {
      garments: asString(wardrobe.garments) || EMPTY_WARDROBE.garments,
      coverage: asString(wardrobe.coverage) || EMPTY_WARDROBE.coverage,
      colors: asString(wardrobe.colors) || EMPTY_WARDROBE.colors,
      footwear: asString(wardrobe.footwear) || EMPTY_WARDROBE.footwear,
      accessories: asString(wardrobe.accessories) || EMPTY_WARDROBE.accessories,
    },
    pose: {
      body_position: asString(pose.body_position) || EMPTY_POSE.body_position,
      orientation: asString(pose.orientation) || EMPTY_POSE.orientation,
      hips_to_camera: asString(pose.hips_to_camera) || EMPTY_POSE.hips_to_camera,
      arms_hands: asString(pose.arms_hands) || EMPTY_POSE.arms_hands,
      gaze: asString(pose.gaze) || EMPTY_POSE.gaze,
    },
    framing: {
      shot_size: asString(framing.shot_size) || EMPTY_FRAMING.shot_size,
      angle: asString(framing.angle) || EMPTY_FRAMING.angle,
      height: asString(framing.height) || EMPTY_FRAMING.height,
      crop: asString(framing.crop) || EMPTY_FRAMING.crop,
      emphasis: asString(framing.emphasis) || EMPTY_FRAMING.emphasis,
    },
    hook: {
      eye_catching: asString(hook.eye_catching) || EMPTY_HOOK.eye_catching,
      suggestiveness: asString(hook.suggestiveness) || EMPTY_HOOK.suggestiveness,
    },
    others: {
      count: Math.max(0, Math.round(asNumber(others.count))),
      description: asString(others.description) || EMPTY_OTHERS.description,
      actions: asString(others.actions) || EMPTY_OTHERS.actions,
    },
    speech: {
      transcript: asString(speech.transcript) || EMPTY_SPEECH.transcript,
      kind: normalizeSpeechKind(speech.kind),
    },
    setting: asString(obj.setting),
    lighting: asString(obj.lighting),
  }
}

function push(parts: string[], label: string, value: string) {
  const v = value.trim()
  if (v) parts.push(`${label}: ${v}`)
}

/**
 * Flattens the structured spec into the image-generation prompt.
 * Face/identity is intentionally omitted — the LoRA + trigger word own that.
 */
export function renderScenePrompt(spec: SceneSpec): string {
  const parts: string[] = []

  push(parts, 'Camera', [
    spec.framing.shot_size,
    spec.framing.angle,
    spec.framing.height,
    spec.framing.crop,
  ].filter(Boolean).join(', '))
  push(parts, 'Composition emphasis', spec.framing.emphasis)

  push(parts, 'Setting', spec.setting)
  push(parts, 'Lighting', spec.lighting)

  push(parts, 'Body', [
    spec.body.build && `${spec.body.build} build`,
    spec.body.bust && `${spec.body.bust} bust`,
    spec.body.glutes && `${spec.body.glutes} glutes`,
    spec.body.waist && `${spec.body.waist} waist`,
    spec.body.skin_tone && `${spec.body.skin_tone} skin`,
    spec.body.hair,
  ].filter(Boolean).join(', '))

  push(parts, 'Wardrobe', [
    spec.wardrobe.garments,
    spec.wardrobe.colors && `colours ${spec.wardrobe.colors}`,
    spec.wardrobe.coverage,
    spec.wardrobe.footwear,
    spec.wardrobe.accessories,
  ].filter(Boolean).join('; '))

  push(parts, 'Pose', [
    spec.pose.body_position,
    spec.pose.orientation,
    spec.pose.hips_to_camera && `hips ${spec.pose.hips_to_camera}`,
    spec.pose.arms_hands,
    spec.pose.gaze && `gaze ${spec.pose.gaze}`,
  ].filter(Boolean).join('; '))

  push(parts, 'Hook', [
    spec.hook.eye_catching,
    spec.hook.suggestiveness && `suggestiveness ${spec.hook.suggestiveness}`,
  ].filter(Boolean).join('; '))

  if (spec.others.count > 0 || spec.others.description || spec.others.actions) {
    push(parts, 'Other people', [
      spec.others.count ? `${spec.others.count} other(s)` : '',
      spec.others.description,
      spec.others.actions,
    ].filter(Boolean).join('; '))
  }

  if (spec.speech.transcript) {
    push(parts, 'Speech', `"${spec.speech.transcript}" (${spec.speech.kind})`)
  } else if (spec.speech.kind !== 'unknown' && spec.speech.kind !== 'none') {
    push(parts, 'Audio', spec.speech.kind)
  }

  return parts.join('. ')
}

/**
 * Motion models get movement only, but spoken content often drives the action —
 * append a short speech cue when we have one.
 */
export function enrichMotionPrompt(motionPrompt: string, spec: SceneSpec | null): string {
  const base = motionPrompt.trim()
  if (!spec?.speech.transcript) return base
  const cue = `Subject speaks: "${spec.speech.transcript}"`
  if (!base) return cue
  if (base.toLowerCase().includes(spec.speech.transcript.toLowerCase().slice(0, 24))) return base
  return `${base} ${cue}`
}

async function downloadForTranscript(videoUrl: string): Promise<string> {
  const path = join(tmpdir(), `mon_speech_${randomUUID()}.mp4`)
  const res = await fetch(videoUrl, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`speech download failed: ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.byteLength) throw new Error('speech download empty')
  writeFileSync(path, buf)
  return path
}

/** Best-effort speech capture. Missing token or HF errors must not fail replication. */
export async function transcribeSourceSpeech(videoUrl: string): Promise<string> {
  const token = process.env.HF_TOKEN
  if (!token) return ''

  let path: string | null = null
  try {
    path = await downloadForTranscript(videoUrl)
    const segments = await transcribeVideoFile(path, token, 12, 8)
    return segments.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim()
  } catch (err) {
    console.warn('[monitor/scene-spec] transcript failed:', err instanceof Error ? err.message : err)
    return ''
  } finally {
    if (path) {
      try { if (existsSync(path)) unlinkSync(path) } catch {}
    }
  }
}

/**
 * One vision call over every probe frame, then optional audio transcription.
 * Speech is merged in after the vision pass so a failed transcript never
 * discards a good visual analysis.
 */
export async function extractSceneSpec(
  probe: Pick<SourceProbe, 'frames' | 'hasAudio'>,
  videoUrl?: string | null,
): Promise<SceneSpec> {
  if (!probe.frames.length) throw new Error('No frames for scene spec')

  const raw = await callGrok({
    model: GROK_SMART,
    json: true,
    system: SCENE_SPEC_SYSTEM,
    messages: [{
      role: 'user',
      content: [
        ...probe.frames.map(f => base64ImageContent(f)),
        {
          type: 'text',
          text: `These ${probe.frames.length} frames are sampled in order from one Reel. Fill the JSON.`,
        },
      ],
    }],
    maxTokens: 2048,
    temperature: 0.3,
  })

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Scene spec JSON parse failed')
  }

  const spec = normalizeSceneSpec(parsed)

  if (probe.hasAudio && videoUrl) {
    const transcript = await transcribeSourceSpeech(videoUrl)
    if (transcript) {
      spec.speech.transcript = transcript
      if (spec.speech.kind === 'unknown' || spec.speech.kind === 'none') {
        spec.speech.kind = 'dialogue'
      }
    }
  }

  return spec
}
