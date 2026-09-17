import { one, query, rows } from '@/lib/db'
import { getUserApiKey } from '@/lib/user-config'
import { uploadImageFromUrl } from '@/lib/supabase-storage'
import {
  sendMediaGroup, sendPhoto, sendText, sendVideo,
  variationChoiceKeyboard, stillApprovalKeyboard, dialogueApprovalKeyboard, promptApprovalKeyboard,
} from '@/lib/telegram-recreate'
import { analyzeOneFpsVideo, analyzeOneFpsVideoFromFrames } from './analyze'
import { extractOneFpsFrames } from './frames'
import { bankFreshIdeas } from './ideas'
import { syncKlingAnalysisSheetSafe } from './sheet-sync'
import {
  buildSeedanceI2VPayload,
  clampSeedanceDuration,
  generateSeedanceI2V,
  SEEDANCE_RESOLUTION_DEFAULT,
  type SeedanceI2VInput,
  type SeedanceVariant,
} from './seedance-client'
import { editImageNanoBananaPro } from './nano-banana-client'
import {
  applyDialogueCorrection, buildSeedancePrompt, extractDialogueSummary,
  formatSeedancePromptSummary, renderEndFrameEditPrompt, renderFirstFrameEditPrompt,
} from './seedance-prompt'
import { prepareKlingImage } from './kling-image'
import { resolveRecreateVideoUrl } from './scrape'
import { applyVariationToSeedanceInput, variationSkipsUpstream } from './variation'
import type {
  KlingRecreateJobRow,
  KlingRecreateQueueInput,
  KlingVideoContext,
} from './types'

/** Fixed default — Kling-style per-user variant/quality settings are gone
 * (see plan doc); Seedance's own "spicy" endpoint is chosen only when a job
 * needs it, which isn't wired up as a user choice in this pass. */
const SEEDANCE_VARIANT: SeedanceVariant = 'standard'

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function heartbeat(queueId: string, stage: string, extra?: Record<string, unknown>) {
  await query(
    `UPDATE generation_queue
        SET output = coalesce(output, '{}'::jsonb) || $2::jsonb,
            progress = $3
      WHERE id = $1`,
    [
      queueId,
      JSON.stringify({ stage, progressAt: new Date().toISOString(), ...extra }),
      extra?.progress ?? 0,
    ],
  )
}

async function updateRecreate(
  id: string,
  fields: Partial<{
    status: string
    video_url: string
    duration_sec: number | null
    context: unknown
    master_prompt: string
    character_image_url: string | null
    end_frame_image_url: string | null
    first_frame_prompt: string | null
    last_frame_prompt: string | null
    shot_stills: unknown
    kling_video_url: string
    kling_variant: string
    kling_request: unknown
    seedance_prompt: string | null
    confirmed_dialogue: string | null
    error: string | null
  }>,
) {
  const sets: string[] = ['updated_at = now()']
  const vals: unknown[] = []
  let i = 1
  const jsonFields = new Set(['context', 'kling_request', 'shot_stills'])
  for (const [key, value] of Object.entries(fields)) {
    const cast = jsonFields.has(key) ? '::jsonb' : ''
    sets.push(`${key} = $${i++}${cast}`)
    vals.push(jsonFields.has(key) ? JSON.stringify(value) : value)
  }
  vals.push(id)
  await query(
    `UPDATE kling_recreate_jobs SET ${sets.join(', ')} WHERE id = $${i}`,
    vals,
  )
}

function durationForSeedance(sourceSec: number | null): number {
  return clampSeedanceDuration(sourceSec, SEEDANCE_VARIANT)
}

async function notify(chatId: number | string | null | undefined, text: string, keyboard?: object) {
  if (chatId == null) return
  await sendText(chatId, text, keyboard).catch(err =>
    console.error('[kling-recreate] notify failed:', err),
  )
}

async function sendDoneVideo(
  chatId: number | string | null | undefined,
  jobId: string,
  videoUrl: string,
  caption: string,
) {
  if (chatId == null) return
  const keyboard = variationChoiceKeyboard(jobId)
  try {
    await sendVideo(chatId, videoUrl, caption, keyboard)
  } catch {
    await sendText(chatId, `${caption}\n${escapeHtml(videoUrl)}`, keyboard).catch(err =>
      console.error('[kling-recreate] variation follow-up failed:', err),
    )
  }
}

/**
 * Generates BOTH keyframe stills via Nano Banana Pro Edit — TEXT-DRIVEN, no
 * source video frame as an image input (reverted 2026-09-17 per explicit
 * user correction; the source-frame approach tried right before this was
 * confirmed live to put the wrong character in the end frame anyway, since
 * "prominent in the real frame" isn't the same thing as "the character the
 * user wants their own identity mapped onto" — e.g. a scene where the maid
 * drives the visible action but the user's identity replaces a different,
 * less-prominent character).
 *   - First frame: [identity reference photo] + text prompt only.
 *   - End frame: [just-built first-frame result, identity reference photo]
 *     + text prompt — no source last frame either.
 * The "who is the lead" ambiguity that caused the earlier (2026-09-17,
 * pre-source-frame) text-only attempt to fail is resolved by threading
 * row.custom_prompt — the existing per-job "add a specific instruction"
 * question already asked in the Telegram flow before stills are generated
 * (see webhook route's stillprompt gate) — through as the authoritative
 * lead-role line, e.g. "the maid". No new gate needed; the infrastructure
 * already existed for this.
 * Seedance has no per-shot re-anchoring image like Kling's multi_prompt did,
 * so there is only ever one first/end pair per job — the multi-still/
 * shot_mode branch this used to have is gone; shot_mode/shot_stills stay in
 * the schema unused rather than migrated away.
 */
async function generateStills(opts: {
  row: KlingRecreateJobRow
  context: KlingVideoContext | null
  apiKey: string
}): Promise<{ firstFrameUrl: string; endFrameUrl: string; firstFramePrompt: string; lastFramePrompt: string }> {
  const { row } = opts
  const reference = row.reference_image_url
  if (!reference) throw new Error('No reference photo on this job')

  const ctx = opts.context ?? {
    setting: '', hook: '', character_action: '', camera: '', speech: null,
    duration_sec: null, aspect_ratio: '9:16', shots: [], prompt_mode: 'prompt' as const,
  }

  const firstFramePrompt = renderFirstFrameEditPrompt(ctx, row.custom_prompt)
  const lastFramePrompt = renderEndFrameEditPrompt(ctx, row.custom_prompt)

  const firstOutputs = await editImageNanoBananaPro({
    imageUrls: [reference],
    prompt: firstFramePrompt,
    apiKey: opts.apiKey,
  })
  if (!firstOutputs.length) throw new Error('Nano Banana Pro: no first-frame output')
  const preparedFirst = await prepareKlingImage(firstOutputs[0], `kling-recreate/${row.user_id}/${row.id}/first-frame.jpg`)

  const endOutputs = await editImageNanoBananaPro({
    imageUrls: [preparedFirst.url, reference],
    prompt: lastFramePrompt,
    apiKey: opts.apiKey,
  })
  if (!endOutputs.length) throw new Error('Nano Banana Pro: no end-frame output')
  const preparedEnd = await prepareKlingImage(endOutputs[0], `kling-recreate/${row.user_id}/${row.id}/end-frame.jpg`)

  return {
    firstFrameUrl: preparedFirst.url,
    endFrameUrl: preparedEnd.url,
    firstFramePrompt,
    lastFramePrompt,
  }
}

function buildSeedanceInput(opts: {
  image: string
  prompt: string
  sourceDuration: number | null
  lastImage?: string | null
}): SeedanceI2VInput {
  const input: SeedanceI2VInput = {
    variant: SEEDANCE_VARIANT,
    image: opts.image,
    prompt: opts.prompt,
    duration: durationForSeedance(opts.sourceDuration),
    resolution: SEEDANCE_RESOLUTION_DEFAULT,
    generate_audio: true,
  }
  if (opts.lastImage) input.last_image = opts.lastImage
  return input
}

/**
 * Phase 1: scrape -> 1fps analyze -> character still. Stops at
 * 'awaiting_still_approval' instead of continuing — a human checks the still
 * before anything paid beyond Seedream runs. Re-invoking this while already
 * past this stage is a no-op: it must never regenerate a paid still or
 * re-send the same notification on a cron retry.
 */
export async function processKlingRecreateJob(opts: {
  queueJobId: string
  userId: string
  input: KlingRecreateQueueInput
}): Promise<{ ok: true; videoUrl?: string; cached?: boolean; awaitingApproval?: boolean }> {
  const row = await one<KlingRecreateJobRow>(
    `SELECT * FROM kling_recreate_jobs WHERE id = $1 AND user_id = $2`,
    [opts.input.recreateJobId, opts.userId],
  )
  if (!row) throw new Error('kling_recreate_jobs row not found')
  const chatId = opts.input.chatId ?? row.chat_id
  const apiKey = await getUserApiKey(opts.userId, 'wavespeed_api_key')

  if (row.kling_video_url) {
    await heartbeat(opts.queueJobId, 'done', { progress: 100, cached: true })
    await syncKlingAnalysisSheetSafe({
      jobId: row.id, sourceUrl: row.source_url, durationSec: row.duration_sec,
      context: (row.context ?? null) as KlingVideoContext | null, masterPrompt: row.master_prompt,
      status: 'done', klingVideoUrl: row.kling_video_url,
    })
    return { ok: true, videoUrl: row.kling_video_url, cached: true }
  }
  if (row.status === 'awaiting_still_approval' || row.status === 'awaiting_dialogue_approval' || row.status === 'awaiting_prompt_approval') {
    return { ok: true, awaitingApproval: true }
  }

  // Variation children reuse the parent still + analysis and skip straight to
  // rendering — no approval gates, the parent's still/dialogue/prompt were
  // already approved.
  if (variationSkipsUpstream(row)) {
    if (!row.character_image_url) throw new Error('Variation job is missing the parent character still.')
    const note = (row.variation_note ?? '').trim()
    if (!note) throw new Error('Variation job is missing the change text.')

    const context = (row.context ?? null) as KlingVideoContext | null
    const masterPrompt = row.master_prompt
    const sourceDuration = row.duration_sec != null ? Number(row.duration_sec) : null
    const basePrompt = row.seedance_prompt || masterPrompt || ''
    const seedanceInput = applyVariationToSeedanceInput(
      buildSeedanceInput({
        image: row.character_image_url, prompt: basePrompt, sourceDuration,
        lastImage: row.end_frame_image_url,
      }),
      note,
    )
    if (!seedanceInput.prompt) {
      throw new Error('Variation job has no parent prompt to apply the change to')
    }
    await syncKlingAnalysisSheetSafe({
      jobId: row.id, sourceUrl: row.source_url, durationSec: sourceDuration, context, masterPrompt,
      status: `variation: ${note}`, klingVideoUrl: null,
    })
    return finishSeedanceRender({
      row, queueJobId: opts.queueJobId, userId: opts.userId, chatId,
      masterPrompt, context, sourceDuration, seedanceInput, apiKey,
    })
  }

  let videoUrl = row.video_url
  if (!videoUrl) {
    await updateRecreate(row.id, { status: 'scraping' })
    await heartbeat(opts.queueJobId, 'scraping', { progress: 5 })
    videoUrl = await resolveRecreateVideoUrl(opts.userId, row.source_url)
    await updateRecreate(row.id, { video_url: videoUrl })
  }

  let context = (row.context ?? null) as KlingVideoContext | null
  let masterPrompt = row.master_prompt
  let sourceDuration = row.duration_sec != null ? Number(row.duration_sec) : null

  if (!masterPrompt) {
    await updateRecreate(row.id, { status: 'analyzing' })
    await heartbeat(opts.queueJobId, 'analyzing', { progress: 15 })

    const extracted = await extractOneFpsFrames(videoUrl, `kling-recreate/${opts.userId}/${row.id}/frames`)
    sourceDuration = extracted.duration

    for (const frame of extracted.frames) {
      await query(
        `INSERT INTO kling_recreate_frames (job_id, t_sec, image_url)
         VALUES ($1, $2, $3)
         ON CONFLICT (job_id, t_sec) DO UPDATE SET image_url = EXCLUDED.image_url`,
        [row.id, frame.t_sec, frame.image_url],
      )
    }

    const ideasPromise = bankFreshIdeas({
      userId: opts.userId, jobId: row.id, sourceUrl: row.source_url,
      frames: extracted.frames.map(f => ({ t_sec: f.t_sec, description: null })), context: null,
    }).catch(err => { console.error('[kling-recreate] idea bank failed:', err); return 0 })

    const analysis = await analyzeOneFpsVideo(extracted, videoUrl)
    masterPrompt = analysis.master_prompt
    context = analysis.context
    sourceDuration = analysis.context.duration_sec ?? sourceDuration

    for (const frame of analysis.frames) {
      await query(
        `UPDATE kling_recreate_frames SET description = $3 WHERE job_id = $1 AND t_sec = $2`,
        [row.id, frame.t_sec, frame.description],
      )
    }

    await updateRecreate(row.id, { status: 'analyzing', duration_sec: sourceDuration, context, master_prompt: masterPrompt })
    await heartbeat(opts.queueJobId, 'analyzed', { progress: 40 })
    await syncKlingAnalysisSheetSafe({
      jobId: row.id, sourceUrl: row.source_url, durationSec: sourceDuration, context, masterPrompt,
      status: 'analyzing', klingVideoUrl: row.kling_video_url,
    })
    await notify(
      chatId,
      `🧠 Analysis stored — ${analysis.frames.length} frames @ 1fps` +
        `${sourceDuration != null ? `, ${sourceDuration.toFixed(1)}s` : ''}.`,
    )
    await ideasPromise
  } else {
    await syncKlingAnalysisSheetSafe({
      jobId: row.id, sourceUrl: row.source_url, durationSec: sourceDuration, context, masterPrompt,
      status: row.status, klingVideoUrl: row.kling_video_url,
    })
    const already = await one<{ n: number }>(`SELECT count(*)::int AS n FROM kling_idea_bank WHERE job_id = $1`, [row.id])
    if (!already?.n) {
      bankFreshIdeas({ userId: opts.userId, jobId: row.id, sourceUrl: row.source_url, context })
        .catch(err => console.error('[kling-recreate] idea bank retry failed:', err))
    }
  }

  await updateRecreate(row.id, { status: 'still' })
  await heartbeat(opts.queueJobId, 'still', { progress: 55 })
  const { firstFrameUrl, endFrameUrl, firstFramePrompt, lastFramePrompt } = await generateStills({ row, context, apiKey })
  await updateRecreate(row.id, {
    character_image_url: firstFrameUrl,
    end_frame_image_url: endFrameUrl,
    first_frame_prompt: firstFramePrompt,
    last_frame_prompt: lastFramePrompt,
    status: 'awaiting_still_approval',
  })
  await heartbeat(opts.queueJobId, 'awaiting_still_approval', { progress: 65 })

  if (chatId != null) {
    try {
      await sendMediaGroup(chatId, [firstFrameUrl, endFrameUrl], '🖼️ First frame + end frame ready — review before Seedance.')
    } catch {
      await notify(chatId, '🖼️ First frame + end frame ready — review before Seedance.')
    }
    await notify(chatId, 'Approve both to check the dialogue attribution, or regenerate.', stillApprovalKeyboard(row.id))
  }

  return { ok: true, awaitingApproval: true }
}

/**
 * Phase 2: still approved -> derive the compact speaker:line dialogue
 * summary and stop for a human to confirm WHO says WHAT before the prompt is
 * even built. Only the short list is shown here, never the full prompt (per
 * this session's explicit ask) — catching a misattribution here is much
 * cheaper than after the paid render.
 */
async function approveStill(opts: {
  queueJobId: string
  userId: string
  input: KlingRecreateQueueInput
}): Promise<{ ok: true; awaitingApproval: true }> {
  const row = await one<KlingRecreateJobRow>(
    `SELECT * FROM kling_recreate_jobs WHERE id = $1 AND user_id = $2`,
    [opts.input.recreateJobId, opts.userId],
  )
  if (!row) throw new Error('kling_recreate_jobs row not found')
  if (row.status !== 'awaiting_still_approval' || !row.character_image_url) {
    return { ok: true, awaitingApproval: true }
  }
  const chatId = opts.input.chatId ?? row.chat_id
  const context = (row.context ?? null) as KlingVideoContext | null

  const summary = await extractDialogueSummary(context ?? {
    setting: '', hook: '', character_action: '', camera: '', speech: null,
    duration_sec: null, aspect_ratio: '9:16', shots: [], prompt_mode: 'prompt',
  })

  await updateRecreate(row.id, { status: 'awaiting_dialogue_approval' })
  await heartbeat(opts.queueJobId, 'awaiting_dialogue_approval', { progress: 72 })
  await notify(
    chatId,
    `🗣️ <b>Who says what</b> — check this before I build the prompt:\n\n${escapeHtml(summary)}\n\n` +
      `Looks right? Tap Confirm. Wrong? Just reply with the correction (e.g. "host says line 1, guest says line 2").`,
    dialogueApprovalKeyboard(row.id),
  )
  return { ok: true, awaitingApproval: true }
}

/** The still missed — clear and redo off the existing analysis. Paid again, only on an explicit tap. */
async function regenerateStill(opts: {
  queueJobId: string
  userId: string
  input: KlingRecreateQueueInput
}): Promise<{ ok: true; awaitingApproval: true }> {
  const row = await one<KlingRecreateJobRow>(
    `SELECT * FROM kling_recreate_jobs WHERE id = $1 AND user_id = $2`,
    [opts.input.recreateJobId, opts.userId],
  )
  if (!row) throw new Error('kling_recreate_jobs row not found')
  const chatId = opts.input.chatId ?? row.chat_id
  const apiKey = await getUserApiKey(opts.userId, 'wavespeed_api_key')
  const context = (row.context ?? null) as KlingVideoContext | null

  await updateRecreate(row.id, {
    character_image_url: null, end_frame_image_url: null,
    first_frame_prompt: null, last_frame_prompt: null, status: 'still',
  })
  await heartbeat(opts.queueJobId, 'still', { progress: 55 })
  const { firstFrameUrl, endFrameUrl, firstFramePrompt, lastFramePrompt } = await generateStills({ row, context, apiKey })
  await updateRecreate(row.id, {
    character_image_url: firstFrameUrl, end_frame_image_url: endFrameUrl,
    first_frame_prompt: firstFramePrompt, last_frame_prompt: lastFramePrompt,
    status: 'awaiting_still_approval',
  })
  await heartbeat(opts.queueJobId, 'awaiting_still_approval', { progress: 65 })

  if (chatId != null) {
    try {
      await sendMediaGroup(chatId, [firstFrameUrl, endFrameUrl], '🖼️ Regenerated — first frame + end frame.')
    } catch {
      await notify(chatId, '🖼️ Regenerated — first frame + end frame.')
    }
    await notify(chatId, 'Approve both to check the dialogue attribution, or regenerate again.', stillApprovalKeyboard(row.id))
  }
  return { ok: true, awaitingApproval: true }
}

/**
 * Dialogue confirmed as-is -> build the actual Seedance prompt and stop
 * AGAIN for a human to read the exact prompt before the paid Seedance call
 * fires.
 */
async function approveDialogue(opts: {
  queueJobId: string
  userId: string
  input: KlingRecreateQueueInput
}): Promise<{ ok: true; awaitingApproval: true }> {
  const row = await one<KlingRecreateJobRow>(
    `SELECT * FROM kling_recreate_jobs WHERE id = $1 AND user_id = $2`,
    [opts.input.recreateJobId, opts.userId],
  )
  if (!row) throw new Error('kling_recreate_jobs row not found')
  if (row.status !== 'awaiting_dialogue_approval' || !row.character_image_url) {
    return { ok: true, awaitingApproval: true }
  }
  const chatId = opts.input.chatId ?? row.chat_id
  const context = (row.context ?? null) as KlingVideoContext | null
  const sourceDuration = row.duration_sec != null ? Number(row.duration_sec) : null

  const prompt = await buildSeedancePrompt(context ?? {
    setting: '', hook: '', character_action: '', camera: '', speech: null,
    duration_sec: null, aspect_ratio: '9:16', shots: [], prompt_mode: 'prompt',
  }, row.confirmed_dialogue)
  if (!prompt.trim()) throw new Error('Seedance prompt synthesis returned nothing')

  const seedanceInput = buildSeedanceInput({
    image: row.character_image_url, prompt, sourceDuration,
    lastImage: row.end_frame_image_url,
  })

  await updateRecreate(row.id, {
    status: 'awaiting_prompt_approval',
    seedance_prompt: prompt,
    kling_request: seedanceInput as unknown as Record<string, unknown>,
    kling_variant: SEEDANCE_VARIANT,
  })
  await heartbeat(opts.queueJobId, 'awaiting_prompt_approval', { progress: 82 })
  await notify(
    chatId,
    formatSeedancePromptSummary({
      prompt, durationSec: seedanceInput.duration ?? durationForSeedance(sourceDuration),
      resolution: seedanceInput.resolution ?? SEEDANCE_RESOLUTION_DEFAULT,
    }),
    promptApprovalKeyboard(row.id),
  )
  return { ok: true, awaitingApproval: true }
}

/**
 * User sent a free-text speaker correction while awaiting dialogue approval —
 * re-derive the summary with that correction folded in (top priority over
 * the beats' own prose) and show it again for a final confirm. Does NOT
 * advance the status; the user still has to tap Confirm once they're happy.
 */
export async function correctDialogue(opts: {
  queueJobId: string
  userId: string
  input: KlingRecreateQueueInput
  correction: string
}): Promise<{ ok: true; awaitingApproval: true }> {
  const row = await one<KlingRecreateJobRow>(
    `SELECT * FROM kling_recreate_jobs WHERE id = $1 AND user_id = $2`,
    [opts.input.recreateJobId, opts.userId],
  )
  if (!row) throw new Error('kling_recreate_jobs row not found')
  if (row.status !== 'awaiting_dialogue_approval') return { ok: true, awaitingApproval: true }
  const chatId = opts.input.chatId ?? row.chat_id
  const context = (row.context ?? null) as KlingVideoContext | null

  const { summary, override } = await applyDialogueCorrection({
    context: context ?? {
      setting: '', hook: '', character_action: '', camera: '', speech: null,
      duration_sec: null, aspect_ratio: '9:16', shots: [], prompt_mode: 'prompt',
    },
    correction: opts.correction,
  })
  await updateRecreate(row.id, { confirmed_dialogue: override })
  await notify(
    chatId,
    `🗣️ <b>Updated</b>:\n\n${escapeHtml(summary)}\n\nGood now? Tap Confirm, or reply again with another fix.`,
    dialogueApprovalKeyboard(row.id),
  )
  return { ok: true, awaitingApproval: true }
}

/**
 * The prompt/shots missed — redo the synthesis (NOT the per-frame Grok
 * description pass, that part was fine and re-running it would just re-spend
 * on identical work) off the already-stored 1fps frame descriptions, then
 * redo the still for whatever shots come out this time. Goes back through
 * the dialogue gate too, since a re-synthesis can change attribution.
 */
async function regeneratePrompt(opts: {
  queueJobId: string
  userId: string
  input: KlingRecreateQueueInput
}): Promise<{ ok: true; awaitingApproval: true }> {
  const row = await one<KlingRecreateJobRow>(
    `SELECT * FROM kling_recreate_jobs WHERE id = $1 AND user_id = $2`,
    [opts.input.recreateJobId, opts.userId],
  )
  if (!row) throw new Error('kling_recreate_jobs row not found')
  const chatId = opts.input.chatId ?? row.chat_id
  const apiKey = await getUserApiKey(opts.userId, 'wavespeed_api_key')

  const frameRows = await rows<{ t_sec: number; description: string | null }>(
    `SELECT t_sec, description FROM kling_recreate_frames WHERE job_id = $1 ORDER BY t_sec ASC`,
    [row.id],
  )
  const frames = frameRows.filter(f => f.description).map(f => ({ t_sec: Number(f.t_sec), description: f.description! }))
  if (!frames.length) throw new Error('No stored frame descriptions to re-synthesize from')

  let transcript = ''
  const existingContext = (row.context ?? null) as KlingVideoContext | null
  if (existingContext?.speech) transcript = existingContext.speech

  await query(
    `UPDATE kling_recreate_jobs
        SET master_prompt = NULL, character_image_url = NULL, end_frame_image_url = NULL,
            first_frame_prompt = NULL, last_frame_prompt = NULL, shot_stills = NULL,
            seedance_prompt = NULL, confirmed_dialogue = NULL,
            status = 'analyzing', updated_at = now()
      WHERE id = $1`,
    [row.id],
  )
  await heartbeat(opts.queueJobId, 'analyzing', { progress: 40 })

  const sourceDuration = row.duration_sec != null ? Number(row.duration_sec) : null
  const analysis = await analyzeOneFpsVideoFromFrames({
    frames, duration: sourceDuration,
    aspectRatio: existingContext?.aspect_ratio ?? '9:16', transcript,
  })

  await updateRecreate(row.id, { context: analysis.context, master_prompt: analysis.master_prompt })
  await heartbeat(opts.queueJobId, 'analyzed', { progress: 50 })
  await notify(chatId, '🧠 Re-analyzed. Building a new character still…')

  await updateRecreate(row.id, { status: 'still' })
  const { firstFrameUrl, endFrameUrl, firstFramePrompt, lastFramePrompt } = await generateStills({ row, context: analysis.context, apiKey })
  await updateRecreate(row.id, {
    character_image_url: firstFrameUrl, end_frame_image_url: endFrameUrl,
    first_frame_prompt: firstFramePrompt, last_frame_prompt: lastFramePrompt,
    status: 'awaiting_still_approval',
  })
  await heartbeat(opts.queueJobId, 'awaiting_still_approval', { progress: 65 })

  if (chatId != null) {
    try {
      await sendMediaGroup(chatId, [firstFrameUrl, endFrameUrl], '🖼️ New analysis — first frame + end frame ready.')
    } catch {
      await notify(chatId, '🖼️ New analysis — first frame + end frame ready.')
    }
    await notify(chatId, 'Approve both to check the dialogue attribution, or regenerate.', stillApprovalKeyboard(row.id))
  }
  return { ok: true, awaitingApproval: true }
}

/** Prompt approved -> the actual paid Seedance call. */
async function approvePrompt(opts: {
  queueJobId: string
  userId: string
  input: KlingRecreateQueueInput
}): Promise<{ ok: true; videoUrl?: string; cached?: boolean; awaitingApproval?: boolean }> {
  const row = await one<KlingRecreateJobRow>(
    `SELECT * FROM kling_recreate_jobs WHERE id = $1 AND user_id = $2`,
    [opts.input.recreateJobId, opts.userId],
  )
  if (!row) throw new Error('kling_recreate_jobs row not found')
  if (row.kling_video_url) return { ok: true, videoUrl: row.kling_video_url, cached: true }
  if (row.status !== 'awaiting_prompt_approval' || !row.kling_request) {
    return { ok: true, awaitingApproval: row.status === 'awaiting_prompt_approval' }
  }
  const chatId = opts.input.chatId ?? row.chat_id
  const context = (row.context ?? null) as KlingVideoContext | null
  const sourceDuration = row.duration_sec != null ? Number(row.duration_sec) : null
  const apiKey = await getUserApiKey(opts.userId, 'wavespeed_api_key')
  const seedanceInput = row.kling_request as unknown as SeedanceI2VInput

  return finishSeedanceRender({
    row, queueJobId: opts.queueJobId, userId: opts.userId, chatId,
    masterPrompt: row.master_prompt, context, sourceDuration, seedanceInput, apiKey,
  })
}

async function finishSeedanceRender(opts: {
  row: KlingRecreateJobRow
  queueJobId: string
  userId: string
  chatId: number | string | null | undefined
  masterPrompt: string | null
  context: KlingVideoContext | null
  sourceDuration: number | null
  seedanceInput: SeedanceI2VInput
  apiKey: string
}): Promise<{ ok: true; videoUrl: string }> {
  const { row, seedanceInput } = opts
  const existingRequestId =
    (row.kling_request as { _prediction_id?: string } | null)?._prediction_id ?? null

  const payload = buildSeedanceI2VPayload(seedanceInput)
  await updateRecreate(row.id, {
    status: 'rendering',
    kling_variant: SEEDANCE_VARIANT,
    kling_request: existingRequestId ? { ...payload, _prediction_id: existingRequestId } : payload,
  })
  await heartbeat(opts.queueJobId, 'rendering', { progress: 88 })

  const result = await generateSeedanceI2V(seedanceInput, opts.apiKey, {
    existingRequestId,
    onSubmitted: async (requestId, submitted) => {
      await updateRecreate(row.id, { kling_request: { ...submitted, _prediction_id: requestId } })
    },
  })

  const hosted = await uploadImageFromUrl(
    result.videoUrl,
    `kling-recreate/${opts.userId}/${row.id}/out.mp4`,
  ).catch(() => result.videoUrl)

  await updateRecreate(row.id, {
    status: 'done',
    kling_video_url: hosted,
    kling_variant: SEEDANCE_VARIANT,
    kling_request: { ...result.payload, _prediction_id: result.requestId, _model: result.model },
    error: null,
  })
  await heartbeat(opts.queueJobId, 'done', { progress: 100, videoUrl: hosted })
  await syncKlingAnalysisSheetSafe({
    jobId: row.id, sourceUrl: row.source_url, durationSec: opts.sourceDuration,
    context: opts.context, masterPrompt: opts.masterPrompt, status: 'done', klingVideoUrl: hosted,
  })

  const note = (row.variation_note ?? '').trim()
  const caption =
    `✅ Seedance 2.5 · ${durationForSeedance(opts.sourceDuration)}s` +
    `${note ? ` · ${escapeHtml(note)}` : ''}`
  await sendDoneVideo(opts.chatId, row.id, hosted, caption)

  return { ok: true, videoUrl: hosted }
}

/** Single entry point the queue dispatcher calls — routes on input.action. */
export async function runKlingRecreateAction(opts: {
  queueJobId: string
  userId: string
  input: KlingRecreateQueueInput
}): Promise<{ ok: true; videoUrl?: string; cached?: boolean; awaitingApproval?: boolean }> {
  switch (opts.input.action) {
    case 'approve_still': return approveStill(opts)
    case 'regenerate_still': return regenerateStill(opts)
    case 'approve_dialogue': return approveDialogue(opts)
    case 'correct_dialogue':
      if (!opts.input.correction) throw new Error('correct_dialogue requires input.correction')
      return correctDialogue({ ...opts, correction: opts.input.correction })
    case 'approve_prompt': return approvePrompt(opts)
    case 'regenerate_prompt': return regeneratePrompt(opts)
    case 'analyze':
    default:
      return processKlingRecreateJob(opts)
  }
}
