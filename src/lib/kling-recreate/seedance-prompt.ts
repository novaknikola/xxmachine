/**
 * Converts the already-synthesized Kling-recreate analysis (context.shots,
 * a gapless timed beat breakdown already validated by synthesizeContext in
 * analyze.ts) into a Seedance 2.5 I2V "prompt" field, following the strict
 * WaveSpeed rules in D:\VScode\reels-analiza\docs\SEEDANCE-2.5-I2V.md.
 *
 * Text-only Grok pass (no images) — reformatting an existing analysis, not a
 * new vision pass. Ported from generate_seedance_prompt.py, same rule set,
 * confirmed working live in that Python pipeline this session.
 */
import { callGrok, GROK_FAST } from '@/lib/grok'
import type { KlingVideoContext } from './types'

const SYSTEM = `You convert a shot/beat breakdown of a short-form video into a Seedance
2.5 Image-to-Video "prompt" field, following these WaveSpeed rules exactly:

1. The still image (already generated separately) IS the first frame. Do NOT
   describe wardrobe, character appearance, set dressing, or anything else
   already visible in that static frame — only describe what happens/moves
   FROM that frame onward in time.
2. Write a gapless timeline in seconds covering the FULL duration, formatted
   like "0-2s: ... 2-5s: ... 5-8s: ...". No gaps, no overlaps.
3. For each segment, state the camera explicitly: hold / handheld shake / push
   in / pan / no zoom / eye-level / cut to [new framing]. If the source has a
   hard camera cut at a timestamp, say so plainly ("Cut to medium close-up on
   [character].").
4. State body motion, facial/expression change, and exact dialogue lines per
   segment, drawn from the beat data — keep dialogue verbatim.
5. Add an "Audio:" line: exact spoken lines in order + relevant sound effects
   (laughter, ambient room tone, etc.) or, if truly none, "No BGM — ambient
   and action sounds only."
6. Start the prompt with "Begin from the start image."
7. For any segment involving fast body contact, a lean-in, or close hand-to-
   body/hand-to-fabric motion (a kiss, an embrace, reaching across a desk) —
   describe the ACTION plainly and keep it to the core movement only. Do not
   pile on fine hand/finger positioning or fabric-texture detail for that
   segment; dense micro-detail on fast contact motion is what causes
   texture-swimming artifacts in I2V generation, so favor a simpler, broader
   description there over a highly granular one.
8. Dialogue lines must be plain and phonetically unambiguous — audio/voice
   generation mishears casual contractions and slang (a confirmed failure:
   "gotta even" was generated as "Got it, Evan."). Rewrite any risky
   contraction or elision from the source beat data into a clear equivalent
   that preserves meaning and tone (e.g. "gotta even" -> "has to be even"),
   while keeping lines short and natural, not stiff.
9. End with negative constraints on their own line(s): "No subtitles. No BGM."
   (only include constraints that actually apply).
10. Output ONLY the prompt text — no JSON, no markdown fences, no commentary,
    no re-statement of the rules. English only.`

function beatsToText(context: KlingVideoContext): string {
  return (context.shots ?? [])
    .filter(s => s.prompt?.trim())
    .map(s => `${s.t_start}-${s.t_end}s | ${s.prompt.trim()}`)
    .join('\n')
}

export async function buildSeedancePrompt(
  context: KlingVideoContext,
  dialogueOverride?: string | null,
): Promise<string> {
  const beatsText = beatsToText(context)
  if (!beatsText) {
    // No timed beats — fall back to the master prompt/hook/character_action
    // as one continuous segment rather than failing the render outright.
    return [
      'Begin from the start image.',
      `0-${context.duration_sec ?? 5}s: ${[context.character_action, context.camera].filter(Boolean).join(' ')}`,
      context.speech ? `Audio: ${context.speech}` : 'No BGM — ambient and action sounds only.',
      'No subtitles. No BGM.',
    ].join('\n')
  }

  const user = [
    `MECHANISM/HOOK: ${context.hook || '(none given)'}`,
    '',
    'BEATS (t_start-t_end | description):',
    beatsText,
    '',
    context.speech ? `TRANSCRIPT (for exact dialogue wording): ${context.speech}` : '',
    dialogueOverride ? `\nUSER-CONFIRMED SPEAKER CORRECTION (authoritative — use this attribution over anything in the beats above wherever they conflict): ${dialogueOverride}` : '',
    '',
    'Write the Seedance 2.5 I2V prompt now, following the system rules exactly.',
  ].filter(Boolean).join('\n')

  const result = await callGrok({
    model: GROK_FAST,
    temperature: 0.3,
    maxTokens: 2048,
    system: SYSTEM,
    messages: [{ role: 'user', content: user }],
  })
  return result.trim()
}

const DIALOGUE_SYSTEM = `You extract a compact "who says what" list from a shot
breakdown whose prose already has correct per-line speaker attribution baked
in (cross-referenced against mouth/speech state and transcript timestamps).
Output ONLY plain lines, one per spoken line, in chronological order, format
exactly:
Character: exact line
Use the character label as already used in the shots (e.g. "guest", "host",
a name). Skip beats with no dialogue (silence, laughter, reaction-only). Do
not add commentary, headers, or numbering — just the lines, nothing else.`

/**
 * Compact speaker:line summary for the dialogue-confirmation Telegram gate —
 * shown to the user BEFORE the Seedance prompt is built, per this session's
 * explicit ask: only the short dialogue list, never the full prompt, so
 * attribution mistakes can be caught/corrected cheaply before the expensive
 * prompt-synthesis + paid render steps.
 */
export async function extractDialogueSummary(context: KlingVideoContext): Promise<string> {
  const beatsText = beatsToText(context)
  if (!beatsText) return '(no dialogue detected)'

  const user = [
    'BEATS (t_start-t_end | description, attribution already correct in the prose):',
    beatsText,
    '',
    context.speech ? `TRANSCRIPT: ${context.speech}` : '',
  ].filter(Boolean).join('\n')

  const result = await callGrok({
    model: GROK_FAST,
    temperature: 0.1,
    maxTokens: 512,
    system: DIALOGUE_SYSTEM,
    messages: [{ role: 'user', content: user }],
  })
  const trimmed = result.trim()
  return trimmed || '(no dialogue detected)'
}

/**
 * Applies a user's free-text correction (e.g. "host says line 1, guest says
 * line 2") to the dialogue summary by folding it into the beats as a
 * high-priority override, then re-deriving the summary — mirrors how
 * analyze.ts already treats the transcript as higher-priority than the
 * visual read. Returns the corrected summary text to show back to the user
 * for a final confirm, and the override string to store + pass into
 * buildSeedancePrompt so the correction also survives into the final prompt.
 */
export async function applyDialogueCorrection(opts: {
  context: KlingVideoContext
  correction: string
}): Promise<{ summary: string; override: string }> {
  const beatsText = beatsToText(opts.context)
  const user = [
    'BEATS (t_start-t_end | description):',
    beatsText,
    '',
    `USER CORRECTION (authoritative — overrides the prose above wherever they conflict): ${opts.correction}`,
  ].join('\n')

  const result = await callGrok({
    model: GROK_FAST,
    temperature: 0.1,
    maxTokens: 512,
    system: DIALOGUE_SYSTEM,
    messages: [{ role: 'user', content: user }],
  })
  const summary = result.trim() || '(no dialogue detected)'
  return { summary, override: opts.correction.trim() }
}

const KEYFRAME_SYSTEM = `You write two image-generation prompts (first_frame_prompt and
last_frame_prompt) for Nano Banana Pro Edit, following this exact template and voice —
ported from the same house rules already validated in the Python idea-bank pipeline
this session built:

1. Opening sentence: FIRST decide whether this is genuinely professional/produced
   footage (real studio lighting rig, broadcast-grade camera) or phone/consumer-camera
   footage (the default for nearly all short-form social content, even a staged skit).
   Then write the matching opener:
     - If genuinely professional/produced: "A cinematic production still from a
       [niche/show type], high-resolution photo." + a lighting line.
     - If phone/consumer-camera (the common case): "A candid high-resolution phone
       photo from a [niche/show type]." + a lighting line describing the REAL
       practical/mixed lighting visible (not a studio rig).
   Never default to the cinematic/studio opener just because the content is scripted —
   scripted does not mean professionally shot.
2. One paragraph PER character visible in the frame, in left-to-right screen order,
   written in natural prose WITH pronouns ("she"/"he"/"her"/"his"). For the MAIN/
   CENTRAL character (whoever the reference photo attachment supplies identity for):
   a reference photo is supplied separately as an image attachment, so DO NOT describe
   their physical appearance AT ALL — no skin, face, build, hair color, or hairstyle,
   nothing. Their paragraph covers ONLY position in frame, expression/gaze, every
   visible clothing item in detail, and pose/what they're doing or holding. Every
   OTHER character (supporting cast) gets the full physical description as normal
   (skin, face, build, hair, then clothing, then pose).
   WARNING — this rule fails most often on tight close-ups of the main character's
   face: a closed-eyes/parted-lips framing pulls you toward describing lashes, lip
   texture/gloss, and hair strands as "part of the shot". They are NOT the same as
   expression. Describe ONLY the state/action of each feature in verb form ("eyes
   closed", "mouth softly parted") and STOP — no adjectives about how the feature
   itself looks.
3. A foreground/background paragraph: props, furniture, set dressing, background
   elements, depth. Never mention captions, subtitles, on-screen text, or overlaid
   words anywhere in this prompt, even if burned-in text is visible in the source —
   the image generation must not render any text on screen. If any card, sign,
   screen, or other flat surface that could carry text/logo is visible, describe it
   as blank/plain — never invent or imply real network/brand branding.
4. Close with a quality-tag line matching the capture-medium call from step 1: if
   professional/produced, "Hyper-realistic, 8k resolution, precise anatomical
   details, flawless fabric textures, cinematic depth of field."; if phone/consumer-
   camera, "Photorealistic, high-resolution phone photo, natural skin and fabric
   detail, authentic candid social-media snapshot quality."

first_frame_prompt describes the literal FIRST moment of the clip. last_frame_prompt
describes the literal LAST moment — the actual end state (expression/pose at that
final beat), not a summary of the whole video. English only, no quality tags outside
the closer, 120-220 words each, one paragraph each (character paragraphs can be
separate sentences within it). Return ONLY a JSON object:
{"first_frame_prompt": "...", "last_frame_prompt": "..."}`

export async function buildKeyframePrompts(opts: {
  context: KlingVideoContext
  firstFrameDescription: string | null
  lastFrameDescription: string | null
}): Promise<{ firstFramePrompt: string; lastFramePrompt: string }> {
  const user = [
    `NICHE/HOOK: ${opts.context.hook || opts.context.setting || '(none given)'}`,
    `ENVIRONMENT: ${opts.context.setting || '(none given)'}`,
    `CAMERA: ${opts.context.camera || '(none given)'}`,
    '',
    `FIRST FRAME (literal, from vision analysis): ${opts.firstFrameDescription || '(no description available)'}`,
    '',
    `LAST FRAME (literal, from vision analysis): ${opts.lastFrameDescription || '(no description available)'}`,
    '',
    'The main/central character (whoever the reference photo will supply identity for) ' +
      'is the one driving the hook/action — identify them from the descriptions above.',
    '',
    'Write first_frame_prompt and last_frame_prompt now, following the system rules exactly.',
  ].join('\n')

  const raw = await callGrok({
    model: GROK_FAST,
    temperature: 0.4,
    maxTokens: 1536,
    system: KEYFRAME_SYSTEM,
    messages: [{ role: 'user', content: user }],
  })
  let parsed: { first_frame_prompt?: string; last_frame_prompt?: string } = {}
  try {
    const match = raw.match(/\{[\s\S]*\}/)
    parsed = JSON.parse(match ? match[0] : raw)
  } catch {
    throw new Error('Keyframe prompt synthesis did not return valid JSON')
  }
  const firstFramePrompt = String(parsed.first_frame_prompt ?? '').trim()
  const lastFramePrompt = String(parsed.last_frame_prompt ?? '').trim()
  if (!firstFramePrompt || !lastFramePrompt) {
    throw new Error('Keyframe prompt synthesis returned an empty prompt')
  }
  return { firstFramePrompt, lastFramePrompt }
}

/**
 * Human-readable version of the prompt for the Telegram approval gate — same
 * text as what gets sent to Seedance, just wrapped with a short header so the
 * approval message reads clearly. Mirrors formatPromptSummary's role for
 * Kling in process-job.ts.
 */
export function formatSeedancePromptSummary(opts: {
  prompt: string
  durationSec: number
  resolution: string
}): string {
  const header = `🎬 <b>Ready for Seedance 2.5</b> · ${opts.durationSec}s · ${opts.resolution}`
  return `${header}\n\n${opts.prompt}`
}
