import { one, query, rows } from '@/lib/db'
import { getUserApiKey } from '@/lib/user-config'
import { uploadImageFromUrl } from '@/lib/supabase-storage'
import {
  sendMediaGroup, sendPhoto, sendText, sendVideo,
  variationChoiceKeyboard, stillApprovalKeyboard, dialogueApprovalKeyboard, promptApprovalKeyboard,
} from '@/lib/telegram-recreate'
import { analyzeOneFpsVideo, analyzeOneFpsVideoFromFrames, analyzeScriptOnly } from './analyze'
import { extractOneFpsFrames } from './frames'
import { bankFreshIdeas } from './ideas'
import { syncKlingAnalysisSheetSafe } from './sheet-sync'
import {
  buildSeedanceI2VPayload,
  clampSeedanceDuration,
  generateSeedanceI2V,
  SEEDANCE_RESOLUTION_DEFAULT,
  SeedanceSubmitError,
  type SeedanceI2VInput,
  type SeedanceVariant,
} from './seedance-client'
import { editImageNanoBananaPro } from './nano-banana-client'
import { editImage as editImageSeedream, finalizeWithSkinEnhance } from '@/lib/wavespeed'
import {
  applyDialogueCorrection, buildSeedancePrompt, extractDialogueSummary,
  formatSeedancePromptSummary, renderEndFrameEditPrompt, renderFaceEndFramePrompt, renderFirstFrameEditPrompt,
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
    end_frame_mode: string
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

/** The end frame Seedance actually receives: none when the user chose
 * "No end frame" in the still gate, otherwise whatever is stored (the
 * scene-continuation frame, or the face close-up in 'face' mode). */
function lastImageFor(row: KlingRecreateJobRow): string | null {
  return row.end_frame_mode === 'none' ? null : row.end_frame_image_url ?? null
}

/**
 * Style-only anchor for a script-only job (no source video of its own to
 * ground its technical voice in) — the most recent REAL, already-approved
 * analysis for this user. Deliberately returns only setting/camera/
 * capture_style, never hook/character_action/shots, so no plot/character
 * content bleeds from one job into an unrelated one — see analyzeScriptOnly.
 */
async function loadStyleReferenceContext(userId: string): Promise<{
  setting: string
  camera: string
  capture_style: KlingVideoContext['capture_style']
} | null> {
  const row = await one<{ context: KlingVideoContext | null }>(
    `SELECT context FROM kling_recreate_jobs
      WHERE user_id = $1 AND is_script_only = false AND context IS NOT NULL
        AND status IN ('awaiting_still_approval', 'awaiting_dialogue_approval', 'awaiting_prompt_approval', 'rendering', 'done')
      ORDER BY updated_at DESC LIMIT 1`,
    [userId],
  )
  const ctx = row?.context
  if (!ctx?.setting) return null
  return { setting: ctx.setting, camera: ctx.camera ?? '', capture_style: ctx.capture_style ?? null }
}

async function notify(chatId: number | string | null | undefined, text: string, keyboard?: object) {
  if (chatId == null) return
  await sendText(chatId, text, keyboard).catch(err =>
    console.error('[kling-recreate] notify failed:', err),
  )
}

/** Bulk-sheet jobs only (row.source_label set) — prefixes an approval-gate
 * message so it's clear which of several simultaneous jobs it belongs to. */
function labelFor(row: Pick<KlingRecreateJobRow, 'source_label'>): string {
  return row.source_label ? `${escapeHtml(row.source_label)} — ` : ''
}

/** Bulk-sheet jobs only (row.sheet_row set) — mirrors the job's status back
 * onto its source Sheet row so the user can see progress without checking
 * Telegram. Best-effort: writeBulkRowStatus already swallows its own
 * errors, this just skips the call entirely for ordinary Telegram jobs. */
async function syncBulkRowSafe(row: Pick<KlingRecreateJobRow, 'sheet_row'>, fields: {
  status?: string
  jobId?: string
  videoUrl?: string
  error?: string
}): Promise<void> {
  if (!row.sheet_row) return
  const { writeBulkRowStatus } = await import('./bulk-sheet')
  await writeBulkRowStatus(row.sheet_row, fields)
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
/**
 * Resolves how many real identities this job needs and what each is called.
 * reference_photos (name->url map) wins when present — the multi-identity
 * path (2026-09-18). Otherwise falls back to the single reference_image_url,
 * labelled with whatever role/name the job already carries (lead_character
 * for a script-only job, custom_prompt for a normal one) — this is exactly
 * the pre-existing single-photo behaviour, unchanged.
 */
export function namedPhotosFromRow(row: KlingRecreateJobRow): { name: string | null; url: string }[] {
  const map = row.reference_photos
  if (map && typeof map === 'object') {
    const entries = Object.entries(map).filter((e): e is [string, string] => !!e[1])
    if (entries.length) return entries.map(([name, url]) => ({ name, url }))
  }
  if (row.reference_image_url) {
    const label = (row.is_script_only ? row.lead_character : row.custom_prompt)?.trim() || null
    return [{ name: label, url: row.reference_image_url }]
  }
  return []
}

async function generateStills(opts: {
  row: KlingRecreateJobRow
  context: KlingVideoContext | null
  apiKey: string
}): Promise<{ firstFrameUrl: string; endFrameUrl: string; firstFramePrompt: string; lastFramePrompt: string }> {
  const { row } = opts
  const photos = namedPhotosFromRow(row)
  if (!photos.length) throw new Error('No reference photo(s) on this job')

  const ctx = opts.context ?? {
    setting: '', hook: '', character_action: '', camera: '', speech: null,
    duration_sec: null, aspect_ratio: '9:16', shots: [], prompt_mode: 'prompt' as const,
  }

  const ambianceUrl = row.ambiance_photo_url?.trim() || null
  const hasAmbiance = !!ambianceUrl
  const identityUrls = photos.map(p => p.url)
  const isNsfw = row.still_model === 'seedream_nsfw'
  const modelLabel = isNsfw ? 'Seedream' : 'Nano Banana Pro'

  // Ambiance is deliberately first-frame only (2026-09-18, explicit user
  // ask): the end frame's own prompt already requires the background/
  // setting to stay IDENTICAL to the first-frame result, so the ambiance
  // photo is redundant there — dropping it also keeps the end-frame image
  // list one shorter, which matters given more reference images is exactly
  // what's been hurting multi-identity reliability.
  const firstFramePrompt = renderFirstFrameEditPrompt(ctx, photos, hasAmbiance)
  const lastFramePrompt = renderEndFrameEditPrompt(ctx, photos)

  // 2026-09-19: NSFW alternative — Seedream v5 Pro Edit + Z-Image Turbo
  // skin-enhance, the exact same workflow the main xxmachine bulk-generation
  // flow already uses (src/lib/wavespeed.ts). Same imageUrls/prompt shape
  // either model gets; chosen per job via row.still_model.
  const editStill = (imageUrls: string[], prompt: string) => isNsfw
    ? editImageSeedream({ imageUrls, prompt, size: ctx.aspect_ratio, apiKey: opts.apiKey })
    : editImageNanoBananaPro({ imageUrls, prompt, apiKey: opts.apiKey })

  const firstOutputs = await editStill(hasAmbiance ? [...identityUrls, ambianceUrl!] : identityUrls, firstFramePrompt)
  if (!firstOutputs.length) throw new Error(`${modelLabel}: no first-frame output`)
  // The RAW first-frame result (not yet skin-enhanced) is what feeds the
  // end-frame call — finalizeWithSkinEnhance is documented as a one-time
  // pass on a FINAL delivered image, never on something fed back into
  // another edit step.
  const firstRawUrl = firstOutputs[0]

  const endOutputs = await editStill([firstRawUrl, ...identityUrls], lastFramePrompt)
  if (!endOutputs.length) throw new Error(`${modelLabel}: no end-frame output`)
  const endRawUrl = endOutputs[0]

  const [finalFirstUrl, finalEndUrl] = isNsfw
    ? await Promise.all([
        finalizeWithSkinEnhance(firstRawUrl, ctx.aspect_ratio, opts.apiKey),
        finalizeWithSkinEnhance(endRawUrl, ctx.aspect_ratio, opts.apiKey),
      ])
    : [firstRawUrl, endRawUrl]

  const preparedFirst = await prepareKlingImage(finalFirstUrl, `kling-recreate/${row.user_id}/${row.id}/first-frame.jpg`)
  const preparedEnd = await prepareKlingImage(finalEndUrl, `kling-recreate/${row.user_id}/${row.id}/end-frame.jpg`)

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
      firstFrameUrl: row.character_image_url, endFrameUrl: row.end_frame_image_url,
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
        lastImage: lastImageFor(row),
      }),
      note,
    )
    if (!seedanceInput.prompt) {
      throw new Error('Variation job has no parent prompt to apply the change to')
    }
    await syncKlingAnalysisSheetSafe({
      jobId: row.id, sourceUrl: row.source_url, durationSec: sourceDuration, context, masterPrompt,
      status: `variation: ${note}`, klingVideoUrl: null,
      firstFrameUrl: row.character_image_url, endFrameUrl: row.end_frame_image_url,
    })
    return finishSeedanceRender({
      row, queueJobId: opts.queueJobId, userId: opts.userId, chatId,
      masterPrompt, context, sourceDuration, seedanceInput, apiKey,
    })
  }

  let videoUrl = row.video_url
  if (!row.is_script_only && !videoUrl) {
    await updateRecreate(row.id, { status: 'scraping' })
    await heartbeat(opts.queueJobId, 'scraping', { progress: 5 })
    videoUrl = await resolveRecreateVideoUrl(opts.userId, row.source_url)
    await updateRecreate(row.id, { video_url: videoUrl })
  }

  let context = (row.context ?? null) as KlingVideoContext | null
  let masterPrompt = row.master_prompt
  let sourceDuration = row.duration_sec != null ? Number(row.duration_sec) : null

  if (!masterPrompt && row.is_script_only) {
    await updateRecreate(row.id, { status: 'analyzing' })
    await heartbeat(opts.queueJobId, 'analyzing', { progress: 15 })
    await syncBulkRowSafe(row, { status: 'analyzing' })

    const styleReference = await loadStyleReferenceContext(opts.userId)
    const analysis = await analyzeScriptOnly({
      script: row.custom_prompt ?? '', styleReference,
      characterNames: Object.keys(row.reference_photos ?? {}),
    })
    masterPrompt = analysis.master_prompt
    context = analysis.context
    sourceDuration = analysis.context.duration_sec

    await updateRecreate(row.id, { status: 'analyzing', duration_sec: sourceDuration, context, master_prompt: masterPrompt })
    await heartbeat(opts.queueJobId, 'analyzed', { progress: 40 })
    await syncKlingAnalysisSheetSafe({
      jobId: row.id, sourceUrl: row.source_url, durationSec: sourceDuration, context, masterPrompt,
      status: 'analyzing', klingVideoUrl: row.kling_video_url,
      firstFrameUrl: null, endFrameUrl: null,
    })
    await notify(
      chatId,
      `🧠 Script-only analysis built — no source video used` +
        `${sourceDuration != null ? `, ~${sourceDuration.toFixed(1)}s` : ''}.`,
    )
  } else if (!masterPrompt) {
    if (!videoUrl) throw new Error('Missing video_url for a non-script-only job')
    await updateRecreate(row.id, { status: 'analyzing' })
    await heartbeat(opts.queueJobId, 'analyzing', { progress: 15 })
    await syncBulkRowSafe(row, { status: 'analyzing' })

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

    const analysis = await analyzeOneFpsVideo(extracted, videoUrl, row.custom_prompt, Object.keys(row.reference_photos ?? {}))
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
      firstFrameUrl: null, endFrameUrl: null,
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
      firstFrameUrl: row.character_image_url, endFrameUrl: row.end_frame_image_url,
    })
    const already = await one<{ n: number }>(`SELECT count(*)::int AS n FROM kling_idea_bank WHERE job_id = $1`, [row.id])
    if (!already?.n) {
      bankFreshIdeas({ userId: opts.userId, jobId: row.id, sourceUrl: row.source_url, context })
        .catch(err => console.error('[kling-recreate] idea bank retry failed:', err))
    }
  }

  await updateRecreate(row.id, { status: 'still' })
  await heartbeat(opts.queueJobId, 'still', { progress: 55 })
  await syncBulkRowSafe(row, { status: 'still' })
  const { firstFrameUrl, endFrameUrl, firstFramePrompt, lastFramePrompt } = await generateStills({ row, context, apiKey })
  await updateRecreate(row.id, {
    character_image_url: firstFrameUrl,
    end_frame_image_url: endFrameUrl,
    first_frame_prompt: firstFramePrompt,
    last_frame_prompt: lastFramePrompt,
    status: 'awaiting_still_approval',
  })
  await heartbeat(opts.queueJobId, 'awaiting_still_approval', { progress: 65 })
  await syncBulkRowSafe(row, { status: 'awaiting still approval' })
  await syncKlingAnalysisSheetSafe({
    jobId: row.id, sourceUrl: row.source_url, durationSec: sourceDuration, context, masterPrompt,
    status: 'awaiting still approval', klingVideoUrl: row.kling_video_url,
    firstFrameUrl, endFrameUrl,
  })

  if (chatId != null) {
    try {
      await sendMediaGroup(chatId, [firstFrameUrl, endFrameUrl], `${labelFor(row)}🖼️ First frame + end frame ready — review before Seedance.`)
    } catch {
      await notify(chatId, `${labelFor(row)}🖼️ First frame + end frame ready — review before Seedance.`)
    }
    await notify(chatId, `${labelFor(row)}Approve both to check the dialogue attribution, or regenerate.`, stillApprovalKeyboard(row.id))
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
  await syncBulkRowSafe(row, { status: 'awaiting dialogue approval' })
  await notify(
    chatId,
    `${labelFor(row)}🗣️ <b>Who says what</b> — check this before I build the prompt:\n\n${escapeHtml(summary)}\n\n` +
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
    character_image_url: null, end_frame_image_url: null, end_frame_mode: 'scene',
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
  await syncKlingAnalysisSheetSafe({
    jobId: row.id, sourceUrl: row.source_url, durationSec: row.duration_sec, context, masterPrompt: row.master_prompt,
    status: 'awaiting still approval', klingVideoUrl: row.kling_video_url,
    firstFrameUrl, endFrameUrl,
  })

  if (chatId != null) {
    try {
      await sendMediaGroup(chatId, [firstFrameUrl, endFrameUrl], `${labelFor(row)}🖼️ Regenerated — first frame + end frame.`)
    } catch {
      await notify(chatId, `${labelFor(row)}🖼️ Regenerated — first frame + end frame.`)
    }
    await notify(chatId, `${labelFor(row)}Approve both to check the dialogue attribution, or regenerate again.`, stillApprovalKeyboard(row.id))
  }
  return { ok: true, awaitingApproval: true }
}

/**
 * "No end frame" tapped in the still gate: remember the choice (Seedance then
 * gets no last_image, see lastImageFor) and continue exactly like a plain
 * approve — the dialogue check comes next.
 */
async function approveStillNoEnd(opts: {
  queueJobId: string
  userId: string
  input: KlingRecreateQueueInput
}): Promise<{ ok: true; awaitingApproval: true }> {
  await query(
    `UPDATE kling_recreate_jobs SET end_frame_mode = 'none', updated_at = now()
      WHERE id = $1 AND user_id = $2 AND status = 'awaiting_still_approval'`,
    [opts.input.recreateJobId, opts.userId],
  )
  return approveStill(opts)
}

/**
 * "Face close-up end" tapped in the still gate: replace the end frame with a
 * close-up of the lead's face (same scene, built from the approved first frame
 * + identity photo) and show both stills again for approval. One extra image
 * call, only on this explicit tap. The Seedance prompt then makes the last
 * ~0.5s a push-in to that close-up (see endFrameInstruction).
 */
async function faceEndFrame(opts: {
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
  const apiKey = await getUserApiKey(opts.userId, 'wavespeed_api_key')
  const context = (row.context ?? null) as KlingVideoContext | null
  const photos = namedPhotosFromRow(row)
  if (!photos.length) throw new Error('No reference photo(s) on this job')

  const ctx = context ?? {
    setting: '', hook: '', character_action: '', camera: '', speech: null,
    duration_sec: null, aspect_ratio: '9:16', shots: [], prompt_mode: 'prompt' as const,
  }
  const isNsfw = row.still_model === 'seedream_nsfw'
  const prompt = renderFaceEndFramePrompt(ctx, photos)
  const imageUrls = [row.character_image_url, ...photos.map(p => p.url)]

  await heartbeat(opts.queueJobId, 'still', { progress: 60 })
  const outputs = isNsfw
    ? await editImageSeedream({ imageUrls, prompt, size: ctx.aspect_ratio, apiKey })
    : await editImageNanoBananaPro({ imageUrls, prompt, apiKey })
  if (!outputs.length) throw new Error('Face close-up end frame: no output')
  const finalUrl = isNsfw ? await finalizeWithSkinEnhance(outputs[0], ctx.aspect_ratio, apiKey) : outputs[0]
  const prepared = await prepareKlingImage(finalUrl, `kling-recreate/${row.user_id}/${row.id}/end-frame-face-${Date.now()}.jpg`)

  await updateRecreate(row.id, {
    end_frame_image_url: prepared.url, last_frame_prompt: prompt, end_frame_mode: 'face',
  })
  await heartbeat(opts.queueJobId, 'awaiting_still_approval', { progress: 65 })

  if (chatId != null) {
    try {
      await sendMediaGroup(chatId, [row.character_image_url, prepared.url], `${labelFor(row)}👤 First frame + face close-up end frame (last ~0.5s).`)
    } catch {
      await notify(chatId, `${labelFor(row)}👤 Face close-up end frame ready.`)
    }
    await notify(chatId, `${labelFor(row)}Approve both, drop the end frame, or regenerate.`, stillApprovalKeyboard(row.id))
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
  }, row.confirmed_dialogue, row.end_frame_mode)
  if (!prompt.trim()) throw new Error('Seedance prompt synthesis returned nothing')

  const seedanceInput = buildSeedanceInput({
    image: row.character_image_url, prompt, sourceDuration,
    lastImage: lastImageFor(row),
  })

  await updateRecreate(row.id, {
    status: 'awaiting_prompt_approval',
    seedance_prompt: prompt,
    kling_request: seedanceInput as unknown as Record<string, unknown>,
    kling_variant: SEEDANCE_VARIANT,
  })
  await heartbeat(opts.queueJobId, 'awaiting_prompt_approval', { progress: 82 })
  await syncBulkRowSafe(row, { status: 'awaiting prompt approval' })
  await notify(
    chatId,
    labelFor(row) + formatSeedancePromptSummary({
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

  const existingContext = (row.context ?? null) as KlingVideoContext | null

  let frames: { t_sec: number; description: string }[] = []
  let transcript = ''
  if (!row.is_script_only) {
    const frameRows = await rows<{ t_sec: number; description: string | null }>(
      `SELECT t_sec, description FROM kling_recreate_frames WHERE job_id = $1 ORDER BY t_sec ASC`,
      [row.id],
    )
    frames = frameRows.filter(f => f.description).map(f => ({ t_sec: Number(f.t_sec), description: f.description! }))
    if (!frames.length) throw new Error('No stored frame descriptions to re-synthesize from')
    if (existingContext?.speech) transcript = existingContext.speech
  }

  await query(
    `UPDATE kling_recreate_jobs
        SET master_prompt = NULL, character_image_url = NULL, end_frame_image_url = NULL,
            end_frame_mode = 'scene', first_frame_prompt = NULL, last_frame_prompt = NULL, shot_stills = NULL,
            seedance_prompt = NULL, confirmed_dialogue = NULL,
            status = 'analyzing', updated_at = now()
      WHERE id = $1`,
    [row.id],
  )
  await heartbeat(opts.queueJobId, 'analyzing', { progress: 40 })

  const sourceDuration = row.duration_sec != null ? Number(row.duration_sec) : null
  const characterNames = Object.keys(row.reference_photos ?? {})
  const analysis = row.is_script_only
    ? await analyzeScriptOnly({
        script: row.custom_prompt ?? '',
        styleReference: await loadStyleReferenceContext(opts.userId),
        characterNames,
      })
    : await analyzeOneFpsVideoFromFrames({
        frames, duration: sourceDuration,
        aspectRatio: existingContext?.aspect_ratio ?? '9:16', transcript,
        manualContext: row.custom_prompt, characterNames,
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
  await syncKlingAnalysisSheetSafe({
    jobId: row.id, sourceUrl: row.source_url, durationSec: analysis.context.duration_sec ?? sourceDuration,
    context: analysis.context, masterPrompt: analysis.master_prompt,
    status: 'awaiting still approval', klingVideoUrl: row.kling_video_url,
    firstFrameUrl, endFrameUrl,
  })

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

export type ApprovePromptDisposition = 'cached' | 'run' | 'resume' | 'ignore'

/**
 * What approve_prompt must do for a job in this state.
 *  - 'cached' : the video already exists.
 *  - 'run'    : first approval (or a retry after a submit that never reached
 *               WaveSpeed and put the job back here).
 *  - 'resume' : THIS queue row already submitted to WaveSpeed (prediction id
 *               saved) and died while polling — keep polling that same
 *               prediction. Never submit again: it would bill twice.
 *  - 'ignore' : a duplicate tap or a stale retry from a different queue row; the
 *               job is somewhere else in the flow and must not be touched.
 * Before this existed the retry of a failed render fell into 'ignore', was
 * reported as success, and left the job in 'rendering' forever with no message.
 */
export function approvePromptDisposition(
  row: Pick<KlingRecreateJobRow, 'status' | 'kling_video_url' | 'kling_request'>,
  queueJobId: string,
): ApprovePromptDisposition {
  if (row.kling_video_url) return 'cached'
  if (!row.kling_request) return 'ignore'
  if (row.status === 'awaiting_prompt_approval') return 'run'
  const req = row.kling_request as { _prediction_id?: unknown; _queue_job_id?: unknown }
  if (
    row.status === 'rendering'
    && typeof req._prediction_id === 'string' && req._prediction_id
    && req._queue_job_id === queueJobId
  ) return 'resume'
  return 'ignore'
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
  const disposition = approvePromptDisposition(row, opts.queueJobId)
  if (disposition === 'cached') return { ok: true, videoUrl: row.kling_video_url!, cached: true }
  if (disposition === 'ignore') {
    console.warn(`[kling-recreate] approve_prompt ignored for ${row.id}: status=${row.status}`)
    return { ok: true, awaitingApproval: row.status === 'awaiting_prompt_approval' }
  }
  const chatId = opts.input.chatId ?? row.chat_id
  const context = (row.context ?? null) as KlingVideoContext | null
  const sourceDuration = row.duration_sec != null ? Number(row.duration_sec) : null
  const apiKey = await getUserApiKey(opts.userId, 'wavespeed_api_key')
  // `variant` defaulted because an older render attempt overwrote kling_request
  // with the bare payload, which has none, and the endpoint is chosen by it.
  const seedanceInput = { variant: SEEDANCE_VARIANT, ...(row.kling_request as object) } as unknown as SeedanceI2VInput

  return finishSeedanceRender({
    row, queueJobId: opts.queueJobId, userId: opts.userId, chatId,
    masterPrompt: row.master_prompt, context, sourceDuration, seedanceInput, apiKey,
    revertStatusOnSubmitFailure: disposition === 'run' ? 'awaiting_prompt_approval' : undefined,
  })
}

/**
 * The queue gave up on a render because WaveSpeed refused the SUBMIT (nothing
 * was billed, see SeedanceSubmitError). If finishSeedanceRender managed to put
 * the job back at the prompt gate, tell the person why and re-show the
 * Approve button so one tap retries — no re-analysis, no new stills. Returns
 * false when the job is not at that gate, so the caller fails it as before.
 */
export async function handleRenderSubmitFailure(opts: {
  recreateJobId: string
  chatId?: number | string | null
  err: SeedanceSubmitError
}): Promise<boolean> {
  const row = await one<Pick<KlingRecreateJobRow, 'status' | 'chat_id' | 'source_label'>>(
    `SELECT status, chat_id, source_label FROM kling_recreate_jobs WHERE id = $1`,
    [opts.recreateJobId],
  )
  if (!row || row.status !== 'awaiting_prompt_approval') return false

  const why =
    opts.err.kind === 'credits'
      ? 'your WaveSpeed account is out of credits. Top up, then tap Approve again.'
      : opts.err.kind === 'auth'
        ? 'WaveSpeed rejected the API key. Fix the key in Settings, then tap Approve again.'
        : opts.err.kind === 'invalid'
          ? `WaveSpeed rejected the request (${escapeHtml(opts.err.message.slice(0, 200))}). Tap Regenerate to rebuild the prompt, or Approve to try once more.`
          : 'WaveSpeed did not accept the job after several attempts. Tap Approve to try again.'
  await notify(
    opts.chatId ?? row.chat_id,
    `${labelFor(row)}⚠️ <b>Seedance did not start</b> — ${why}\nNothing was charged.`,
    promptApprovalKeyboard(opts.recreateJobId),
  )
  return true
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
  /** Where to put the job back if WaveSpeed refuses the SUBMIT (nothing was
   * billed). Only set for paths that have an approval gate to return to. */
  revertStatusOnSubmitFailure?: 'awaiting_prompt_approval'
}): Promise<{ ok: true; videoUrl: string }> {
  const { row, seedanceInput } = opts
  const existingRequestId =
    (row.kling_request as { _prediction_id?: string } | null)?._prediction_id ?? null

  const payload = buildSeedanceI2VPayload(seedanceInput)
  // kling_request is spread over the INPUT, not replaced by the bare payload:
  // the payload has no `variant`, and losing it made the row unsubmittable on
  // the next attempt (the endpoint is chosen by variant).
  const record = { ...seedanceInput, ...payload } as Record<string, unknown>
  await updateRecreate(row.id, {
    status: 'rendering',
    kling_variant: SEEDANCE_VARIANT,
    kling_request: existingRequestId
      ? { ...record, _prediction_id: existingRequestId, _queue_job_id: opts.queueJobId }
      : record,
  })
  await heartbeat(opts.queueJobId, 'rendering', { progress: 88 })
  await syncBulkRowSafe(row, { status: 'rendering' })

  let result: Awaited<ReturnType<typeof generateSeedanceI2V>>
  try {
    result = await generateSeedanceI2V(seedanceInput, opts.apiKey, {
      existingRequestId,
      onSubmitted: async (requestId, submitted) => {
        await updateRecreate(row.id, {
          kling_request: { ...seedanceInput, ...submitted, _prediction_id: requestId, _queue_job_id: opts.queueJobId },
        })
      },
    })
  } catch (err) {
    // A refused submit created no prediction and billed nothing, so the job goes
    // back to the prompt gate instead of sitting in 'rendering' — a retry (or the
    // person's next tap) can then run it. A failure AFTER submit is different: the
    // render may exist, so the row keeps its prediction id and is resumed, not reset.
    if (err instanceof SeedanceSubmitError && opts.revertStatusOnSubmitFailure) {
      await updateRecreate(row.id, {
        status: opts.revertStatusOnSubmitFailure,
        kling_request: seedanceInput as unknown as Record<string, unknown>,
      }).catch(e => console.error('[kling-recreate] could not revert job after submit failure:', e))
      await heartbeat(opts.queueJobId, opts.revertStatusOnSubmitFailure, { progress: 82 }).catch(() => {})
      await syncBulkRowSafe(row, { status: 'awaiting prompt approval' }).catch(() => {})
    }
    throw err
  }

  const hosted = await uploadImageFromUrl(
    result.videoUrl,
    `kling-recreate/${opts.userId}/${row.id}/out.mp4`,
  ).catch(() => result.videoUrl)

  // Best-effort — mirrors every other feature's usage of this queue, e.g.
  // infinite_talk's video output archive. Self-gates on the user's own
  // Drive-connect + drive_auto_archive settings, never throws.
  const { enqueueDriveArchive } = await import('@/lib/drive-archive/enqueue')
  await enqueueDriveArchive({
    userId: opts.userId,
    sourceType: 'queue_job',
    sourceId: row.id,
    urls: [hosted],
    characterKey: namedPhotosFromRow(row)[0]?.name ?? row.source_label ?? undefined,
    kind: 'reels',
    stage: 'ready',
    modelKey: 'seedance_2_5',
  }).catch(err => console.error('[kling-recreate] drive archive failed:', err))

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
    firstFrameUrl: row.character_image_url, endFrameUrl: row.end_frame_image_url,
  })
  await syncBulkRowSafe(row, { status: 'done', videoUrl: hosted })

  const note = (row.variation_note ?? '').trim()
  const caption =
    `${labelFor(row)}✅ Seedance 2.5 · ${durationForSeedance(opts.sourceDuration)}s` +
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
    case 'approve_still_no_end': return approveStillNoEnd(opts)
    case 'face_end_frame': return faceEndFrame(opts)
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
