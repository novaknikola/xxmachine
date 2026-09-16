import { one, query, rows } from '@/lib/db'
import { getUserApiKey } from '@/lib/user-config'
import { generateCopyPasteKeyframe } from '@/lib/monitor/replicate'
import { uploadImageFromUrl } from '@/lib/supabase-storage'
import {
  sendPhoto, sendMediaGroup, sendText, sendVideo,
  variationChoiceKeyboard, stillApprovalKeyboard, promptApprovalKeyboard,
} from '@/lib/telegram-recreate'
import { analyzeOneFpsVideo, analyzeOneFpsVideoFromFrames, renderRecreateKeyframePrompt } from './analyze'
import { extractOneFpsFrames } from './frames'
import { bankFreshIdeas } from './ideas'
import { syncKlingAnalysisSheetSafe } from './sheet-sync'
import {
  buildKlingI2VPayload,
  clampKlingDuration,
  generateKlingI2V,
  type KlingI2VInput,
  type KlingVariant,
} from './kling-client'
import { prepareKlingImage } from './kling-image'
import { resolveRecreateVideoUrl } from './scrape'
import { normalizeSettings } from './settings'
import { applyVariationToKlingInput, variationSkipsUpstream } from './variation'
import type {
  KlingRecreateJobRow,
  KlingRecreateQueueInput,
  KlingShotBeat,
  KlingShotStill,
  KlingUserSettings,
  KlingVideoContext,
} from './types'

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
    shot_stills: unknown
    kling_video_url: string
    kling_variant: string
    kling_request: unknown
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

function durationForKling(sourceSec: number | null, settings: KlingUserSettings): number {
  if (settings.duration_mode === 'fixed' && settings.duration_sec != null) {
    return clampKlingDuration(settings.duration_sec)
  }
  return clampKlingDuration(sourceSec)
}

function allocateShotDurations(shots: KlingShotBeat[], total: number) {
  const n = shots.length
  const base = Math.floor(total / n)
  let remainder = total - base * n
  return shots.map(s => {
    const d = base + (remainder > 0 ? 1 : 0)
    if (remainder > 0) remainder--
    return { prompt: s.prompt, duration: Math.max(1, d) }
  })
}

/**
 * multi_shot only actually applies when the analysis found >=2 beats — a
 * clip with one continuous beat has nothing to split, so it silently behaves
 * like one_shot regardless of what the user picked. one_shot always ignores
 * shots even if the analysis found several.
 */
function effectivePromptMode(
  shotMode: 'one_shot' | 'multi_shot' | null | undefined,
  shots: KlingShotBeat[],
): 'prompt' | 'multi_prompt' {
  if (shotMode === 'multi_shot' && shots.length >= 2 && shots.length <= 6) return 'multi_prompt'
  return 'prompt'
}

function buildKlingInput(opts: {
  settings: KlingUserSettings
  image: string
  masterPrompt: string
  context: KlingVideoContext | null
  sourceDuration: number | null
  shotMode: 'one_shot' | 'multi_shot' | null | undefined
  shotStills: KlingShotStill[] | null
}): KlingI2VInput {
  const duration = durationForKling(opts.sourceDuration, opts.settings)
  const shots = (opts.context?.shots ?? []).filter(s => s.prompt.trim()).slice(0, 6)
  const mode = effectivePromptMode(opts.shotMode, shots)

  const input: KlingI2VInput = {
    variant: opts.settings.variant,
    image: opts.image,
    duration,
    cfg_scale: opts.settings.cfg_scale,
    sound: opts.settings.sound,
    shot_type: opts.settings.shot_type,
  }

  if (mode === 'multi_prompt') {
    const allocated = allocateShotDurations(shots, duration)
    input.multi_prompt = allocated.map((shot, i) => {
      // Re-anchors identity at this shot's own still instead of only at t=0 —
      // the whole reason multi-shot is worth the extra generation step (see
      // KlingMultiPromptItem.image doc comment).
      const still = opts.shotStills?.find(s => s.t_start === shots[i].t_start)
      return still ? { ...shot, image: still.image_url } : shot
    })
  } else {
    input.prompt = opts.masterPrompt
  }
  if (opts.settings.negative_prompt) input.negative_prompt = opts.settings.negative_prompt
  if (opts.settings.element_list.length) input.element_list = opts.settings.element_list
  return input
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
 * One human-readable summary of exactly what will be sent to Kling — the
 * content of the prompt-approval message. Mirrors the shape of the real
 * payload closely enough that approving this and approving the actual
 * buildKlingI2VPayload output mean the same thing.
 */
function formatPromptSummary(input: KlingI2VInput, context: KlingVideoContext | null): string {
  const lines: string[] = [
    `🎬 <b>Ready for Kling ${escapeHtml(input.variant)}</b> · ${input.duration}s` +
      `${input.multi_prompt?.length ? ` · ${input.multi_prompt.length} shots` : ' · single prompt'}`,
  ]
  if (context?.hook) lines.push(`<b>Hook:</b> ${escapeHtml(context.hook)}`)
  if (input.multi_prompt?.length) {
    for (const [i, shot] of input.multi_prompt.entries()) {
      lines.push(`\n<b>Shot ${i + 1}</b> (${shot.duration ?? '?'}s)${shot.image ? ' 🖼️' : ''}:\n${escapeHtml(shot.prompt)}`)
    }
  } else if (input.prompt) {
    lines.push(`\n${escapeHtml(input.prompt)}`)
  }
  return lines.join('\n')
}

/**
 * Picks, for one shot's time range, the extracted 1fps frame closest to its
 * midpoint — the most representative moment of that beat, same idea as
 * Copy-Paste's best-face-frame selection but per-shot instead of per-clip.
 */
async function nearestFrameForShot(jobId: string, shot: KlingShotBeat): Promise<{ image_url: string } | null> {
  const mid = (shot.t_start + shot.t_end) / 2
  return one<{ image_url: string }>(
    `SELECT image_url FROM kling_recreate_frames
      WHERE job_id = $1
      ORDER BY abs(t_sec - $2) ASC
      LIMIT 1`,
    [jobId, mid],
  )
}

/**
 * Generates the character still(s) for a job whose analysis is already
 * stored: one still (from the first frame) for one_shot mode, or one still
 * PER shot (each anchored to that shot's own nearest source frame) for
 * multi_shot mode when the analysis actually found >=2 beats. Stops short of
 * building the Kling payload — that happens in approveKlingStill, after a
 * human has looked at these.
 */
async function generateStills(opts: {
  row: KlingRecreateJobRow
  context: KlingVideoContext | null
  apiKey: string
}): Promise<{ characterUrl: string; shotStills: KlingShotStill[] | null }> {
  const { row } = opts
  const reference = row.reference_image_url
  if (!reference) throw new Error('No reference photo on this job')

  const ctx = opts.context ?? {
    setting: '', hook: '', character_action: '', camera: '', speech: null,
    duration_sec: null, aspect_ratio: '9:16', shots: [], prompt_mode: 'prompt' as const,
  }
  const aspectRatio = ctx.aspect_ratio === '16:9' || ctx.aspect_ratio === '1:1' || ctx.aspect_ratio === '9:16'
    ? ctx.aspect_ratio
    : 'other'
  const shots = (ctx.shots ?? []).filter(s => s.prompt.trim()).slice(0, 6)
  const wantMulti = row.shot_mode === 'multi_shot' && shots.length >= 2

  if (!wantMulti) {
    const firstFrame = await one<{ image_url: string }>(
      `SELECT image_url FROM kling_recreate_frames WHERE job_id = $1 ORDER BY t_sec ASC LIMIT 1`,
      [row.id],
    )
    if (!firstFrame) throw new Error('No source frames stored — cannot build character still')
    const keyframe = await generateCopyPasteKeyframe({
      sourceFrameUrl: firstFrame.image_url,
      referenceImageUrl: reference,
      prompt: renderRecreateKeyframePrompt(ctx, row.custom_prompt),
      aspectRatio,
      itemId: row.id,
      slot: 'keyframe',
    }, opts.apiKey)
    const prepared = await prepareKlingImage(keyframe.imageUrl, `kling-recreate/${row.user_id}/${row.id}/character.jpg`)
    return { characterUrl: prepared.url, shotStills: null }
  }

  // One still per shot, in order — sequential (not parallel) so a failure on
  // shot 3 doesn't leave 4/5/6 half-billed while 1/2 succeeded and the error
  // is unclear about which shot actually broke.
  const shotStills: KlingShotStill[] = []
  for (const shot of shots) {
    const sourceFrame = await nearestFrameForShot(row.id, shot)
    if (!sourceFrame) continue
    const keyframe = await generateCopyPasteKeyframe({
      sourceFrameUrl: sourceFrame.image_url,
      referenceImageUrl: reference,
      prompt: renderRecreateKeyframePrompt(ctx, row.custom_prompt),
      aspectRatio,
      itemId: row.id,
      slot: 'keyframe',
    }, opts.apiKey)
    const prepared = await prepareKlingImage(
      keyframe.imageUrl,
      `kling-recreate/${row.user_id}/${row.id}/shot-${shot.t_start}.jpg`,
    )
    shotStills.push({ t_start: shot.t_start, t_end: shot.t_end, image_url: prepared.url })
  }
  if (!shotStills.length) throw new Error('Could not build any per-shot character stills')
  return { characterUrl: shotStills[0].image_url, shotStills }
}

/**
 * Phase 1: scrape -> 1fps analyze -> character still(s). Stops at
 * 'awaiting_still_approval' instead of continuing to Kling — a human checks
 * the still(s) before anything paid beyond Seedream runs. Re-invoking this
 * while already awaiting approval (or beyond) is a no-op: it must never
 * regenerate a paid still or re-send the same notification on a cron retry.
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
  const settings = normalizeSettings(row.settings)
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
  if (row.status === 'awaiting_still_approval' || row.status === 'awaiting_prompt_approval') {
    return { ok: true, awaitingApproval: true }
  }

  // Variation children reuse the parent still + analysis and skip straight to
  // rendering — no approval gate, the parent's still was already approved.
  if (variationSkipsUpstream(row)) {
    if (!row.character_image_url) throw new Error('Variation job is missing the parent character still.')
    const note = (row.variation_note ?? '').trim()
    if (!note) throw new Error('Variation job is missing the change text.')

    const context = (row.context ?? null) as KlingVideoContext | null
    const masterPrompt = row.master_prompt
    const sourceDuration = row.duration_sec != null ? Number(row.duration_sec) : null
    const klingInput = applyVariationToKlingInput(
      buildKlingInput({
        settings, image: row.character_image_url, masterPrompt: masterPrompt ?? '',
        context, sourceDuration, shotMode: row.shot_mode, shotStills: row.shot_stills ?? null,
      }),
      note,
    )
    if (!klingInput.prompt && !klingInput.multi_prompt?.length) {
      throw new Error('Variation job has no parent prompt to apply the change to')
    }
    await syncKlingAnalysisSheetSafe({
      jobId: row.id, sourceUrl: row.source_url, durationSec: sourceDuration, context, masterPrompt,
      status: `variation: ${note}`, klingVideoUrl: null,
    })
    return finishKlingRender({
      row, queueJobId: opts.queueJobId, userId: opts.userId, chatId, settings,
      masterPrompt, context, sourceDuration, klingInput, apiKey,
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
  const { characterUrl, shotStills } = await generateStills({ row: { ...row, custom_prompt: row.custom_prompt }, context, apiKey })
  await updateRecreate(row.id, {
    character_image_url: characterUrl,
    shot_stills: shotStills,
    status: 'awaiting_still_approval',
  })
  await heartbeat(opts.queueJobId, 'awaiting_still_approval', { progress: 70 })

  if (chatId != null) {
    const caption = shotStills
      ? `🖼️ ${shotStills.length} character stills ready — one per shot. Review before Kling.`
      : '🖼️ Character still ready — review before Kling.'
    try {
      if (shotStills && shotStills.length > 1) {
        await sendMediaGroup(chatId, shotStills.map(s => s.image_url), caption)
      } else {
        await sendPhoto(chatId, characterUrl, caption)
      }
    } catch {
      await notify(chatId, caption)
    }
    await notify(chatId, 'Approve to build the Kling prompt, or regenerate the still(s).', stillApprovalKeyboard(row.id))
  }

  return { ok: true, awaitingApproval: true }
}

/**
 * Phase 2: still(s) approved -> build the actual Kling payload (including,
 * for multi-shot, the per-shot image anchors) and stop AGAIN for a human to
 * read the exact prompt(s) before the paid Kling call fires.
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
    // Already handled (double-tap) or not at the right stage — no-op.
    return { ok: true, awaitingApproval: true }
  }
  const chatId = opts.input.chatId ?? row.chat_id
  const settings = normalizeSettings(row.settings)
  const context = (row.context ?? null) as KlingVideoContext | null
  const sourceDuration = row.duration_sec != null ? Number(row.duration_sec) : null

  const klingInput = buildKlingInput({
    settings, image: row.character_image_url, masterPrompt: row.master_prompt ?? '',
    context, sourceDuration, shotMode: row.shot_mode, shotStills: row.shot_stills ?? null,
  })
  if (!klingInput.prompt && !klingInput.multi_prompt?.length) {
    throw new Error('Analysis produced no master prompt')
  }

  await updateRecreate(row.id, {
    status: 'awaiting_prompt_approval',
    kling_request: klingInput as unknown as Record<string, unknown>,
    kling_variant: settings.variant,
  })
  await heartbeat(opts.queueJobId, 'awaiting_prompt_approval', { progress: 78 })
  await notify(chatId, formatPromptSummary(klingInput, context), promptApprovalKeyboard(row.id))
  return { ok: true, awaitingApproval: true }
}

/** The still(s) missed — clear and redo off the existing analysis. Paid again, only on an explicit tap. */
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

  await updateRecreate(row.id, { character_image_url: null, shot_stills: null, status: 'still' })
  await heartbeat(opts.queueJobId, 'still', { progress: 55 })
  const { characterUrl, shotStills } = await generateStills({ row, context, apiKey })
  await updateRecreate(row.id, { character_image_url: characterUrl, shot_stills: shotStills, status: 'awaiting_still_approval' })
  await heartbeat(opts.queueJobId, 'awaiting_still_approval', { progress: 70 })

  if (chatId != null) {
    const caption = shotStills
      ? `🖼️ Regenerated — ${shotStills.length} character stills, one per shot.`
      : '🖼️ Regenerated character still.'
    try {
      if (shotStills && shotStills.length > 1) await sendMediaGroup(chatId, shotStills.map(s => s.image_url), caption)
      else await sendPhoto(chatId, characterUrl, caption)
    } catch {
      await notify(chatId, caption)
    }
    await notify(chatId, 'Approve to build the Kling prompt, or regenerate again.', stillApprovalKeyboard(row.id))
  }
  return { ok: true, awaitingApproval: true }
}

/** Prompt approved -> the actual paid Kling call. */
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
  const settings = normalizeSettings(row.settings)
  const context = (row.context ?? null) as KlingVideoContext | null
  const sourceDuration = row.duration_sec != null ? Number(row.duration_sec) : null
  const apiKey = await getUserApiKey(opts.userId, 'wavespeed_api_key')
  const klingInput = row.kling_request as unknown as KlingI2VInput

  return finishKlingRender({
    row, queueJobId: opts.queueJobId, userId: opts.userId, chatId, settings,
    masterPrompt: row.master_prompt, context, sourceDuration, klingInput, apiKey,
  })
}

/**
 * The prompt/shots missed — redo the synthesis (NOT the per-frame Grok
 * description pass, that part was fine and re-running it would just re-spend
 * on identical work) off the already-stored 1fps frame descriptions, then
 * redo the still(s) for whatever shots come out this time.
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

  // master_prompt has no "clear" path through updateRecreate's typed partial
  // (it only ever sets a string) — cleared directly so the pending-checks
  // elsewhere (`if (!masterPrompt)`) see a real re-analysis is needed.
  await query(
    `UPDATE kling_recreate_jobs
        SET master_prompt = NULL, character_image_url = NULL, shot_stills = NULL,
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
  await notify(chatId, '🧠 Re-analyzed. Building new character still(s)…')

  await updateRecreate(row.id, { status: 'still' })
  const { characterUrl, shotStills } = await generateStills({ row, context: analysis.context, apiKey })
  await updateRecreate(row.id, { character_image_url: characterUrl, shot_stills: shotStills, status: 'awaiting_still_approval' })
  await heartbeat(opts.queueJobId, 'awaiting_still_approval', { progress: 70 })

  if (chatId != null) {
    const caption = shotStills
      ? `🖼️ New analysis — ${shotStills.length} character stills, one per shot.`
      : '🖼️ New analysis — character still ready.'
    try {
      if (shotStills && shotStills.length > 1) await sendMediaGroup(chatId, shotStills.map(s => s.image_url), caption)
      else await sendPhoto(chatId, characterUrl, caption)
    } catch {
      await notify(chatId, caption)
    }
    await notify(chatId, 'Approve to build the Kling prompt, or regenerate.', stillApprovalKeyboard(row.id))
  }
  return { ok: true, awaitingApproval: true }
}

async function finishKlingRender(opts: {
  row: KlingRecreateJobRow
  queueJobId: string
  userId: string
  chatId: number | string | null | undefined
  settings: KlingUserSettings
  masterPrompt: string | null
  context: KlingVideoContext | null
  sourceDuration: number | null
  klingInput: KlingI2VInput
  apiKey: string
}): Promise<{ ok: true; videoUrl: string }> {
  const { row, settings, klingInput } = opts
  const existingRequestId =
    (row.kling_request as { _prediction_id?: string } | null)?._prediction_id ?? null

  const payload = buildKlingI2VPayload(klingInput)
  await updateRecreate(row.id, {
    status: 'rendering',
    kling_variant: settings.variant,
    kling_request: existingRequestId ? { ...payload, _prediction_id: existingRequestId } : payload,
  })
  await heartbeat(opts.queueJobId, 'rendering', { progress: 82 })

  const result = await generateKlingI2V(klingInput, opts.apiKey, {
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
    kling_variant: settings.variant,
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
    `✅ Kling 3.0 <code>${escapeHtml(settings.variant)}</code> · ` +
    `${durationForKling(opts.sourceDuration, settings)}s` +
    `${klingInput.multi_prompt?.length ? ' · multi-shot' : ''}` +
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
    case 'approve_prompt': return approvePrompt(opts)
    case 'regenerate_prompt': return regeneratePrompt(opts)
    case 'analyze':
    default:
      return processKlingRecreateJob(opts)
  }
}

export type { KlingVariant }
