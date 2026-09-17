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
import { PRESERVE_MOTION_CUE, REMOVE_ONSCREEN_TEXT } from '@/lib/monitor/copy-paste-spec'
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

/**
 * Deterministic (no Grok call) keyframe edit prompts. TEXT-ONLY generation —
 * no source video frame as an image input, per explicit user correction
 * (2026-09-17), reverting an earlier same-day change that passed the actual
 * source frame as "image 1" (the Copy-Paste pattern). That fix solved the
 * WRONG problem: it made the edit model copy whoever was visually prominent
 * in the real frame, which is not necessarily the character the user wants
 * their own identity mapped onto (confirmed live: a scene where the maid
 * drives the visible action, but the user's lead character was a different,
 * less-prominent person in frame).
 *
 * The actual fix is `customPrompt` (row.custom_prompt): the Telegram flow
 * already asks, per job, "add a specific instruction for the still" before
 * generation (see webhook route's stillprompt gate) — that free-text field
 * is where the user states the lead role explicitly (e.g. "the maid" /
 * "the blonde woman on the left"), and it is threaded through here as the
 * authoritative role line. When absent, this falls back to a generic
 * single-main-character instruction; for any scene with more than one
 * person, the user should use the instruction prompt to disambiguate.
 */
function leadRoleLine(customPrompt?: string | null): string {
  const trimmed = customPrompt?.trim()
  return trimmed
    ? `The identity-reference person plays this role in the scene: ${trimmed}. Give ONLY this role/character the identity-reference person's face and body — everyone else described below keeps their own separate appearance.`
    : 'The identity-reference person is the single main character in this scene — the one the camera and story center on. If more than one person is described below, do not blend their features together; only one of them is the identity-reference person.'
}

export function renderFirstFrameEditPrompt(context: KlingVideoContext, customPrompt?: string | null): string {
  const bits = [
    'The attached image is the identity reference photo: generate a brand new photorealistic first frame of the scene below, starring this exact person — same face, same body, same skin tone as the reference photo.',
    leadRoleLine(customPrompt),
    context.setting && `Scene: ${context.setting}`,
    context.camera && `Camera: ${context.camera}.`,
    REMOVE_ONSCREEN_TEXT,
    'Photorealistic, natural skin texture, no beauty filter, no AI skin smoothing.',
    'Do not add extra people beyond what the scene describes.',
  ].filter(Boolean)
  return bits.join(' ')
}

export function renderEndFrameEditPrompt(context: KlingVideoContext, customPrompt?: string | null): string {
  const bits = [
    'Image 1 is the just-generated first frame of this same shot, image 2 is the identity reference photo.',
    'Generate the END frame of the same continuous shot: the person must look IDENTICAL to image 1 — same face, same hair colour and styling, same wardrobe, same skin tone and lighting. Only the pose and framing advance to match the action described below.',
    leadRoleLine(customPrompt),
    context.character_action && `Action across the shot: ${context.character_action}`,
    context.camera && `Camera: ${context.camera}.`,
    PRESERVE_MOTION_CUE,
    REMOVE_ONSCREEN_TEXT,
    'Photorealistic, natural skin texture, no beauty filter, no AI skin smoothing.',
    'Do not add extra people beyond what the scene describes. Do not change the background/setting from image 1.',
  ].filter(Boolean)
  return bits.join(' ')
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
