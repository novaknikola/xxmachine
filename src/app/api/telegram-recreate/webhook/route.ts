import { NextRequest, NextResponse } from 'next/server'
import { one, query, rows } from '@/lib/db'
import { internalBaseUrl } from '@/lib/internal-url'
import {
  sendText, sendPhoto, sendMediaGroup, answerCallbackQuery, editMessageReplyMarkup, editMessageText,
  downloadTelegramFile, recreateMenuKeyboard, countKeyboard, promptChoiceKeyboard,
  FORMAT_CODES, FORMAT_LABELS, CAROUSEL_VARIANT_COUNT, type FormatCode,
} from '@/lib/telegram-recreate'
import { renderPoseRecreatePrompt, renderCarouselVariantPrompt } from '@/lib/pose-recreate'
import { suggestedDimensionForFormat, type ContentFormat } from '@/lib/drive-archive/content-format'
import { sanitizeDriveKey } from '@/lib/drive-archive/paths'
import { uploadBuffer, uploadImageFromUrl } from '@/lib/supabase-storage'
import { editImage } from '@/lib/wavespeed'
import { getUserApiKey } from '@/lib/user-config'
import { parseReelUrl } from '@/lib/monitor/parse-reel-url'
import { resolveVideoUrlsViaApify } from '@/lib/instagram-scrape'
import type { CopyPromptsJobInput } from '@/app/api/queue/submit/route'

/**
 * Webhook for the pose-recreate bot (@contentreplicatorbot). Deliberately a
 * standalone route, own token (TELEGRAM_RECREATE_BOT_TOKEN), own chat_id
 * column (users.telegram_recreate_chat_id) — the existing Copy-Paste webhook
 * (api/telegram/webhook) is never imported or modified by this file.
 *
 * Same UX principle as Copy-Paste v2 ("IGreplicator"): ad-hoc reference photo
 * + bulk count + optional extra prompt — see
 * [[project-xxmachine-copy-paste-v2]]. Submits into the EXISTING
 * copy_prompts_generate job type unchanged (item 1 image is the scene/pose
 * reference, the job-level referenceImageUrls are the identity) — no new job
 * type, no edit to queue/process/[id]/route.ts.
 *
 * Flow: /recreate -> pick format -> send photo -> pick count -> skip/add
 * prompt -> generate. telegram_recreate_pending carries state between these
 * steps (chat_id keyed) since each is a separate Telegram update.
 */
const CRON_SECRET = process.env.CRON_SECRET

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function findUserId(chatId: number): Promise<string | null> {
  const row = await one<{ id: string }>(
    `SELECT id FROM users WHERE telegram_recreate_chat_id = $1`,
    [chatId],
  )
  return row?.id ?? null
}

interface PendingRow {
  format: string
  photo_url: string | null
  count: number | null
  awaiting_prompt: boolean
  ig_pose_urls: string[] | null
}

async function getPending(chatId: number): Promise<PendingRow | null> {
  return one<PendingRow>(
    `SELECT format, photo_url, count, awaiting_prompt, ig_pose_urls FROM telegram_recreate_pending WHERE chat_id = $1`,
    [chatId],
  )
}

async function clearPending(chatId: number): Promise<void> {
  await query(`DELETE FROM telegram_recreate_pending WHERE chat_id = $1`, [chatId])
}

/**
 * Same 'carousels' vs everything-else split archiveFolderPaths uses
 * internally (drive-archive/resolve-folder.ts) — duplicated here rather than
 * imported since that mapping isn't exported, and this is the only other
 * place that needs to know which drive_folders.kind a contentFormat lands
 * under to look the folder back up.
 */
function driveArchiveKind(contentFormat: ContentFormat): 'carousels' | 'stories' {
  return contentFormat === 'carousels' ? 'carousels' : 'stories'
}

/**
 * Drive archiving is async (a cron sweeps drive_exports), so the folder may
 * not exist the instant generation finishes — poll briefly, same tolerance
 * notifyReplicationDone documents ("a missing link is normal and simply
 * omitted") but with a few retries first since here it usually does show up
 * within seconds of a small batch finishing.
 */
async function findDriveFolderLink(userId: string, label: string, contentFormat: ContentFormat): Promise<string | null> {
  const kind = driveArchiveKind(contentFormat)
  const characterKey = sanitizeDriveKey(label)
  for (let i = 0; i < 6; i++) {
    const row = await one<{ folder_id: string }>(
      `SELECT folder_id FROM drive_folders
        WHERE user_id = $1 AND character_key = $2 AND kind = $3 AND date_key <> '_'
        ORDER BY date_key DESC LIMIT 1`,
      [userId, characterKey, kind],
    )
    if (row?.folder_id) return `https://drive.google.com/drive/folders/${row.folder_id}`
    await sleep(3000)
  }
  return null
}

/**
 * A single Seedream Edit call has its own 10-minute AbortSignal
 * (wavespeed.ts), so a healthy batch can legitimately go quiet for a while
 * mid-item — 12 minutes with zero movement in the heartbeat is past that
 * with margin, which is what actually happened to the job that prompted
 * this: 2/5 done, then genuinely nothing for 17+ minutes with no error ever
 * logged (a known pre-existing quirk: the internal "kick" fetch can hit
 * undici's ~5min HeadersTimeoutError while the job keeps running server-side
 * regardless — see /api/queue/submit's own logs for the same pattern on
 * other jobs). Distinguishing "still working" from "actually stuck" this way
 * beats both a short fixed cutoff (abandons slow-but-healthy jobs) and no
 * cutoff at all (a truly dead job would hang the user forever).
 */
const STALE_AFTER_MS = 12 * 60 * 1000
const POLL_INTERVAL_MS = 10_000
const HARD_CAP_MS = 45 * 60 * 1000

/**
 * N random, non-repeating picks from the carousel_pose_prompts pool (~300,
 * Grok-generated — see scripts/seed-carousel-pose-prompts.ts). Replaced the
 * old 8-item hardcoded list per the user's explicit ask: too small a pool
 * made the same few variants recur constantly, same lesson as pose_library
 * itself.
 */
async function pickVariantPoses(n: number): Promise<string[]> {
  return (
    await rows<{ prompt_text: string }>(
      `SELECT prompt_text FROM carousel_pose_prompts WHERE active = true ORDER BY random() LIMIT $1`,
      [n],
    )
  ).map(r => r.prompt_text)
}

/**
 * Carousel: for each already-generated base image, make CAROUSEL_VARIANT_COUNT
 * direct pose-only edits. Deliberately bypasses copy_prompts_generate's own
 * carousel.enabled mechanism — see renderCarouselVariantPrompt's doc comment
 * for why (that path re-sends the original pose+identity references
 * alongside the base image, which left the model unsure which image to
 * follow; pose barely changed, environment drifted instead). Runs entirely
 * outside generation_queue, after the base job is already 'done'.
 *
 * Every slide (base AND variant) is re-archived here under one shared
 * seriesLabel with a sequential seriesIndex, so the whole carousel gets
 * consistent `{label}_01.jpg`, `{label}_02.jpg`, ... naming in Drive — the
 * base images already got archived once by the shared worker under its own
 * machine-generated name; this adds a second, cleanly-numbered copy rather
 * than touching that shared archiving code.
 */
async function expandCarouselVariants(userId: string, label: string, baseImages: string[]): Promise<string[]> {
  const apiKey = await getUserApiKey(userId, 'wavespeed_api_key').catch(() => '')
  if (!apiKey) return baseImages

  const { enqueueDriveArchive } = await import('@/lib/drive-archive/enqueue')
  const seriesId = `adhoc-carousel:${label}`
  let seriesIndex = 0
  const all: string[] = []

  const archiveSlide = (url: string) =>
    enqueueDriveArchive({
      userId,
      sourceType: 'queue_job',
      sourceId: `${seriesId}:${seriesIndex}`,
      urls: [url],
      characterKey: label,
      kind: 'carousels',
      stage: 'ready',
      seriesId,
      seriesIndex: seriesIndex++,
      seriesLabel: label,
    }).catch(err => console.error('[telegram-recreate/webhook] carousel slide archive failed:', err))

  for (let bi = 0; bi < baseImages.length; bi++) {
    const base = baseImages[bi]
    all.push(base)
    await archiveSlide(base)

    const poses = await pickVariantPoses(CAROUSEL_VARIANT_COUNT)
    const results = await Promise.allSettled(
      poses.map(pose =>
        editImage({
          imageUrls: [base],
          prompt: renderCarouselVariantPrompt(pose),
          resolution: '1k',
          apiKey,
          signal: AbortSignal.timeout(600_000),
        }),
      ),
    )
    for (let vi = 0; vi < results.length; vi++) {
      const r = results[vi]
      if (r.status !== 'fulfilled' || !r.value.length) {
        console.error(`[telegram-recreate/webhook] carousel variant ${bi}:${vi} failed:`, r.status === 'rejected' ? r.reason : 'no output')
        continue
      }
      try {
        const stored = await uploadImageFromUrl(r.value[0], `queue/adhoc-carousel/${userId}/${bi}_${vi}_${Date.now()}.jpg`)
        all.push(stored)
        await archiveSlide(stored)
      } catch (err) {
        console.error(`[telegram-recreate/webhook] carousel variant ${bi}:${vi} upload failed:`, err)
      }
    }
  }
  return all
}

/**
 * Fire-and-forget — Telegram gets its 200 back immediately, this keeps
 * running in the background (same process, pm2-hosted, not serverless) and
 * pushes the result whenever the job actually finishes, stalls, or fails.
 */
async function pollAndDeliver(
  jobId: string,
  chatId: number,
  userId: string,
  label: string,
  contentFormat: ContentFormat,
): Promise<void> {
  const deadline = Date.now() + HARD_CAP_MS

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    const row = await one<{
      status: string
      started_at: string
      output: { copyPromptsRows?: { images: string[] }[]; progressAt?: string } | null
      error: string | null
    }>(`SELECT status, started_at, output, error FROM generation_queue WHERE id = $1`, [jobId])
    if (!row) return

    if (row.status === 'done') {
      let images = (row.output?.copyPromptsRows ?? []).flatMap(r => r.images ?? [])

      // Only the library-draw ('adhoc-...') flow earns synthetic pose
      // variants — /replicate jobs are labeled 'igrepl-...' and recreate
      // specific real slides, so they skip this (see generateFromReference).
      if (contentFormat === 'carousels' && images.length && label.startsWith('adhoc-')) {
        await sendText(chatId, `🎠 Base images done — generating pose variants for each…`)
        images = await expandCarouselVariants(userId, label, images).catch(err => {
          console.error('[telegram-recreate/webhook] carousel variant expansion failed:', err)
          return images
        })
      }

      if (images.length === 1) {
        await sendPhoto(chatId, images[0], `✅ ${escapeHtml(label)}`).catch(() => {})
      } else if (images.length > 1) {
        // Telegram's sendMediaGroup caps at 10 items per call.
        for (let g = 0; g < images.length; g += 10) {
          await sendMediaGroup(chatId, images.slice(g, g + 10), `✅ ${escapeHtml(label)} (${images.length})`).catch(() => {})
        }
      } else {
        await sendText(chatId, '⚠️ Job finished but produced no image.')
      }

      const folderUrl = await findDriveFolderLink(userId, label, contentFormat).catch(() => null)
      if (folderUrl) await sendText(chatId, `📁 <a href="${folderUrl}">Drive folder</a>`)
      return
    }

    if (row.status === 'failed') {
      await sendText(chatId, `❌ Generation failed: ${escapeHtml((row.error ?? 'unknown error').slice(0, 300))}`)
      return
    }

    // Still processing/pending — only give up if the heartbeat has gone
    // stale, not just because time has passed.
    const lastActivity = row.output?.progressAt ? new Date(row.output.progressAt).getTime() : new Date(row.started_at).getTime()
    if (Date.now() - lastActivity > STALE_AFTER_MS) {
      const cancelled = await query(
        `UPDATE generation_queue SET status='failed', error=$1, finished_at=now() WHERE id=$2 AND status='processing'`,
        [`Auto-cancelled — no progress for ${Math.round(STALE_AFTER_MS / 60000)}+ minutes`, jobId],
      )
      if ((cancelled.rowCount ?? 0) > 0) {
        await sendText(chatId, '❌ Generation stalled with no progress — cancelled automatically. Try again.')
        return
      }
      // Someone/something else already moved it past 'processing' between our
      // read and this UPDATE — fall through and let the next loop iteration
      // see whatever it actually became (done/failed).
    }
  }
  await sendText(chatId, '⏳ Still running after 45 minutes — check back later, it will land here if it finishes.')
}

/**
 * Runs once a reference photo + pose source are both known. Two pose
 * sources: the pose_library (random draw, wantCount) for /recreate, or an
 * explicit list of scraped Instagram image URLs (explicitPoses) for
 * /replicate — same generation mechanism either way, only where the "image
 * 1" scene reference comes from differs.
 */
async function generateFromReference(opts: {
  userId: string
  chatId: number
  referenceImageUrl: string
  extra: string | null
  contentFormat: ContentFormat
  nsfw: boolean
  formatLabel: string
  wantCount?: number
  explicitPoses?: string[]
  /** Drive characterKey / job label prefix. 'adhoc' (default) = library draw, earns carousel variant expansion; anything else opts out (see pollAndDeliver). */
  labelPrefix?: string
}): Promise<void> {
  const { userId, chatId, referenceImageUrl, extra, contentFormat, nsfw, formatLabel, wantCount, explicitPoses, labelPrefix } = opts

  let poses: { id: string | null; image_url: string; category: string | null }[]
  if (explicitPoses) {
    poses = explicitPoses.map(url => ({ id: null, image_url: url, category: null }))
  } else {
    // Draws from the WHOLE library (all content_format tags combined), not
    // just the tag matching the picked format — content_format only controls
    // output dimension/Drive folder/NSFW gating below, it was never a real
    // constraint on which pose can serve which output (every pose goes
    // through the same Seedream Edit regardless). Per the user's explicit
    // ask: a "posts"-tagged pool of 36-40 was recycling constantly while
    // ~1000 untagged-for-this-format poses sat unused. nsfw stays a hard
    // filter — the one axis that's a genuine safety boundary, not
    // organizational.
    const libraryPoses = await rows<{ id: string; image_url: string; category: string | null }>(
      `SELECT id, image_url, category FROM pose_library
        WHERE user_id = $1 AND active = true AND nsfw = $2
        ORDER BY random() LIMIT $3`,
      [userId, nsfw, wantCount ?? 1],
    )
    if (!libraryPoses.length) {
      await sendText(chatId, `⚠️ No ${nsfw ? 'NSFW' : 'SFW'} poses in the ${escapeHtml(formatLabel)} library yet — import some first.`)
      return
    }
    poses = libraryPoses
  }

  const prefix = labelPrefix ?? 'adhoc'
  const label = `${prefix}-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`
  const note = wantCount && poses.length < wantCount ? ` (only ${poses.length} pose${poses.length === 1 ? '' : 's'} available)` : ''
  // Carousel: pose-variant expansion happens after the base job completes
  // (expandCarouselVariants, called from pollAndDeliver) — not through
  // copy_prompts_generate's own carousel.enabled here, see that function's
  // doc comment for why. Only the library-draw ('adhoc') flow gets synthetic
  // variants — /replicate is recreating specific real slides, adding invented
  // extra poses on top would defeat the point.
  const willExpandVariants = contentFormat === 'carousels' && prefix === 'adhoc'
  const totalSlides = poses.length * (willExpandVariants ? 1 + CAROUSEL_VARIANT_COUNT : 1)
  await sendText(chatId, `🎨 Generating ${poses.length} base image${poses.length === 1 ? '' : 's'}${willExpandVariants ? ` (${totalSlides} total with pose variants)` : ''}${note}…`)

  const items: CopyPromptsJobInput['items'] = poses.map(p => ({
    promptId: p.id ?? crypto.randomUUID(),
    referenceImageUrls: [p.image_url],
    prompt: renderPoseRecreatePrompt({ category: p.category, nsfw, extra }),
  }))

  const input: CopyPromptsJobInput = {
    items,
    mode: 'seedream-edit',
    referenceImageUrls: [referenceImageUrl],
    dimension: suggestedDimensionForFormat(contentFormat),
    folderName: label,
    contentFormat,
  }

  const row = await one<{ id: string }>(
    `INSERT INTO generation_queue (user_id, job_type, input, total_items)
     VALUES ($1, 'copy_prompts_generate', $2, $3)
     RETURNING id`,
    [userId, JSON.stringify(input), items.length],
  )
  if (!row) {
    await sendText(chatId, '❌ Could not queue the job.')
    return
  }

  const realPoseIds = poses.map(p => p.id).filter((id): id is string => id !== null)
  if (realPoseIds.length) {
    await query(
      `UPDATE pose_library SET used_count = used_count + 1, last_used_at = now() WHERE id = ANY($1)`,
      [realPoseIds],
    )
  }

  // Start now instead of waiting for cron — same claim-then-kick pattern the
  // main Copy-Paste bot's cpgo handler uses.
  const claimed = await one<{ id: string }>(
    `UPDATE generation_queue SET status='processing', started_at=now(), attempts=attempts+1
      WHERE id=$1 AND status='pending' RETURNING id`,
    [row.id],
  ).catch(() => null)
  if (claimed && CRON_SECRET) {
    fetch(`${internalBaseUrl()}/api/queue/process/${row.id}`, {
      method: 'POST',
      headers: { 'x-cron-secret': CRON_SECRET },
    }).catch(err => console.error('[telegram-recreate/webhook] fire worker:', err))
  }

  pollAndDeliver(row.id, chatId, userId, label, contentFormat).catch(err => console.error('[telegram-recreate/webhook] poll:', err))
}

export async function POST(req: NextRequest) {
  if (!CRON_SECRET) {
    console.error('[telegram-recreate/webhook] CRON_SECRET is not set — refusing to run')
    return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 503 })
  }
  if (req.nextUrl.searchParams.get('secret') !== CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const message = body.message
    const cb = body.callback_query

    // ── /start — link this bot's chat to an XXmachine account by Telegram username ──
    if (message?.text?.startsWith('/start')) {
      const chatId = message.chat?.id as number | undefined
      const tgUsername = message.from?.username as string | undefined
      if (chatId) {
        let linked = false
        if (tgUsername) {
          const r = await query(
            `UPDATE users SET telegram_recreate_chat_id = $1
              WHERE lower(replace(coalesce(telegram, ''), '@', '')) = lower($2)
             RETURNING id`,
            [chatId, tgUsername],
          )
          linked = (r.rowCount ?? 0) > 0
        }
        await sendText(
          chatId,
          linked
            ? '✅ Linked. Send /recreate to start.'
            : '⚠️ Could not find your XXmachine account by Telegram username. Set your Telegram username in xxmachine Settings, then send /start again.',
        )
      }
      return NextResponse.json({ ok: true })
    }

    // ── /recreate — entry menu ──
    if (message?.text?.startsWith('/recreate')) {
      const chatId = message.chat?.id as number | undefined
      if (!chatId) return NextResponse.json({ ok: true })
      const userId = await findUserId(chatId)
      if (!userId) {
        await sendText(chatId, '⚠️ Not linked yet — send /start first.')
        return NextResponse.json({ ok: true })
      }
      await clearPending(chatId)
      await sendText(chatId, '🎭 <b>Recreate</b>\nPick a format:', recreateMenuKeyboard())
      return NextResponse.json({ ok: true })
    }

    // ── /replicate <url> — recreate an IG post/carousel's own images with your character ──
    if (message?.text?.startsWith('/replicate')) {
      const chatId = message.chat?.id as number | undefined
      if (!chatId) return NextResponse.json({ ok: true })
      const userId = await findUserId(chatId)
      if (!userId) {
        await sendText(chatId, '⚠️ Not linked yet — send /start first.')
        return NextResponse.json({ ok: true })
      }
      const urlArg = (message.text as string).split(/\s+/)[1]
      const parsed = urlArg ? parseReelUrl(urlArg) : null
      if (!parsed) {
        await sendText(chatId, 'Usage: /replicate &lt;instagram post or carousel link&gt;')
        return NextResponse.json({ ok: true })
      }
      await sendText(chatId, '🔎 Fetching that post…')
      try {
        const byCode = await resolveVideoUrlsViaApify([parsed.permalink])
        const match = byCode.get(parsed.shortCode.toLowerCase())
        const images = match?.images?.length ? match.images : (match?.displayUrl ? [match.displayUrl] : [])
        if (!images.length) {
          await sendText(chatId, "⚠️ Couldn't find any images on that post — might be a video-only reel, private, or deleted.")
          return NextResponse.json({ ok: true })
        }
        await query(
          `INSERT INTO telegram_recreate_pending (chat_id, format, ig_pose_urls)
           VALUES ($1, 'p', $2)
           ON CONFLICT (chat_id) DO UPDATE SET
             format = 'p', ig_pose_urls = $2, photo_url = NULL, count = NULL, awaiting_prompt = false, created_at = now()`,
          [chatId, images],
        )
        await sendText(
          chatId,
          `📸 Found ${images.length} image${images.length === 1 ? '' : 's'}. Send a reference photo of your character now.`,
        )
      } catch (err) {
        console.error('[telegram-recreate/webhook] /replicate fetch failed:', err)
        await sendText(chatId, `❌ Could not fetch that post: ${escapeHtml(err instanceof Error ? err.message : 'unknown error')}`)
      }
      return NextResponse.json({ ok: true })
    }

    // ── photo upload — reference image for a pending format choice or /replicate ──
    if (message?.photo?.length) {
      const chatId = message.chat?.id as number | undefined
      if (!chatId) return NextResponse.json({ ok: true })
      const userId = await findUserId(chatId)
      if (!userId) return NextResponse.json({ ok: true })

      const pending = await getPending(chatId)
      if (!pending) {
        await sendText(chatId, 'Send /recreate or /replicate first.')
        return NextResponse.json({ ok: true })
      }

      try {
        const largest = message.photo[message.photo.length - 1]
        const { buffer, contentType, extension } = await downloadTelegramFile(largest.file_id)
        const path = `pose-recreate-refs/${userId}/${Date.now()}.${extension}`
        const referenceImageUrl = await uploadBuffer(buffer, path, contentType)

        if (pending.ig_pose_urls?.length) {
          // /replicate — poses are already known, generate immediately (no
          // count-picker/add-prompt steps, keeps "just paste a link" simple).
          const igPoses = pending.ig_pose_urls
          await clearPending(chatId)
          const contentFormat: ContentFormat = igPoses.length > 1 ? 'carousels' : 'posts'
          await generateFromReference({
            userId, chatId, referenceImageUrl, extra: null,
            contentFormat, nsfw: false, formatLabel: 'IG replicate',
            explicitPoses: igPoses, labelPrefix: 'igrepl',
          })
          return NextResponse.json({ ok: true })
        }

        await query(
          `UPDATE telegram_recreate_pending SET photo_url = $1 WHERE chat_id = $2`,
          [referenceImageUrl, chatId],
        )
        const slidesPerPose = pending.format === 'c' ? 1 + CAROUSEL_VARIANT_COUNT : 1
        await sendText(chatId, 'How many to generate?', countKeyboard(slidesPerPose))
      } catch (err) {
        console.error('[telegram-recreate/webhook] reference upload failed:', err)
        await sendText(chatId, '❌ Could not process that photo — try again.')
      }
      return NextResponse.json({ ok: true })
    }

    // ── plain text reply — only meaningful while awaiting an extra prompt ──
    if (message?.text && !message.text.startsWith('/')) {
      const chatId = message.chat?.id as number | undefined
      if (!chatId) return NextResponse.json({ ok: true })
      const pending = await getPending(chatId)
      if (pending?.awaiting_prompt && pending.photo_url && pending.count) {
        const fmt = pending.format as FormatCode
        const photoUrl = pending.photo_url
        const wantCount = pending.count
        await clearPending(chatId)
        await generateFromReference({
          userId: (await findUserId(chatId))!,
          chatId,
          referenceImageUrl: photoUrl,
          contentFormat: FORMAT_CODES[fmt],
          nsfw: fmt === 'fn',
          formatLabel: FORMAT_LABELS[fmt],
          wantCount,
          extra: message.text as string,
        })
      }
      return NextResponse.json({ ok: true })
    }

    // ── callback_query ──
    if (cb) {
      const data = cb.data as string | undefined
      const chatId = cb.message?.chat?.id as number | undefined
      const messageId = cb.message?.message_id as number | undefined
      if (!data || !chatId) return NextResponse.json({ ok: true })

      const userId = await findUserId(chatId)
      if (!userId) {
        await answerCallbackQuery(cb.id, 'Not linked — send /start first')
        return NextResponse.json({ ok: true })
      }

      const parts = data.split(':')
      const action = parts[0] === 'rc' ? parts[1] : null

      if (action === 'cancel') {
        await clearPending(chatId)
        await answerCallbackQuery(cb.id, 'Cancelled')
        if (messageId) await editMessageReplyMarkup(chatId, messageId, {})
        return NextResponse.json({ ok: true })
      }

      if (action === 'fmt') {
        const fmt = parts[2] as FormatCode
        await answerCallbackQuery(cb.id)
        await query(
          `INSERT INTO telegram_recreate_pending (chat_id, format)
           VALUES ($1, $2)
           ON CONFLICT (chat_id) DO UPDATE SET
             format = $2, photo_url = NULL, count = NULL, awaiting_prompt = false, ig_pose_urls = NULL, created_at = now()`,
          [chatId, fmt],
        )
        if (messageId) {
          await editMessageText(chatId, messageId, `${FORMAT_LABELS[fmt]}\n📸 Send a reference photo of your character now.`)
          await editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [[{ text: '✖️ Cancel', callback_data: 'rc:cancel' }]] })
        }
        return NextResponse.json({ ok: true })
      }

      if (action === 'cnt') {
        const n = parseInt(parts[2], 10)
        const pending = await getPending(chatId)
        if (!pending?.photo_url || !Number.isFinite(n)) {
          await answerCallbackQuery(cb.id, 'Send /recreate again')
          return NextResponse.json({ ok: true })
        }
        await query(`UPDATE telegram_recreate_pending SET count = $1 WHERE chat_id = $2`, [n, chatId])
        await answerCallbackQuery(cb.id)
        if (messageId) {
          await editMessageText(chatId, messageId, `${n}×. Want to add anything to the prompt? (style, wardrobe, anything extra)`)
          await editMessageReplyMarkup(chatId, messageId, promptChoiceKeyboard())
        }
        return NextResponse.json({ ok: true })
      }

      if (action === 'pskip' || action === 'padd') {
        const pending = await getPending(chatId)
        if (!pending?.photo_url || !pending.count) {
          await answerCallbackQuery(cb.id, 'Send /recreate again')
          return NextResponse.json({ ok: true })
        }

        if (action === 'padd') {
          await query(`UPDATE telegram_recreate_pending SET awaiting_prompt = true WHERE chat_id = $1`, [chatId])
          await answerCallbackQuery(cb.id)
          if (messageId) await editMessageReplyMarkup(chatId, messageId, {})
          await sendText(chatId, '✍️ Type the extra prompt text now.')
          return NextResponse.json({ ok: true })
        }

        // pskip
        const fmt = pending.format as FormatCode
        const photoUrl = pending.photo_url
        const wantCount = pending.count
        await clearPending(chatId)
        await answerCallbackQuery(cb.id, 'Starting…')
        if (messageId) await editMessageReplyMarkup(chatId, messageId, {})
        await generateFromReference({
          userId, chatId, referenceImageUrl: photoUrl,
          contentFormat: FORMAT_CODES[fmt], nsfw: fmt === 'fn', formatLabel: FORMAT_LABELS[fmt],
          wantCount, extra: null,
        })
        return NextResponse.json({ ok: true })
      }
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[telegram-recreate/webhook]', err)
    return NextResponse.json({ ok: true })
  }
}
