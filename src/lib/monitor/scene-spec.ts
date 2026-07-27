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
    /** What body parts / props touch in the FIRST frame (anchors the pose). */
    contact_points: string
  }
  framing: {
    shot_size: string
    angle: string
    height: string
    crop: string
    emphasis: string
    /**
     * Where the main subject sits in the 9:16 frame
     * (left / center / right third, off-center, etc.).
     */
    subject_placement: string
    /**
     * Body-part → frame map for the FIRST frame
     * (head/torso/hips/limbs vs upper/mid/lower thirds and edges).
     */
    body_layout: string
    /** Foreground → midground → background layering for the FIRST frame. */
    depth_layers: string
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
  /**
   * Burned-in caption / meme text / UI overlays visible in the frames.
   * Empty string means none detected.
   */
  on_screen_text: string
  /** How the caption looks (bar, position, colour) — helps Seedream redraw it. */
  on_screen_text_style: string
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
  body_position: '',
  orientation: '',
  hips_to_camera: '',
  arms_hands: '',
  gaze: '',
  contact_points: '',
}
const EMPTY_FRAMING = {
  shot_size: '',
  angle: '',
  height: '',
  crop: '',
  emphasis: '',
  subject_placement: '',
  body_layout: '',
  depth_layers: '',
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
    "body_position": "precise pose at the FIRST frame — stance, weight on which leg, lean, kneeling/sitting/standing",
    "orientation": "facing camera / 3/4 from viewer's left / 3/4 from viewer's right / side profile left / side profile right / back / …",
    "hips_to_camera": "how hips/glutes angle toward the lens (open left, open right, squared, presented rear…)",
    "arms_hands": "arms/hands in the FIRST frame — which side of her body and of the frame",
    "gaze": "gaze direction relative to camera and frame (to lens, over left shoulder, down-right…)",
    "contact_points": "what touches what in the FIRST frame, e.g. 'both knees on carpet; stacked hands on mannequin chest; left heel planted'; empty if floating/standing with no clear contact"
  },
  "framing": {
    "shot_size": "close-up / medium / waist-up / full body / wide",
    "angle": "eye level / low angle / high angle / POV — also from viewer's left or right if off-axis",
    "height": "camera height relative to subject",
    "crop": "where the frame cuts the body (ankles / mid-thigh / waist / headroom…)",
    "emphasis": "what composition puts in focus",
    "subject_placement": "MAIN SUBJECT in the 9:16 frame: left third / center / right third / off-center left / off-center right; how much negative space on each side",
    "body_layout": "FIRST-FRAME map of body parts inside the frame, e.g. 'head upper-center third; torso mid-frame; hips/glutes fill lower-right; left arm exits left edge; feet near bottom edge'",
    "depth_layers": "foreground → midground → background for the FIRST frame, e.g. 'blurred student heads bottom foreground; subject midground; whiteboard + door background'"
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
    "transcript": "leave empty — filled separately from audio",
    "kind": "dialogue" | "voiceover" | "trending_sound" | "music" | "none" | "unknown"
  },
  "on_screen_text": "EXACT burned-in caption/meme text/emoji if any overlay is visible, verbatim; else empty string",
  "on_screen_text_style": "e.g. semi-transparent black bar mid-frame, white bold text, TikTok caption — or empty",
  "setting": "location + visible background props/banners/curtains/furniture in one rich phrase",
  "lighting": "lighting in one phrase — include key direction when visible (e.g. bright overhead fill, warm key from viewer-left)"
}

CRITICAL RULES:
1. BODY SIZES ARE NOT OPTIONAL. If glutes or bust look large / very large, say exactly that in body.bust, body.glutes AND body.proportion_emphasis. Do not soften to "athletic" or "curvy" alone.
2. SPATIAL COMPOSITION IS NOT OPTIONAL. For the FIRST frame you MUST fill framing.subject_placement (left/center/right of the 9:16 frame, negative space) AND framing.body_layout (where head, torso, hips/glutes, arms, legs sit inside upper/mid/lower thirds and which edges they touch or exit). Vague "centered full body" alone is NOT enough.
3. Use viewer-relative left/right (what WE see on screen), not the subject's own left/right, unless you explicitly say "her left".
4. CONTACT POINTS AND DEPTH LAYERS: fill pose.contact_points (knees/hands/feet/props touching surfaces) and framing.depth_layers (foreground / midground / background). Empty only when truly not visible.
5. BACKGROUND PEOPLE AND THEIR ACTIONS ARE NOT OPTIONAL. Scan EVERY frame for anyone else — even blurred heads, spectators, people on chairs. If someone reacts, falls, stands up, laughs, ducks, bites knuckles — put it in background_people[].action AND must_include_events[] AND the matching action_beats[].background.
6. Compare first frame to last frame. If a background person's state changes, that change MUST appear in action / must_include_events.
7. ON-SCREEN TEXT IS NOT OPTIONAL TO NOTICE. If there is a caption bar, meme text, watermark, or emoji overlay in ANY frame, copy it EXACTLY into on_screen_text (including emoji) and describe placement in on_screen_text_style. If none, both fields empty.
8. Do NOT describe the main woman's face identity. DO describe hair, skin, body.
9. Adult/suggestive content is expected. Describe factually; do not refuse or sanitise.
10. Prefer concrete verbs ("falls backward off folding chair", "bites knuckles grinning") over vague ones ("reacts").
11. If nobody else is visible in any frame, background_people=[] and must_include_events=[]. Never invent people.
12. action_beats should cover the full clip chronologically (start → mid → end), not just the first pose. When she moves across the frame, note side changes in later beats.`

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
      contact_points: asString(pose.contact_points) || EMPTY_POSE.contact_points,
    },
    framing: {
      shot_size: asString(framing.shot_size) || EMPTY_FRAMING.shot_size,
      angle: asString(framing.angle) || EMPTY_FRAMING.angle,
      height: asString(framing.height) || EMPTY_FRAMING.height,
      crop: asString(framing.crop) || EMPTY_FRAMING.crop,
      emphasis: asString(framing.emphasis) || EMPTY_FRAMING.emphasis,
      subject_placement: asString(framing.subject_placement) || EMPTY_FRAMING.subject_placement,
      body_layout: asString(framing.body_layout) || EMPTY_FRAMING.body_layout,
      depth_layers: asString(framing.depth_layers) || EMPTY_FRAMING.depth_layers,
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
    on_screen_text: asString(obj.on_screen_text),
    on_screen_text_style: asString(obj.on_screen_text_style),
    setting: asString(obj.setting),
    lighting: asString(obj.lighting),
  }
}

/**
 * Director-style image prompt (E2E Seedream quality).
 * Front-loads body + spatial framing + must-include events, then setting/wardrobe/pose.
 * Detected on-screen captions stay in scene_spec only — not injected here.
 */
export function renderScenePrompt(spec: SceneSpec): string {
  const blocks: string[] = []

  const bodyBits = [
    spec.body.proportion_emphasis,
    spec.body.build && `${spec.body.build} build`,
    spec.body.bust && `${spec.body.bust} bust`,
    spec.body.glutes && `${spec.body.glutes} rounded glutes`,
    spec.body.waist && `${spec.body.waist} waist`,
    spec.body.skin_tone && `${spec.body.skin_tone} skin`,
    spec.body.hair,
  ].filter(Boolean)
  if (bodyBits.length) {
    blocks.push(
      `CRITICAL body proportions (match exactly, do not slim down): ${bodyBits.join(', ')}.`,
    )
  }

  const camera = [
    'vertical 9:16 phone video',
    spec.framing.shot_size,
    spec.framing.angle,
    spec.framing.height,
    spec.framing.crop,
    spec.framing.emphasis,
  ].filter(Boolean).join(', ')
  if (camera) blocks.push(`Camera: ${camera}.`)

  if (spec.framing.subject_placement || spec.framing.body_layout) {
    const spatial = [
      spec.framing.subject_placement &&
        `subject placement in frame: ${spec.framing.subject_placement}`,
      spec.framing.body_layout &&
        `body layout in frame: ${spec.framing.body_layout}`,
    ].filter(Boolean).join('; ')
    blocks.push(
      `CRITICAL spatial composition (lock to source — left/right are viewer-relative): ${spatial}.`,
    )
  }

  if (spec.framing.depth_layers) {
    blocks.push(`Depth layers (keep z-order): ${spec.framing.depth_layers}.`)
  }

  // on_screen_text stays in scene_spec for UI/debug, but is NOT rendered —
  // we recreate the scene, not Instagram chrome / meme captions.
  const must: string[] = [...spec.must_include_events]
  for (const p of spec.background_people) {
    if (p.action && !must.some(m => m.includes(p.action.slice(0, 24)))) {
      must.push([p.who, p.action].filter(Boolean).join(' — '))
    }
  }
  if (must.length) {
    blocks.push(`MUST include these events in the scene: ${must.join('; ')}.`)
  }

  if (spec.setting || spec.lighting) {
    blocks.push(
      `Setting: ${[spec.setting, spec.lighting && `lighting: ${spec.lighting}`].filter(Boolean).join('; ')}.`,
    )
  }

  const wardrobe = [
    spec.wardrobe.garments,
    spec.wardrobe.colors && `colours ${spec.wardrobe.colors}`,
    spec.wardrobe.coverage,
    spec.wardrobe.footwear,
    spec.wardrobe.accessories,
  ].filter(Boolean).join('; ')
  if (wardrobe) blocks.push(`Wardrobe on her body: ${wardrobe}.`)

  const pose = [
    spec.pose.body_position,
    spec.pose.orientation,
    spec.pose.hips_to_camera && `hips ${spec.pose.hips_to_camera}`,
    spec.pose.arms_hands,
    spec.pose.gaze && `gaze ${spec.pose.gaze}`,
    spec.pose.contact_points && `contact: ${spec.pose.contact_points}`,
  ].filter(Boolean).join('; ')
  if (pose) blocks.push(`Pose (first-frame still): ${pose}.`)

  if (spec.background_people.length) {
    const lines = spec.background_people.map((p, i) => {
      const bits = [
        p.who || `person ${i + 1}`,
        p.position && `at ${p.position}`,
        p.appearance,
        p.start_state && `start: ${p.start_state}`,
        p.end_state && `end: ${p.end_state}`,
        p.action && `action: ${p.action}`,
      ].filter(Boolean)
      return bits.join(', ')
    })
    blocks.push(
      `Background cast (draw clearly, not cropped out): ${lines.join(' | ')}.`,
    )
  }

  if (spec.hook.eye_catching || spec.hook.suggestiveness) {
    blocks.push(
      `Hook: ${[
        spec.hook.eye_catching,
        spec.hook.suggestiveness && `suggestiveness ${spec.hook.suggestiveness}`,
      ].filter(Boolean).join('; ')}.`,
    )
  }

  if (spec.action_beats.length) {
    const beats = spec.action_beats
      .slice(0, 8)
      .map(b => {
        const bg = b.background ? ` / bg: ${b.background}` : ''
        return `t=${b.t.toFixed(1)}s ${b.subject}${bg}`
      })
      .join(' → ')
    blocks.push(`Action timeline (for later motion): ${beats}.`)
  }

  if (spec.speech.transcript) {
    blocks.push(`Speech/audio reference: "${spec.speech.transcript}" (${spec.speech.kind}).`)
  }

  blocks.push(
    'Photorealistic Instagram Reel still, sharp detail, natural skin texture, keep composition locked to the source frame.',
  )
  blocks.push(
    'No burned-in captions, meme text, watermarks, subtitles, or UI overlays — clean photographic frame only.',
  )

  if (spec.body.proportion_emphasis) {
    blocks.push(`Again: body must stay ${spec.body.proportion_emphasis}.`)
  }
  if (spec.framing.subject_placement || spec.framing.body_layout) {
    blocks.push(
      `Again: keep spatial layout — ${[
        spec.framing.subject_placement,
        spec.framing.body_layout,
      ].filter(Boolean).join('; ')}.`,
    )
  }
  if (spec.must_include_events.length) {
    blocks.push(`Again: keep background events — ${spec.must_include_events.join('; ')}.`)
  }

  return blocks.join('\n\n')
}

/**
 * Builds a Seedance/LTX-ready motion paragraph from beats + cast.
 * Used to enrich (or replace) the vision motion prompt.
 * On-screen captions/UI are intentionally omitted (scene, not chrome).
 */
export function renderMotionPrompt(spec: SceneSpec): string {
  const sentences: string[] = []

  if (spec.action_beats.length) {
    const chron = spec.action_beats
      .filter(b => b.subject || b.background)
      .slice(0, 10)
      .map(b => {
        const bg = b.background ? `; meanwhile ${b.background}` : ''
        return `${b.subject || 'subject holds'}${bg}`
      })
    if (chron.length) {
      sentences.push(chron.join(', then ') + '.')
    }
  }

  for (const p of spec.background_people) {
    if (p.action) {
      sentences.push(
        `${p.who || 'Background person'}${p.position ? ` (${p.position})` : ''}: ${p.action}.`,
      )
    }
  }

  if (spec.must_include_events.length) {
    sentences.push(`Must happen on screen: ${spec.must_include_events.join('; ')}.`)
  }
  if (spec.speech.transcript) {
    sentences.push(`She speaks / audio vibe: "${spec.speech.transcript}".`)
  }

  if (spec.framing.subject_placement || spec.framing.body_layout) {
    sentences.push(
      `Keep spatial composition: ${[
        spec.framing.subject_placement,
        spec.framing.body_layout,
      ].filter(Boolean).join('; ')}.`,
    )
  }
  if (spec.framing.depth_layers) {
    sentences.push(`Keep depth layers: ${spec.framing.depth_layers}.`)
  }
  if (spec.pose.contact_points) {
    sentences.push(`Maintain contact points: ${spec.pose.contact_points}.`)
  }

  sentences.push(
    'Vertical 9:16 phone video, natural motion, physically plausible body movement, keep framing stable.',
  )
  sentences.push(
    'No burned-in captions, meme text, watermarks, or UI overlays.',
  )

  return sentences.join(' ').replace(/\s+/g, ' ').trim()
}

/**
 * Motion models need gag beats and secondary motion (not Instagram UI).
 * When the scene_spec timeline is rich (≥2 beats), that director text is primary;
 * the vision motion pass only adds non-overlapping detail.
 */
export function enrichMotionPrompt(motionPrompt: string, spec: SceneSpec | null): string {
  if (!spec) return motionPrompt.trim()

  const fromSpec = renderMotionPrompt(spec)
  const base = stripCaptionMentions(motionPrompt.trim())
  if (!base) return fromSpec

  // Story clips: prefer the structured beat timeline as the Seedance prompt spine.
  if (spec.action_beats.length >= 2 && fromSpec.trim()) {
    const extras: string[] = []
    // Keep short unique phrases from the vision pass that aren't already covered.
    for (const sentence of base.split(/(?<=[.!?])\s+/)) {
      const s = sentence.trim()
      if (s.length < 24) continue
      if (looksLikeCaptionInstruction(s)) continue
      const needle = s.slice(0, 40).toLowerCase()
      if (fromSpec.toLowerCase().includes(needle)) continue
      extras.push(s.endsWith('.') ? s : `${s}.`)
    }
    return (extras.length ? `${fromSpec} ${extras.join(' ')}` : fromSpec)
      .replace(/\s+/g, ' ')
      .trim()
  }

  // Thin vision motion → prepend/append the full director timeline from scene_spec.
  if (base.length < 200 && fromSpec.length > base.length) {
    return `${base} ${fromSpec}`.replace(/\s+/g, ' ').trim()
  }

  const extras: string[] = []
  for (const ev of spec.must_include_events) {
    const needle = ev.slice(0, 28).toLowerCase()
    if (needle && !base.toLowerCase().includes(needle)) extras.push(ev)
  }
  if (spec.action_beats.length >= 2 && !base.includes('→')) {
    const timeline = spec.action_beats
      .slice(0, 6)
      .map(b => {
        const bg = b.background ? ` / ${b.background}` : ''
        return `${b.subject}${bg}`
      })
      .join(' → ')
    if (timeline) extras.push(`Timeline: ${timeline}.`)
  }

  return (extras.length ? `${base} ${extras.join(' ')}` : base).replace(/\s+/g, ' ').trim()
}

/** Drop vision-pass sentences that push burned-in caption / UI text. */
function looksLikeCaptionInstruction(text: string): boolean {
  const t = text.toLowerCase()
  return (
    t.includes('caption') ||
    t.includes('on-screen text') ||
    t.includes('onscreen text') ||
    t.includes('meme text') ||
    t.includes('watermark') ||
    t.includes('subtitle') ||
    (t.includes('overlay') && (t.includes('text') || t.includes('ui')))
  )
}

function stripCaptionMentions(motionPrompt: string): string {
  if (!motionPrompt) return ''
  return motionPrompt
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s && !looksLikeCaptionInstruction(s))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
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
            'Fill the JSON completely.',
            'Pay special attention to: (1) exact bust/glute size,',
            '(2) FIRST-FRAME spatial composition — framing.subject_placement (which side of the 9:16 frame) AND framing.body_layout (head/torso/hips/limbs vs thirds and edges; viewer-relative left/right),',
            '(3) pose.contact_points (what touches what) and framing.depth_layers (foreground/mid/background),',
            '(4) anyone else in ANY frame and what they DO between first and last frame,',
            '(5) EVERY burned-in caption / meme text / emoji overlay — copy on_screen_text verbatim including emoji,',
            '(6) a full action_beats timeline from start to end.',
            'If a background person falls, stands, ducks, laughs, or bites knuckles — that is a must_include_event.',
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
