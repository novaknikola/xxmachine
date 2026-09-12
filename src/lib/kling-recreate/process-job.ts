import { one, query } from '@/lib/db'
import { getUserApiKey } from '@/lib/user-config'
import { generateCopyPasteKeyframe } from '@/lib/monitor/replicate'
import { uploadImageFromUrl } from '@/lib/supabase-storage'
import { sendPhoto, sendText, sendVideo } from '@/lib/telegram-recreate'
import { analyzeOneFpsVideo, renderRecreateKeyframePrompt } from './analyze'
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
import type {
  KlingRecreateJobRow,
  KlingRecreateQueueInput,
  KlingShotBeat,
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
    character_image_url: string
    kling_video_url: string
    kling_variant: string
    kling_request: unknown
    error: string | null
  }>,
) {
  const sets: string[] = ['updated_at = now()']
  const vals: unknown[] = []
  let i = 1
  for (const [key, value] of Object.entries(fields)) {
    const cast = key === 'context' || key === 'kling_request' ? '::jsonb' : ''
    sets.push(`${key} = $${i++}${cast}`)
    vals.push(key === 'context' || key === 'kling_request' ? JSON.stringify(value) : value)
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

function buildKlingInput(opts: {
  settings: KlingUserSettings
  image: string
  masterPrompt: string
  context: KlingVideoContext | null
  sourceDuration: number | null
}): KlingI2VInput {
  const duration = durationForKling(opts.sourceDuration, opts.settings)
  const shots = (opts.context?.shots ?? []).filter(s => s.prompt.trim()).slice(0, 6)
  const useMulti = opts.context?.prompt_mode === 'multi_prompt' && shots.length >= 2

  const input: KlingI2VInput = {
    variant: opts.settings.variant,
    image: opts.image,
    duration,
    cfg_scale: opts.settings.cfg_scale,
    sound: opts.settings.sound,
    shot_type: opts.settings.shot_type,
  }

  if (useMulti) {
    input.multi_prompt = allocateShotDurations(shots, duration)
  } else {
    input.prompt = opts.masterPrompt
  }
  if (opts.settings.negative_prompt) input.negative_prompt = opts.settings.negative_prompt
  if (opts.settings.element_list.length) input.element_list = opts.settings.element_list
  return input
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

async function notify(chatId: number | string | null | undefined, text: string) {
  if (chatId == null) return
  await sendText(chatId, text).catch(err =>
    console.error('[kling-recreate] notify failed:', err),
  )
}

export async function processKlingRecreateJob(opts: {
  queueJobId: string
  userId: string
  input: KlingRecreateQueueInput
}): Promise<{ ok: true; videoUrl?: string; cached?: boolean }> {
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
      jobId: row.id,
      sourceUrl: row.source_url,
      durationSec: row.duration_sec,
      context: (row.context ?? null) as KlingVideoContext | null,
      masterPrompt: row.master_prompt,
      status: 'done',
      klingVideoUrl: row.kling_video_url,
    })
    return { ok: true, videoUrl: row.kling_video_url, cached: true }
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

    const extracted = await extractOneFpsFrames(
      videoUrl,
      `kling-recreate/${opts.userId}/${row.id}/frames`,
    )
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
      userId: opts.userId,
      jobId: row.id,
      sourceUrl: row.source_url,
      frames: extracted.frames.map(f => ({ t_sec: f.t_sec, description: null })),
      context: null,
    }).catch(err => {
      console.error('[kling-recreate] idea bank failed:', err)
      return 0
    })

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

    await updateRecreate(row.id, {
      status: 'analyzing',
      duration_sec: sourceDuration,
      context,
      master_prompt: masterPrompt,
    })
    await heartbeat(opts.queueJobId, 'analyzed', { progress: 45 })
    await syncKlingAnalysisSheetSafe({
      jobId: row.id,
      sourceUrl: row.source_url,
      durationSec: sourceDuration,
      context,
      masterPrompt,
      status: 'analyzing',
      klingVideoUrl: row.kling_video_url,
    })
    await notify(
      chatId,
      `🧠 Analysis stored — ${analysis.frames.length} frames @ 1fps` +
        `${sourceDuration != null ? `, ${sourceDuration.toFixed(1)}s` : ''}.`,
    )
    await ideasPromise
  } else {
    await syncKlingAnalysisSheetSafe({
      jobId: row.id,
      sourceUrl: row.source_url,
      durationSec: sourceDuration,
      context,
      masterPrompt,
      status: row.status,
      klingVideoUrl: row.kling_video_url,
    })
    const already = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM kling_idea_bank WHERE job_id = $1`,
      [row.id],
    )
    if (!already?.n) {
      bankFreshIdeas({
        userId: opts.userId,
        jobId: row.id,
        sourceUrl: row.source_url,
        context,
      }).catch(err => console.error('[kling-recreate] idea bank retry failed:', err))
    }
  }

  let characterUrl = row.character_image_url
  if (!characterUrl) {
    const reference = row.reference_image_url
    if (!reference) throw new Error('No reference photo on this job')
    const firstFrame = await one<{ image_url: string }>(
      `SELECT image_url FROM kling_recreate_frames WHERE job_id = $1 ORDER BY t_sec ASC LIMIT 1`,
      [row.id],
    )
    if (!firstFrame) throw new Error('No source frames stored — cannot build character still')

    await updateRecreate(row.id, { status: 'still' })
    await heartbeat(opts.queueJobId, 'still', { progress: 55 })

    const ctx = context ?? {
      setting: '',
      character_action: '',
      camera: '',
      speech: null,
      duration_sec: sourceDuration,
      aspect_ratio: '9:16',
      shots: [],
      prompt_mode: 'prompt' as const,
    }
    const keyframe = await generateCopyPasteKeyframe({
      sourceFrameUrl: firstFrame.image_url,
      referenceImageUrl: reference,
      prompt: renderRecreateKeyframePrompt(ctx),
      aspectRatio: ctx.aspect_ratio === '16:9' || ctx.aspect_ratio === '1:1' || ctx.aspect_ratio === '9:16'
        ? ctx.aspect_ratio
        : 'other',
      itemId: row.id,
      slot: 'keyframe',
    }, apiKey)

    const prepared = await prepareKlingImage(
      keyframe.imageUrl,
      `kling-recreate/${opts.userId}/${row.id}/character.jpg`,
    )
    characterUrl = prepared.url
    await updateRecreate(row.id, { character_image_url: characterUrl })
    await heartbeat(opts.queueJobId, 'still_ready', { progress: 70 })
    if (chatId != null) {
      await sendPhoto(
        chatId,
        characterUrl,
        '🖼️ Character still ready — sending to Kling 3.0…',
      ).catch(() => notify(chatId, '🖼️ Character still ready — sending to Kling 3.0…'))
    }
  }

  if (row.kling_video_url) {
    return { ok: true, videoUrl: row.kling_video_url, cached: true }
  }

  const klingInput = buildKlingInput({
    settings,
    image: characterUrl,
    masterPrompt: masterPrompt ?? '',
    context,
    sourceDuration,
  })
  if (!klingInput.prompt && !klingInput.multi_prompt?.length) {
    throw new Error('Analysis produced no master prompt')
  }

  const existingRequestId =
    (row.kling_request as { _prediction_id?: string } | null)?._prediction_id ?? null

  const payload = buildKlingI2VPayload(klingInput)
  await updateRecreate(row.id, {
    status: 'rendering',
    kling_variant: settings.variant,
    kling_request: existingRequestId ? { ...payload, _prediction_id: existingRequestId } : payload,
  })
  await heartbeat(opts.queueJobId, 'rendering', { progress: 75 })

  const result = await generateKlingI2V(klingInput, apiKey, {
    existingRequestId,
    onSubmitted: async (requestId, submitted) => {
      await updateRecreate(row.id, {
        kling_request: { ...submitted, _prediction_id: requestId },
      })
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
    jobId: row.id,
    sourceUrl: row.source_url,
    durationSec: sourceDuration,
    context,
    masterPrompt,
    status: 'done',
    klingVideoUrl: hosted,
  })

  if (chatId != null) {
    const caption =
      `✅ Kling 3.0 <code>${escapeHtml(settings.variant)}</code> · ` +
      `${durationForKling(sourceDuration, settings)}s` +
      `${context?.prompt_mode === 'multi_prompt' ? ' · multi-shot' : ''}`
    await sendVideo(chatId, hosted, caption).catch(async () => {
      await notify(chatId, `${caption}\n${escapeHtml(hosted)}`)
    })
  }

  return { ok: true, videoUrl: hosted }
}

export type { KlingVariant }
