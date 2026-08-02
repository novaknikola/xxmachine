import { writeFileSync, existsSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { callGrok, GROK_SMART, base64ImageContent } from '@/lib/grok'
import { transcribeVideoFile } from '@/lib/transcribe'
import type { SourceProbe } from './analyze'

/**
 * One person in the recreated shot. Exactly ONE entry (always index 0) is the
 * user's reference-photo subject — their "appearance" is a fixed locked
 * string (see ensureReferenceLock) so Seedance takes identity from the
 * attached photo, not from text.
 */
export interface CopyPastePerson {
  id: string
  role: string
  appearance: string
  wardrobe: string
}

export interface CopyPasteSceneEvent {
  timestamp: string
  speaker: string
  line: string
  delivery: string
  action: string
}

export interface CopyPasteShot {
  time: string
  action: string
  camera_behavior: string
  scene_event_cue: string
}

export interface CopyPasteSpec {
  format: string
  people: CopyPastePerson[]
  environment: string
  lighting: string
  color_grading: string
  atmosphere: string
  audio: string
  pacing: string
  background_activity: string
  scene_events: CopyPasteSceneEvent[]
  style: string
  camera_logic: string
  imperfections: string[]
  shots: CopyPasteShot[]
  end_behavior: string
  negative_prompt: string
}

/** Always overwritten after parsing — never trust the model's own copy of this. */
export const NEGATIVE_PROMPT_TEMPLATE =
  'no smooth gimbal motion, no cinematic stabilization, no professional lighting, ' +
  'no beauty filter, no AI skin smoothing, no young girl, no young woman, no teenager, ' +
  'no child, no perfectly centered framing, no overly dramatic acting, no slow motion, ' +
  'no music video energy, no drone footage feel'

/** Forced value for whichever person (always people[0]) gets the reference photo. */
function referenceLockAppearance(genderHint: string): string {
  const isMan = /\b(male|man|guy|boyfriend|husband|coach|him|his)\b/i.test(genderHint)
  return `reference character is from image. Mature ${isMan ? 'man' : 'woman'}, realistic facial features, highly detailed.`
}

const NORMALIZATION_RULES = `
- Hair color: if the source subject's hair reads as pink (or any dyed pink/fantasy tone), describe it as "brown and white" hair instead. Never write "pink hair" for anyone.
- Outfit color: if a garment reads as pink, describe it as white instead. Never write "pink" as a wardrobe color for anyone.
- Ethnicity: never write "Asian" (or any specific Asian ethnicity/descent) for anyone — describe the person as European instead.
- Skin tone: never write "black skin" / "dark skin" as a descriptor for anyone — describe skin tone as white/fair instead.
- Age: never write "young", "girl", "teenager", "child", or any age-of-minor language for anyone in the scene. Every person must read as a mature adult (late 20s or older) — rewrite the whole age impression (posture, styling, phrasing), not just swap one word.
These rules apply to EVERY person in the scene, not only the reference-locked one.`

export const COPY_PASTE_SYSTEM = `You analyze frames sampled IN ORDER from a short vertical Instagram Reel (plus a
transcript if speech was detected) and return ONE JSON object that will be used to
recreate this clip with Seedance 2.0, a text+image-to-video generator. A reference
photo of the real on-camera identity will be substituted for ONE person in the
scene — you decide which person that is (see RULE A).

Return ONLY this JSON shape (fill every key; no markdown, no commentary):
{
  "format": "aspect ratio + duration + one phrase describing capture style, e.g. '9:16 vertical video format, 0:14 duration, raw smartphone social media clip' — you will be told the ACTUAL measured duration and aspect ratio below; use those exact numbers here, do not invent your own.",
  "people": [
    {
      "id": "short slug, e.g. female_subject / male_subject",
      "role": "their position/relationship in the shot",
      "appearance": "SEE RULE A BELOW",
      "wardrobe": "garments, colors, footwear, hair color+style — SEE RULE B"
    }
  ],
  "environment": "location + visible props/background, one rich phrase",
  "lighting": "lighting direction/quality/mood",
  "color_grading": "overall look — warm/cool, contrast, filmic or flat phone-camera grade",
  "atmosphere": "mood/energy of the scene",
  "audio": "what's audible — dialogue presence, music, ambient sound, silence",
  "pacing": "editing rhythm — single continuous take, quick cuts, etc.",
  "background_activity": "anything happening behind/around the main action",
  "scene_events": [
    { "timestamp": "0:00", "speaker": "person id or none", "line": "spoken words, or empty", "delivery": "tone of delivery", "action": "physical action at this moment" }
  ],
  "style": "overall visual/production style in one phrase",
  "camera_logic": "how the camera behaves across the whole clip — handheld/static/framing logic",
  "imperfections": ["raw, authentic, amateur-feeling details actually visible — NOT invented"],
  "shots": [
    { "time": "0:00-0:07", "action": "what happens in this shot", "camera_behavior": "camera movement/framing for this shot", "scene_event_cue": "matching scene_events timestamp, or empty" }
  ],
  "end_behavior": "how the clip ends — hard cut, hold, fade, loop-friendly, etc.",
  "negative_prompt": "leave this exact string empty — it is filled by our own code, not you"
}

RULE A — REFERENCE-LOCKED IDENTITY (CRITICAL):
Exactly ONE person in "people" is the main on-camera subject whose face will be
replaced by a user-supplied reference photo. This is ALWAYS people[0] — decide
who that is (usually whoever has the most camera focus / delivers the hook /
is foregrounded) and put them first. For THAT PERSON ONLY, set "appearance" to
literally: "reference character is from image. Mature <woman
or man>, realistic facial features, highly detailed." — choose woman/man based
on apparent sex, and write NOTHING else in appearance for this person (no hair
color, skin tone, ethnicity, or age words — those belong in the fixed template
only). Their "wardrobe" field (clothing + hair color/style) is still fully
described normally, following RULE B — hair color/style is a styling choice,
not a facial-identity attribute, so it is described even for the locked person.
For every OTHER person, "appearance" is a full description (build, face, skin,
hair, apparent age) — apply RULE B to it.

RULE B — FIXED NORMALIZATION (apply while writing, not as an afterthought):
${NORMALIZATION_RULES}

RULE C — NEVER WRITE negative_prompt YOURSELF. Always return it as an empty string.

OTHER RULES:
- Be concrete and specific, not vague. Every field should read like a director's shot list, not a vibe description.
- imperfections must reflect what is ACTUALLY visible (shaky frame, harsh phone flash, off-mic audio, etc.) — never invent generic filler.
- scene_events and shots must be chronological and cover the full clip start to end.
- Do not mention Instagram UI, captions, or watermarks anywhere.`

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function normalizePerson(raw: unknown, index: number): CopyPastePerson | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = asString(o.id) || `subject_${index + 1}`
  const role = asString(o.role)
  const appearance = asString(o.appearance)
  const wardrobe = asString(o.wardrobe)
  if (!role && !appearance && !wardrobe) return null
  return { id, role, appearance, wardrobe }
}

/** Force people[0]'s appearance to the fixed reference-lock template, regardless of what the model wrote. */
function enforceReferenceLock(people: CopyPastePerson[]): CopyPastePerson[] {
  if (!people.length) return people
  const [locked, ...rest] = people
  const genderHint = `${locked.id} ${locked.role} ${locked.appearance}`
  return [{ ...locked, appearance: referenceLockAppearance(genderHint) }, ...rest]
}

function normalizeSceneEvent(raw: unknown): CopyPasteSceneEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const line = asString(o.line)
  const action = asString(o.action)
  if (!line && !action) return null
  return {
    timestamp: asString(o.timestamp),
    speaker: asString(o.speaker) || 'none',
    line,
    delivery: asString(o.delivery),
    action,
  }
}

function normalizeShot(raw: unknown): CopyPasteShot | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const action = asString(o.action)
  if (!action) return null
  return {
    time: asString(o.time),
    action,
    camera_behavior: asString(o.camera_behavior),
    scene_event_cue: asString(o.scene_event_cue),
  }
}

/** Defensive parse — the model occasionally drops fields or wraps the object. */
export function normalizeCopyPasteSpec(raw: unknown): CopyPasteSpec {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  const people = enforceReferenceLock(
    (Array.isArray(obj.people) ? obj.people : [])
      .map((p, i) => normalizePerson(p, i))
      .filter((p): p is CopyPastePerson => p !== null),
  )

  const scene_events = (Array.isArray(obj.scene_events) ? obj.scene_events : [])
    .map(normalizeSceneEvent)
    .filter((e): e is CopyPasteSceneEvent => e !== null)

  const shots = (Array.isArray(obj.shots) ? obj.shots : [])
    .map(normalizeShot)
    .filter((s): s is CopyPasteShot => s !== null)

  const imperfections = Array.isArray(obj.imperfections)
    ? obj.imperfections.map(asString).filter(Boolean)
    : []

  return {
    format: asString(obj.format),
    people,
    environment: asString(obj.environment),
    lighting: asString(obj.lighting),
    color_grading: asString(obj.color_grading),
    atmosphere: asString(obj.atmosphere),
    audio: asString(obj.audio),
    pacing: asString(obj.pacing),
    background_activity: asString(obj.background_activity),
    scene_events,
    style: asString(obj.style),
    camera_logic: asString(obj.camera_logic),
    imperfections,
    shots,
    end_behavior: asString(obj.end_behavior),
    // Never trust the model's own copy — always the maintained constant.
    negative_prompt: NEGATIVE_PROMPT_TEMPLATE,
  }
}

async function downloadForTranscript(videoUrl: string): Promise<string> {
  const path = join(tmpdir(), `cp_speech_${randomUUID()}.mp4`)
  const res = await fetch(videoUrl, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`speech download failed: ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.byteLength) throw new Error('speech download empty')
  writeFileSync(path, buf)
  return path
}

/** Best-effort speech capture. Missing token or HF errors must not fail analysis. */
export async function transcribeSourceSpeech(videoUrl: string): Promise<string> {
  const token = process.env.HF_TOKEN
  if (!token) return ''

  let path: string | null = null
  try {
    path = await downloadForTranscript(videoUrl)
    const segments = await transcribeVideoFile(path, token, 12, 8)
    return segments.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim()
  } catch (err) {
    console.warn('[monitor/copy-paste-spec] transcript failed:', err instanceof Error ? err.message : err)
    return ''
  } finally {
    if (path) {
      try { if (existsSync(path)) unlinkSync(path) } catch {}
    }
  }
}

/**
 * One vision call over every probe frame (with measured duration/aspect ratio
 * injected as ground truth), then optional audio transcription merged in.
 */
export async function extractCopyPasteSpec(
  probe: Pick<SourceProbe, 'frames' | 'hasAudio' | 'duration' | 'aspectRatio'>,
  videoUrl?: string | null,
): Promise<CopyPasteSpec> {
  if (!probe.frames.length) throw new Error('No frames for copy-paste spec')

  let transcript = ''
  if (probe.hasAudio && videoUrl) {
    transcript = await transcribeSourceSpeech(videoUrl)
  }

  const raw = await callGrok({
    model: GROK_SMART,
    json: true,
    system: COPY_PASTE_SYSTEM,
    messages: [{
      role: 'user',
      content: [
        ...probe.frames.map(f => base64ImageContent(f)),
        {
          type: 'text',
          text: [
            `These ${probe.frames.length} frames are sampled in chronological order from one Reel.`,
            `Measured from the source file: duration ${probe.duration != null ? `${probe.duration.toFixed(1)}s` : 'unknown'}, aspect ratio ${probe.aspectRatio}.`,
            'Use these exact numbers in "format" — do not invent your own duration or aspect ratio.',
            transcript
              ? `Transcript of the spoken audio: "${transcript}"`
              : 'No speech detected — leave scene_events speaker/line empty where nobody talks.',
            'Fill the JSON completely, following RULE A (reference lock) and RULE B (normalization) exactly.',
          ].join(' '),
        },
      ],
    }],
    maxTokens: 4096,
    temperature: 0.2,
  })

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Copy-paste spec JSON parse failed')
  }

  return normalizeCopyPasteSpec(parsed)
}

/** Flattens the JSON into the single prose string Seedance's `prompt` field needs. */
export function renderCopyPastePrompt(spec: CopyPasteSpec): string {
  const blocks: string[] = []

  if (spec.format) blocks.push(spec.format)

  for (const p of spec.people) {
    const bits = [p.role, p.appearance, p.wardrobe].filter(Boolean)
    if (bits.length) blocks.push(`${p.id || 'Person'}: ${bits.join('. ')}.`)
  }

  const sceneBits = [
    spec.environment,
    spec.lighting && `Lighting: ${spec.lighting}`,
    spec.color_grading && `Color grading: ${spec.color_grading}`,
    spec.atmosphere && `Atmosphere: ${spec.atmosphere}`,
    spec.pacing && `Pacing: ${spec.pacing}`,
    spec.background_activity && `Background: ${spec.background_activity}`,
  ].filter(Boolean)
  if (sceneBits.length) blocks.push(sceneBits.join('. ') + '.')

  if (spec.audio) blocks.push(`Audio: ${spec.audio}.`)

  if (spec.scene_events.length) {
    const lines = spec.scene_events.map(e => {
      const who = e.speaker && e.speaker !== 'none' ? e.speaker : null
      const spoken = e.line ? `"${e.line}"${e.delivery ? ` (${e.delivery})` : ''}` : null
      return [e.timestamp, who && spoken ? `${who} says ${spoken}` : spoken, e.action]
        .filter(Boolean)
        .join(' — ')
    }).filter(Boolean)
    if (lines.length) blocks.push(`Timeline: ${lines.join(' → ')}.`)
  }

  const styleBits = [spec.style, spec.camera_logic && `Camera: ${spec.camera_logic}`].filter(Boolean)
  if (styleBits.length) blocks.push(styleBits.join('. ') + '.')

  if (spec.imperfections.length) {
    blocks.push(`Authentic imperfections: ${spec.imperfections.join(', ')}.`)
  }

  if (spec.shots.length) {
    const lines = spec.shots.map(s => {
      const bits = [s.time, s.action, s.camera_behavior].filter(Boolean)
      return bits.join(': ')
    }).filter(Boolean)
    if (lines.length) blocks.push(`Shots: ${lines.join(' | ')}.`)
  }

  if (spec.end_behavior) blocks.push(`Ends: ${spec.end_behavior}.`)

  if (spec.negative_prompt) blocks.push(`Avoid: ${spec.negative_prompt}.`)

  return blocks.join('\n\n')
}

/**
 * Short, instructional Seedream Edit prompt (terse comma/period directives,
 * not narrative prose) — composites the reference photo's identity onto the
 * source frame's exact pose/background/framing, wardrobe applied from the
 * already-normalized spec. Distinct from renderCopyPastePrompt above, which
 * is narrative and feeds Seedance's video prompt, not a still-image edit.
 */
export function renderKeyframeEditPrompt(spec: CopyPasteSpec): string {
  const locked = spec.people[0]
  const bits = [
    'Image 1 is the scene reference, image 2 is the identity reference.',
    'Keep the exact pose, camera framing, and background from image 1 unchanged.',
    "Replace the main subject's face and body identity with the person from image 2.",
    locked?.wardrobe && `Wardrobe: ${locked.wardrobe}.`,
    spec.environment && `Environment: ${spec.environment}.`,
    spec.lighting && `Lighting: ${spec.lighting}.`,
    'Photorealistic, natural skin texture, no beauty filter, no AI skin smoothing.',
    'Do not add any other people. Do not change the composition, angle, or background.',
  ].filter(Boolean)
  return bits.join(' ')
}
