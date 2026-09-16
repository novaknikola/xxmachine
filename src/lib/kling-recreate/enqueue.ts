import { one } from '@/lib/db'
import { internalBaseUrl } from '@/lib/internal-url'
import { buildVariationJobDrafts } from './variation'
import type {
  KlingRecreateAction, KlingRecreateJobRow, KlingRecreateQueueInput, KlingShotMode, KlingUserSettings,
} from './types'

const CRON_SECRET = process.env.CRON_SECRET
const IMMEDIATE_FIRES = 2

export async function enqueueKlingRecreateJobs(opts: {
  userId: string
  chatId: number
  urls: string[]
  referenceImageUrl: string
  settings: KlingUserSettings
  shotMode: KlingShotMode
  customPrompt?: string | null
}): Promise<string[]> {
  const queueIds: string[] = []

  for (const sourceUrl of opts.urls) {
    const recreate = await one<{ id: string }>(
      `INSERT INTO kling_recreate_jobs
         (user_id, chat_id, source_url, reference_image_url, settings, kling_variant, status,
          shot_mode, custom_prompt)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'pending', $7, $8)
       RETURNING id`,
      [
        opts.userId,
        opts.chatId,
        sourceUrl,
        opts.referenceImageUrl,
        JSON.stringify(opts.settings),
        opts.settings.variant,
        opts.shotMode,
        opts.customPrompt?.trim() || null,
      ],
    )
    if (!recreate) throw new Error('Could not create kling_recreate_jobs row')

    const input: KlingRecreateQueueInput = {
      recreateJobId: recreate.id,
      chatId: opts.chatId,
    }
    const queued = await one<{ id: string }>(
      `INSERT INTO generation_queue (user_id, job_type, input, total_items)
       VALUES ($1, 'kling_recreate_v1', $2, 1)
       RETURNING id`,
      [opts.userId, JSON.stringify(input)],
    )
    if (!queued) throw new Error('Could not queue kling_recreate_v1')

    await one(
      `UPDATE kling_recreate_jobs SET queue_job_id = $2 WHERE id = $1`,
      [recreate.id, queued.id],
    )
    queueIds.push(queued.id)
  }

  await claimAndFire(queueIds)
  return queueIds
}

/**
 * Enqueues one action against an already-existing kling_recreate_jobs row —
 * the Approve/Regenerate buttons on both approval gates all go through this,
 * same claim-then-fire pattern as a fresh recreate so the request never blocks
 * on the work itself (a still or a Kling render both run past any reasonable
 * Telegram/HTTP timeout).
 */
export async function enqueueKlingAction(opts: {
  userId: string
  chatId: number
  jobId: string
  action: KlingRecreateAction
}): Promise<string> {
  const input: KlingRecreateQueueInput = {
    recreateJobId: opts.jobId,
    chatId: opts.chatId,
    action: opts.action,
  }
  const queued = await one<{ id: string }>(
    `INSERT INTO generation_queue (user_id, job_type, input, total_items)
     VALUES ($1, 'kling_recreate_v1', $2, 1)
     RETURNING id`,
    [opts.userId, JSON.stringify(input)],
  )
  if (!queued) throw new Error(`Could not queue ${opts.action}`)
  await claimAndFire([queued.id])
  return queued.id
}

async function claimAndFire(queueIds: string[]): Promise<void> {
  for (const [i, queueId] of queueIds.entries()) {
    if (i >= IMMEDIATE_FIRES) break
    const claimed = await one<{ id: string }>(
      `UPDATE generation_queue SET status='processing', started_at=now(), attempts=attempts+1
        WHERE id=$1 AND status='pending' RETURNING id`,
      [queueId],
    ).catch(() => null)
    if (claimed && CRON_SECRET) {
      fetch(`${internalBaseUrl()}/api/queue/process/${queueId}`, {
        method: 'POST',
        headers: { 'x-cron-secret': CRON_SECRET },
      }).catch(err => console.error('[kling-recreate] fire worker:', err))
    }
  }
}

export async function enqueueKlingVariationJobs(opts: {
  userId: string
  chatId: number
  parent: KlingRecreateJobRow
  change: string
  count: number
}): Promise<string[]> {
  const drafts = buildVariationJobDrafts(opts.parent, opts.change, opts.count)
  const queueIds: string[] = []

  for (const draft of drafts) {
    const recreate = await one<{ id: string }>(
      `INSERT INTO kling_recreate_jobs
         (user_id, chat_id, source_url, video_url, duration_sec, reference_image_url,
          character_image_url, master_prompt, context, settings, kling_variant, status,
          parent_job_id, variation_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, 'pending', $12, $13)
       RETURNING id`,
      [
        opts.userId,
        opts.chatId,
        draft.sourceUrl,
        draft.videoUrl,
        draft.durationSec,
        draft.referenceImageUrl,
        draft.characterImageUrl,
        draft.masterPrompt,
        JSON.stringify(draft.context ?? {}),
        JSON.stringify(draft.settings ?? {}),
        (opts.parent.settings as KlingUserSettings)?.variant ?? opts.parent.kling_variant ?? 'pro',
        draft.parentJobId,
        draft.variationNote,
      ],
    )
    if (!recreate) throw new Error('Could not create variation job')

    const input: KlingRecreateQueueInput = {
      recreateJobId: recreate.id,
      chatId: opts.chatId,
    }
    const queued = await one<{ id: string }>(
      `INSERT INTO generation_queue (user_id, job_type, input, total_items)
       VALUES ($1, 'kling_recreate_v1', $2, 1)
       RETURNING id`,
      [opts.userId, JSON.stringify(input)],
    )
    if (!queued) throw new Error('Could not queue variation job')
    await one(
      `UPDATE kling_recreate_jobs SET queue_job_id = $2 WHERE id = $1`,
      [recreate.id, queued.id],
    )
    queueIds.push(queued.id)
  }

  await claimAndFire(queueIds)
  return queueIds
}
