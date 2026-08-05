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
  /**
   * The phase of the body movement at this beat — the one field that has to
   * differ event to event. `action` answers "what task", which does not change
   * across a clip of someone doing one thing, and that is how a timeline of four
   * identical entries got produced.
   */
  motion: string
}

export interface CopyPasteShot {
  time: string
  action: string
  camera_behavior: string
  scene_event_cue: string
}

export interface CopyPasteSpec {
  format: string
  /**
   * The single reason a viewer stops scrolling, as a physical fact.
   *
   * Top level rather than on people[0] because enforceReferenceLock() overwrites
   * that person's `appearance` on every parse — anything living there is at risk
   * of being rewritten out from under itself.
   */
  hook: string
  /** How people[0]'s body moves across the clip: parts, driver, rhythm, amplitude. */
  subject_motion: string
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

/**
 * Which traits follow the identity reference rather than the scene.
 *
 * "Keep everything from image 1" is what makes the pose and background match,
 * but it also drags the source person's body and skin along with it — tattoos
 * on the original subject were turning up on the replacement. Stated generally
 * on purpose: it says where a trait comes from, not what any particular
 * character looks like.
 */
export const KEYFRAME_IDENTITY_LOCK =
  'hair colour, hair length and hairstyle, body proportions, bust size, build, skin tone ' +
  'and skin markings all follow image 2; ' +
  'do not copy the hair, tattoos, piercings, scars, birthmarks or body shape from image 1'

/** Always overwritten after parsing — never trust the model's own copy of this. */
export const NEGATIVE_PROMPT_TEMPLATE =
  'no smooth gimbal motion, no cinematic stabilization, no professional lighting, ' +
  'no beauty filter, no AI skin smoothing, no young girl, no young woman, no teenager, ' +
  'no child, no perfectly centered framing, no overly dramatic acting, no slow motion, ' +
  'no music video energy, no drone footage feel, ' +
  // The on-camera subject kept inheriting the camera operator's dialogue.
  'the on-camera subject does not speak other people\'s lines, ' +
  'no lip-syncing to off-screen dialogue, no mouthing words spoken by someone behind the camera, ' +
  // Skin marks belonging to the source subject were surviving the identity swap.
  'no tattoos, no visible body ink, no piercings not present on the identity reference'

/**
 * Seedream tends to "tidy" an edited subject into a neutral upright pose, which
 * deletes the very motion cue Seedance would otherwise animate from. Contains
 * nothing anatomical on purpose — it protects evidence already in the frame
 * rather than describing the body.
 */
const PRESERVE_MOTION_CUE =
  'Preserve any motion blur, hair displacement, cloth movement and body lean present in image 1 — ' +
  'do not straighten the pose, do not settle the subject into a neutral standing position.'

/** Forced value for whichever person (always people[0]) gets the reference photo. */
function referenceLockAppearance(genderHint: string): string {
  const isMan = /\b(male|man|guy|boyfriend|husband|coach|him|his)\b/i.test(genderHint)
  return `reference character is from image. Mature ${isMan ? 'man' : 'woman'}, realistic facial features, highly detailed.`
}

const NORMALIZATION_RULES = `
- Hair color: if the source subject's hair reads as pink (or any dyed pink/fantasy tone), describe it as hair only. Never write "pink hair","red hair", "ginger hair", "blonde hair" for anyone.
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
  "hook": "SEE RULE E. ONE sentence: the single specific thing that makes a viewer stop scrolling, stated as a physical fact a camera can see. This is the most important field in this JSON — everything else must be consistent with it.",
  "subject_motion": "SEE RULE E. How people[0]'s body actually moves across the whole clip: which parts move, what drives them, the rhythm and the amplitude. Movement only — never size or shape.",
  "people": [
    {
      "id": "short slug, e.g. female_subject / male_subject",
      "role": "their position/relationship in the shot",
      "appearance": "SEE RULE A BELOW",
      "wardrobe": "garments, colors, fabrics, footwear, accessories — clothing only, NO hair for people[0]. SEE RULE A and RULE B"
    }
  ],
  "environment": "location + visible props/background, one rich phrase",
  "lighting": "lighting direction/quality/mood",
  "color_grading": "overall look — warm/cool, contrast, filmic or flat phone-camera grade",
  "atmosphere": "mood/energy of the scene — must be consistent with \\"hook\\". Never a neutral task label when the clip is not really about the task.",
  "audio": "what's audible — dialogue presence, music, ambient sound, silence",
  "pacing": "editing rhythm — single continuous take, quick cuts, etc.",
  "background_activity": "anything happening behind/around the main action",
  "scene_events": [
    { "timestamp": "0:00", "speaker": "a person id from people[], or \\"offscreen\\" for a voice behind the camera, or \\"none\\" when nobody speaks — SEE RULE D", "line": "spoken words, or empty", "delivery": "tone of delivery", "action": "physical action at this moment", "motion": "SEE RULE E — the PHASE of the body movement at THIS timestamp, read off the frame nearest it. Must not repeat the previous scene_event's motion." }
  ],
  "style": "overall visual/production style in one phrase",
  "camera_logic": "how the camera behaves across the whole clip — handheld/static/framing logic",
  "imperfections": ["raw, authentic, amateur-feeling details actually visible — NOT invented"],
  "shots": [
    { "time": "0:00-0:07", "action": "what happens in this shot — describe the MOVEMENT, not the task category, and never with a stabilising adverb", "camera_behavior": "camera movement/framing for this shot", "scene_event_cue": "matching scene_events timestamp, or empty" }
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
only). Their "wardrobe" field describes CLOTHING ONLY — garments, colors, fabrics,
footwear, accessories. Write NOTHING about their hair: no color, no length, no
style, no texture. The hair comes from the reference photo, and describing the
source person's hair here overrides it. This applies to people[0] only.
For every OTHER person, "appearance" is a full description (build, face, skin,
hair, apparent age) — apply RULE B to it.

RULE B — FIXED NORMALIZATION (apply while writing, not as an afterthought):
${NORMALIZATION_RULES}

RULE C — NEVER WRITE negative_prompt YOURSELF. Always return it as an empty string.

RULE D — SPEECH ATTRIBUTION (CRITICAL):
The transcript has NO speaker labels, and whoever holds the camera is usually
not in frame at all. Do not assume the visible person said everything.
- Attribute a line to a person ONLY if that person is visible AND their mouth
  is open / mid-speech in the frame closest to that line's timestamp.
- If a line's timestamp lands on a frame where the visible person is silent,
  listening, reacting, or facing away, the speaker is behind the camera:
  set "speaker" to exactly "offscreen".
- If the transcript reads as a back-and-forth (a question then an answer, or
  two clearly different registers) but only one person is ever visible, then
  the second voice IS "offscreen". Never hand both halves to one person.
- A person may only be given lines that are plausibly their own. Never assign
  two different voices to the same person just because they are the only one
  on screen.
- When unsure, prefer "offscreen" over guessing. An unattributed line is
  harmless; a line put in the wrong mouth makes the recreated subject speak
  someone else's words.

RULE E — THE HOOK AND THE BODY MOTION (this is what the whole spec exists for):
A reel is not watched because of what the person is doing. It is watched because of
one specific thing that is visible while they do it. A description that would equally
well describe a hundred boring clips has missed the point, however accurate it is.

"hook" — one sentence, the single reason a viewer stops scrolling, written as a
physical fact a camera can see. Not a mood, not a topic. If the reason is the
subject's body, say WHICH PART and WHAT IT IS DOING, in plain anatomical words:
"her breasts bounce up and down with each downward chop", "her chest jiggles as she
laughs", "her top rides up when she reaches overhead". Do NOT soften this into
"secondary torso motion", "subtle movement" or any other euphemism — a vague hook
produces a video that misses the point of the source, which is the only way this
task can fail. If the real hook genuinely is not physical (a punchline, a reveal,
a reaction), say that plainly instead.

MOVEMENT ONLY, NEVER SIZE OR SHAPE. "breasts bounce with each chop" is right;
"large breasts bounce" is wrong. Body proportions come from the identity photo
(RULE A) — a size word here fights it and changes the wrong thing.

"subject_motion" — which parts move, what drives them, the rhythm, the amplitude.
Name the parts directly (chest, breasts, hips, thighs, shoulders, hair). Say what is
being moved BY something else rather than moved deliberately — that involuntary,
secondary movement is almost always what the clip is about, and it is the first
thing a text-to-video model drops unless told. Give tempo concretely ("about two
chops a second"), never as "steady".

"scene_events[].motion" — the PHASE at that exact timestamp. Two consecutive
scene_events must NEVER carry the same motion text. If the action is a repeating
cycle, break the cycle across the events: knife raised and chest lifted -> knife
driven down and chest drops -> chest rebounds and settles -> next lift. Four
identical entries means you described the task instead of the movement.

NEVER write "steadily", "calmly", "smoothly", "gently", "evenly" or "consistently"
about a moving body anywhere in this JSON. Those words instruct the video model to
damp the exact movement you were asked to capture.

RULE B does not apply here. RULE B normalizes hair colour, garment colour, ethnicity,
skin tone and age. It says nothing about how a body moves, and you must not
self-censor motion into vagueness in order to feel safe.

OTHER RULES:
- Be concrete and specific, not vague: every field must describe something a camera
  could see, never a mood word standing in for a fact. Shot-list register applies to
  the DESCRIPTIVE fields — environment, lighting, wardrobe, camera, format. It does
  NOT apply to "hook" and "subject_motion": those two exist precisely to say what a
  neutral transcription leaves out. A spec that is a perfect transcription and an
  empty hook has failed.
- Cross-check before returning: if the thing you named in "hook" does not also appear
  in "subject_motion" and in the scene_events' "motion" fields, the spec is wrong.
  Fix it rather than returning it.
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
  // A beat carrying only motion is exactly what the schema now asks for on a
  // wordless clip — dropping it here would delete the differentiation.
  const motion = asString(o.motion)
  if (!line && !action && !motion) return null
  return {
    timestamp: asString(o.timestamp),
    speaker: asString(o.speaker) || 'none',
    line,
    delivery: asString(o.delivery),
    action,
    motion,
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
    // Absent on every spec written before this field existed; '' renders nothing.
    hook: asString(obj.hook),
    subject_motion: asString(obj.subject_motion),
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

/**
 * Best-effort speech capture, kept **timestamped**. Whisper has no speaker
 * diarization, so timing is the only handle the vision model has for telling
 * an on-camera line from a voice behind the camera: it can check whether the
 * visible subject's mouth was moving in the frame nearest that moment.
 * Flattening this to one blob (as it once was) throws that signal away.
 */
export interface SourceTranscript {
  /** Formatted for the prompt. */
  text: string
  /** Mid-point of each spoken line, in seconds — where a frame is worth having. */
  lineTimes: number[]
}

/**
 * Transcript plus the times each line was spoken.
 *
 * The times matter as much as the words. RULE D asks the model to check whether
 * the visible person's mouth is moving at a line's timestamp, but frames were
 * sampled on an even grid that knows nothing about the transcript — so on a 20s
 * reel the nearest frame could be most of a second away from the line, and the
 * model was guessing. Guessing defaults to the person it can see, which is
 * exactly the failure: one speaker gets everybody's dialogue.
 */
export async function transcribeSourceSpeech(videoUrl: string): Promise<SourceTranscript> {
  const token = process.env.HF_TOKEN
  if (!token) return { text: '', lineTimes: [] }

  let path: string | null = null
  try {
    path = await downloadForTranscript(videoUrl)
    const segments = await transcribeVideoFile(path, token, 12, 8)
    const kept = segments.filter(s => s.text.trim().length > 4)

    return {
      text: kept
        .map(s => `[${s.start.toFixed(1)}s-${s.end.toFixed(1)}s] ${s.text.trim()}`)
        .filter(l => l.length > 12)
        .join('\n')
        .trim(),
      // Mid-line rather than the start: a speaker's mouth is reliably moving in
      // the middle of a phrase, while the first moment can still be a breath.
      lineTimes: kept.map(s => (s.start + s.end) / 2),
    }
  } catch (err) {
    console.warn('[monitor/copy-paste-spec] transcript failed:', err instanceof Error ? err.message : err)
    return { text: '', lineTimes: [] }
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
  probe: Pick<SourceProbe, 'frames' | 'frameTimes' | 'hasAudio' | 'duration' | 'aspectRatio'>,
  videoUrl?: string | null,
  preTranscript?: SourceTranscript | null,
): Promise<CopyPasteSpec> {
  if (!probe.frames.length) throw new Error('No frames for copy-paste spec')

  // Reuse the transcript the caller already fetched to pick frame times — it
  // costs a download plus a Whisper pass, and doing it twice would also risk
  // the two copies disagreeing about when a line was spoken.
  let transcript = preTranscript?.text ?? ''
  if (!preTranscript && probe.hasAudio && videoUrl) {
    transcript = (await transcribeSourceSpeech(videoUrl)).text
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
            probe.frameTimes?.length === probe.frames.length
              ? `Each frame's exact time in the clip, in order: ${probe.frameTimes.map(t => `${t.toFixed(1)}s`).join(', ')}.`
              : '',
            `Measured from the source file: duration ${probe.duration != null ? `${probe.duration.toFixed(1)}s` : 'unknown'}, aspect ratio ${probe.aspectRatio}.`,
            'Use these exact numbers in "format" — do not invent your own duration or aspect ratio.',
            transcript
              ? `Timestamped transcript of the audio (the speaker is NOT labelled — you must work out who is talking using RULE D):\n${transcript}`
              : 'No speech detected — leave scene_events speaker/line empty where nobody talks.',
            'Fill the JSON completely, following RULE A (reference lock), RULE B (normalization) and RULE D (speech attribution) exactly.',
          ].filter(Boolean).join(' '),
        },
      ],
    }],
    // A long reel with a differentiated motion line per beat can outgrow 4096,
    // and a truncated response fails JSON.parse and throws the analysis away.
    maxTokens: 6144,
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

  // Second, right after format: early tokens carry the most weight, and this is
  // the one thing the recreation kept losing. Deliberately unlabelled — "Hook:"
  // is a meta-token Seedance has nothing to ground, while a bare physical
  // sentence is the register an i2v model reads best. Sitting before the people
  // block also primes how the subject is then described.
  const hookBits = [spec.hook, spec.subject_motion].filter(Boolean)
  if (hookBits.length) blocks.push(hookBits.join(' '))

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
    // Only people actually in the cast may be given words to say. Anything the
    // model could not pin to a visible person — "offscreen", "none", a name
    // that is not in people[] — is reduced to an unquoted mention, so Seedance
    // has no text to lip-sync onto the on-camera subject. RULE D asks the model
    // to get this right; this is what makes it true regardless.
    const cast = new Set(spec.people.map(p => p.id).filter(Boolean))
    const lines = spec.scene_events.map(e => {
      const named = e.speaker && cast.has(e.speaker) ? e.speaker : null
      const quoted = e.line
        ? `"${e.line}"${e.delivery ? ` (${e.delivery})` : ''}`
        : null

      let speech: string | null = null
      if (named && quoted) {
        speech = `${named} says ${quoted}`
      } else if (quoted) {
        speech = 'a voice from behind the camera speaks, off-screen and unseen'
      }

      // Motion last so each beat ends on the movement rather than the task.
      return [e.timestamp, speech, e.action, e.motion].filter(Boolean).join(' — ')
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
    // The keyframe decides how the subject's body reads, and the scene
    // reference is the only thing that was describing it. Skin marks in
    // particular were being carried over from image 1 by "keep everything from
    // image 1", with nothing here to say otherwise.
    `Body and skin come from image 2, not image 1: ${KEYFRAME_IDENTITY_LOCK}.`,
    // The hook itself is deliberately NOT injected here — it would give Seedream a
    // second authority on body shape, contradicting the identity lock above. What
    // it can safely do is stop the edit from tidying the subject into a neutral
    // pose, which is what deletes the motion cue Seedance animates from.
    PRESERVE_MOTION_CUE,
    'Photorealistic, natural skin texture, no beauty filter, no AI skin smoothing.',
    'Do not add any other people. Do not change the composition, angle, or background.',
    // Negatives existed but only ever reached the video prompt, never the image
    // model that actually draws the person.
    spec.negative_prompt && `Avoid: ${spec.negative_prompt}.`,
  ].filter(Boolean)
  return bits.join(' ')
}

/**
 * End keyframe for Seedance's `last_image`. Deliberately chained: image 3 is the
 * already-rendered start keyframe, and appearance is pinned to it. Two
 * independent edits would drift on wardrobe/hair/skin detail, and Seedance would
 * then have to morph between two slightly different people across the clip —
 * worse than sending no end frame at all.
 */
export function renderEndKeyframeEditPrompt(spec: CopyPasteSpec): string {
  const locked = spec.people[0]
  const bits = [
    'Image 1 is the scene reference, image 2 is the identity reference, image 3 is the matching start frame of the same shot.',
    'Keep the exact pose, camera framing, and background from image 1 unchanged.',
    "Replace the main subject's face and body identity with the person from image 2.",
    'The person must look IDENTICAL to the person in image 3 — same face, same hair colour and styling, same wardrobe, same skin tone and lighting. Only the pose and framing differ.',
    locked?.wardrobe && `Wardrobe: ${locked.wardrobe}.`,
    PRESERVE_MOTION_CUE,
    'Photorealistic, natural skin texture, no beauty filter, no AI skin smoothing.',
    'Do not add any other people. Do not change the composition, angle, or background.',
  ].filter(Boolean)
  return bits.join(' ')
}
