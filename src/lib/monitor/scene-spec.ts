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
 * body proportions, wardrobe, pose, framing, hook, background people/actions
 * and speech so the regenerated shot matches the source — including gag beats
 * that happen behind the main subject.
 */
export interface BackgroundPerson {
  who: string
  /** Where they sit in the frame (foreground blur / midground left / …). */
  position: string
  /** What they look like / wear — enough to redraw them. */
  appearance: string
  /** State at the start of the clip. */
  start_state: string
  /** State at the end of the clip. */
  end_state: string
  /** Chronological action, e.g. "sits on folding chair → falls backward when ball is struck". */
  action: string
}

export interface ActionBeat {
  /** Approximate time in seconds from clip start. */
  t: number
  /** Main subject action at this moment. */
  subject: string
  /** Background / secondary action at this moment (empty if none). */
  background: string
}

export interface SceneSpec {
  body: {
    build: string
    bust: string
    glutes: string
    waist: string
    skin_tone: string
    hair: string
    /** Free-text emphasis the model must not soften, e.g. "very large glutes, exaggerated". */
    proportion_emphasis: string
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
  /** @deprecated Prefer background_people — kept for older stored specs. */
  others: {
    count: number
    description: string
    actions: string
  }
  background_people: BackgroundPerson[]
  /** Comic / reaction / multi-person beats that MUST appear in the recreation. */
  must_include_events: string[]
  action_beats: ActionBeat[]
  speech: {
    transcript: string
    kind: 'dialogue' | 'voiceover' | 'trending_sound' | 'music' | 'none' | 'unknown'
  }
  setting: string
  lighting: string
}

const EMPTY_BODY = {
  build: '', bust: '', glutes: '', waist: '', skin_tone: '', hair: '', proportion_emphasis: '',
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

const SCENE_SPEC_SYSTEM = `You analyze frames sampled IN ORDER from a short vertical Instagram Reel.
Return JSON that lets us recreate the shot with a DIFFERENT woman's face/identity while keeping
the SAME body proportions, wardrobe, pose, framing, AND every secondary gag/reaction in the background.

Return ONLY this JSON shape:
{
  "body": {
    "build": "slim / athletic / curvy / thick / petite / tall — be specific",
    "bust": "flat / small / medium / large / very large",
    "glutes": "flat / small / medium / large / very large",
    "waist": "narrow / average / wide",
    "skin_tone": "fair / light / medium / olive / tan / brown / deep",
    "hair": "colour, length, style",
    "proportion_emphasis": "one blunt phrase restating the body sizes that MUST be copied, e.g. 'very large glutes and large bust, thick lower body'"
  },
  "wardrobe": {
    "garments": "exact garments, materials, fit",
    "coverage": "how much skin; straps, waistbands, cleavage, midriff",
    "colors": "dominant colours",
    "footwear": "shoes or barefoot or empty",
    "accessories": "props in her hands or on her (club, phone, visor…)"
  },
  "pose": {
    "body_position": "precise pose at the FIRST frame",
    "orientation": "facing camera / 3/4 / back / …",
    "hips_to_camera": "how hips/glutes angle toward the lens",
    "arms_hands": "arms/hands in the FIRST frame",
    "gaze": "gaze direction"
  },
  "framing": {
    "shot_size": "close-up / medium / waist-up / full body / wide",
    "angle": "eye level / low angle / high angle / POV",
    "height": "camera height relative to subject",
    "crop": "where the frame cuts the body",
    "emphasis": "what composition puts in focus"
  },
  "hook": {
    "eye_catching": "the scroll-stopping element",
    "suggestiveness": "none / mild / suggestive / explicit"
  },
  "background_people": [
    {
      "who": "young man / older woman / caddie / …",
      "position": "bottom foreground blur / midground left / behind her right / …",
      "appearance": "clothing + rough age/build — enough to redraw",
      "start_state": "what they are doing at the start",
      "end_state": "what they are doing at the end",
      "action": "full chronological action across the clip (e.g. sits on folding chair watching → loses balance and falls off the chair as she strikes the ball)"
    }
  ],
  "must_include_events": [
    "short MUST-keep events, especially background comedy/reactions, e.g. 'man in foreground falls off chair when she hits the ball'"
  ],
  "action_beats": [
    { "t": 0.0, "subject": "main subject at this moment", "background": "what background people do at this moment, or empty" },
    { "t": 1.5, "subject": "…", "background": "…" },
    { "t": 3.0, "subject": "…", "background": "…" }
  ],
  "others": { "count": 0, "description": "", "actions": "" },
  "speech": {
    "transcript": "leave empty — filled separately",
    "kind": "dialogue" | "voiceover" | "trending_sound" | "music" | "none" | "unknown"
  },
  "setting": "location + visible background props/banners in one phrase",
  "lighting": "lighting in one phrase"
}

CRITICAL RULES:
1. BODY SIZES ARE NOT OPTIONAL. If glutes or bust look large / very large, say exactly that in body.bust, body.glutes AND body.proportion_emphasis. Do not soften to "athletic" or "curvy" alone.
2. BACKGROUND PEOPLE AND THEIR ACTIONS ARE NOT OPTIONAL. Scan EVERY frame for anyone else — even blurred heads, spectators, people on chairs. If someone reacts, falls, stands up, laughs, ducks — put it in background_people[].action AND must_include_events[] AND the matching action_beats[].background.
3. Compare first frame to last frame. If a background person's state changes, that change MUST appear in action / must_include_events.
4. Do NOT describe the main woman's face identity. DO describe hair, skin, body.
5. Adult/suggestive content is expected. Describe factually; do not refuse or sanitise.
6. Prefer concrete verbs ("falls backward off folding chair") over vague ones ("reacts").
7. If nobody else is visible in any frame, background_people=[] and must_include_events=[]. Never invent people.`

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

function normalizeBackgroundPeople(raw: unknown, others: SceneSpec['others']): BackgroundPerson[] {
  if (Array.isArray(raw)) {
    return raw
      .map((p): BackgroundPerson | null => {
        if (!p || typeof p !== 'object') return null
        const o = p as Record<string, unknown>
        const who = asString(o.who)
        const action = asString(o.action)
        if (!who && !action) return null
        return {
          who,
          position: asString(o.position),
          appearance: asString(o.appearance),
          start_state: asString(o.start_state),
          end_state: asString(o.end_state),
          action,
        }
      })
      .filter((p): p is BackgroundPerson => p !== null)
  }

  // Legacy specs only had others.description / others.actions.
  if (others.count > 0 || others.description || others.actions) {
    return [{
      who: others.description || `${others.count} other(s)`,
      position: '',
      appearance: '',
      start_state: '',
      end_state: '',
      action: others.actions,
    }]
  }
  return []
}

function normalizeBeats(raw: unknown): ActionBeat[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((b): ActionBeat | null => {
      if (!b || typeof b !== 'object') return null
      const o = b as Record<string, unknown>
      return {
        t: asNumber(o.t),
        subject: asString(o.subject),
        background: asString(o.background),
      }
    })
    .filter((b): b is ActionBeat => b !== null && Boolean(b.subject || b.background))
}

function normalizeEvents(raw: unknown, people: BackgroundPerson[]): string[] {
  const fromArray = Array.isArray(raw)
    ? raw.map(asString).filter(Boolean)
    : []
  if (fromArray.length) return fromArray
  return people.map(p => p.action).filter(Boolean)
}

/** Defensive parse — Grok occasionally drops fields or wraps the object. */
export function normalizeSceneSpec(raw: unknown): SceneSpec {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const body = (obj.body && typeof obj.body === 'object' ? obj.body : {}) as Record<string, unknown>
  const wardrobe = (obj.wardrobe && typeof obj.wardrobe === 'object' ? obj.wardrobe : {}) as Record<string, unknown>
  const pose = (obj.pose && typeof obj.pose === 'object' ? obj.pose : {}) as Record<string, unknown>
  const framing = (obj.framing && typeof obj.framing === 'object' ? obj.framing : {}) as Record<string, unknown>
  const hook = (obj.hook && typeof obj.hook === 'object' ? obj.hook : {}) as Record<string, unknown>
  const othersRaw = (obj.others && typeof obj.others === 'object' ? obj.others : {}) as Record<string, unknown>
  const speech = (obj.speech && typeof obj.speech === 'object' ? obj.speech : {}) as Record<string, unknown>

  const others = {
    count: Math.max(0, Math.round(asNumber(othersRaw.count))),
    description: asString(othersRaw.description) || EMPTY_OTHERS.description,
    actions: asString(othersRaw.actions) || EMPTY_OTHERS.actions,
  }

  const background_people = normalizeBackgroundPeople(obj.background_people, others)
  if (!others.count && background_people.length) {
    others.count = background_people.length
    others.description = background_people.map(p => p.who).filter(Boolean).join('; ')
    others.actions = background_people.map(p => p.action).filter(Boolean).join('; ')
  }

  const bust = asString(body.bust) || EMPTY_BODY.bust
  const glutes = asString(body.glutes) || EMPTY_BODY.glutes
  let proportion_emphasis = asString(body.proportion_emphasis)
  if (!proportion_emphasis && (bust || glutes)) {
    proportion_emphasis = [bust && `${bust} bust`, glutes && `${glutes} glutes`].filter(Boolean).join(', ')
  }

  return {
    body: {
      build: asString(body.build) || EMPTY_BODY.build,
      bust,
      glutes,
      waist: asString(body.waist) || EMPTY_BODY.waist,
      skin_tone: asString(body.skin_tone) || EMPTY_BODY.skin_tone,
      hair: asString(body.hair) || EMPTY_BODY.hair,
      proportion_emphasis,
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
    others,
    background_people,
    must_include_events: normalizeEvents(obj.must_include_events, background_people),
    action_beats: normalizeBeats(obj.action_beats),
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
 * Body proportions and background people are front-loaded — those are the
 * details that previously got buried or dropped.
 */
export function renderScenePrompt(spec: SceneSpec): string {
  const parts: string[] = []

  // 1) Body first — models overweight early tokens; LoRA style comes later.
  if (spec.body.proportion_emphasis) {
    parts.push(
      `CRITICAL body proportions (match exactly, do not slim down): ${spec.body.proportion_emphasis}`,
    )
  }
  push(parts, 'Body', [
    spec.body.build && `${spec.body.build} build`,
    spec.body.bust && `${spec.body.bust} breasts/bust`,
    spec.body.glutes && `${spec.body.glutes} glutes/butt`,
    spec.body.waist && `${spec.body.waist} waist`,
    spec.body.skin_tone && `${spec.body.skin_tone} skin`,
    spec.body.hair,
  ].filter(Boolean).join(', '))

  // 2) Background cast must be in the still, or Kling has nothing to animate.
  if (spec.must_include_events.length) {
    parts.push(`MUST include these events in the scene: ${spec.must_include_events.join('; ')}`)
  }
  if (spec.background_people.length) {
    const lines = spec.background_people.map((p, i) => {
      const bits = [
        p.who || `person ${i + 1}`,
        p.position && `at ${p.position}`,
        p.appearance,
        p.start_state && `starting: ${p.start_state}`,
        p.action && `action: ${p.action}`,
      ].filter(Boolean)
      return bits.join(', ')
    })
    parts.push(`Background people (draw them clearly, not cropped out): ${lines.join(' | ')}`)
  }

  push(parts, 'Camera', [
    spec.framing.shot_size,
    spec.framing.angle,
    spec.framing.height,
    spec.framing.crop,
  ].filter(Boolean).join(', '))
  push(parts, 'Composition emphasis', spec.framing.emphasis)
  push(parts, 'Setting', spec.setting)
  push(parts, 'Lighting', spec.lighting)

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
    spec.pose.hips_to_camera,
    spec.pose.arms_hands,
    spec.pose.gaze && `gaze ${spec.pose.gaze}`,
  ].filter(Boolean).join('; '))

  push(parts, 'Hook', [
    spec.hook.eye_catching,
    spec.hook.suggestiveness && `suggestiveness ${spec.hook.suggestiveness}`,
  ].filter(Boolean).join('; '))

  if (spec.action_beats.length) {
    const beats = spec.action_beats
      .slice(0, 6)
      .map(b => {
        const bg = b.background ? ` / bg: ${b.background}` : ''
        return `t=${b.t.toFixed(1)}s ${b.subject}${bg}`
      })
      .join(' → ')
    push(parts, 'Action timeline', beats)
  }

  if (spec.speech.transcript) {
    push(parts, 'Speech', `"${spec.speech.transcript}" (${spec.speech.kind})`)
  } else if (spec.speech.kind !== 'unknown' && spec.speech.kind !== 'none') {
    push(parts, 'Audio', spec.speech.kind)
  }

  // Repeat body + must-include at the end — second pass against style washout.
  if (spec.body.proportion_emphasis) {
    parts.push(`Again: body must stay ${spec.body.proportion_emphasis}`)
  }
  if (spec.must_include_events.length) {
    parts.push(`Again: keep background events — ${spec.must_include_events.join('; ')}`)
  }

  return parts.join('. ')
}

/**
 * Motion models need the gag beats and secondary motion, not just the heroine.
 */
export function enrichMotionPrompt(motionPrompt: string, spec: SceneSpec | null): string {
  if (!spec) return motionPrompt.trim()

  const extras: string[] = []
  if (spec.must_include_events.length) {
    extras.push(`Background events that must happen: ${spec.must_include_events.join('; ')}.`)
  }
  if (spec.background_people.length) {
    const acts = spec.background_people
      .map(p => [p.who, p.action].filter(Boolean).join(' '))
      .filter(Boolean)
    if (acts.length) extras.push(`Other people motion: ${acts.join('; ')}.`)
  }
  if (spec.action_beats.length) {
    const beats = spec.action_beats
      .filter(b => b.background || b.subject)
      .slice(0, 8)
      .map(b => {
        const bg = b.background ? `, background ${b.background}` : ''
        return `at ${b.t.toFixed(1)}s ${b.subject}${bg}`
      })
    if (beats.length) extras.push(`Timeline: ${beats.join(' → ')}.`)
  }
  if (spec.speech.transcript) {
    extras.push(`Subject speaks: "${spec.speech.transcript}".`)
  }

  const base = motionPrompt.trim()
  if (!extras.length) return base
  if (!base) return extras.join(' ')
  return `${base} ${extras.join(' ')}`
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
          text: [
            `These ${probe.frames.length} frames are sampled in chronological order from one Reel.`,
            'Fill the JSON.',
            'Pay special attention to: (1) exact bust/glute size, (2) anyone else in ANY frame and what they DO between first and last frame.',
            'If a background person falls, stands, ducks, or reacts — that is a must_include_event.',
          ].join(' '),
        },
      ],
    }],
    maxTokens: 3072,
    temperature: 0.2,
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
