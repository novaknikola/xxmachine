import { NextRequest, NextResponse } from 'next/server'
import { one, query } from '@/lib/db'
import { generateImage, editImage, SEEDREAM_MAX_IMAGES } from '@/lib/wavespeed'
import { resolveCarouselVariantPrompts } from '@/lib/carousel-variants'
import { buildCarouselBasePrompt, DEFAULT_CAROUSEL_PRESET_ID } from '@/lib/carousel-presets'
import { uploadImageFromUrl, uploadBuffer } from '@/lib/supabase-storage'
import { generateSeedanceVideo } from '@/lib/runpod-seedance'
import { generateTalkingVideo } from '@/lib/runpod-infinitetalk'
import { promptForImage } from '@/lib/seedance-prompt'
import { resolveKey } from '@/lib/user-keys'
import { getUserApiKey } from '@/lib/user-config'
import { processVideoVariant, getVideoDuration, getVideoDimensions } from '@/lib/video-ffmpeg'
import { processImageVariant } from '@/lib/image-sharp'
import { generateAssFile, buildManualSegments, buildStaticSegment, type CaptionSegment } from '@/lib/captions'
import { transcribeVideoFile } from '@/lib/transcribe'
import { extractOnScreenText } from '@/lib/ocr'
import {
  rewriteCaptionsBatch, SHUFFLE_BATCH_SIZE, generateCaptionsBatch, filterNewCaptions, sampleExamples,
} from '@/lib/caption-shuffle'
import { downloadDriveFile, uploadToDriveFolderResilient } from '@/lib/google-drive'
import { getUserGoogleAccessToken } from '@/lib/drive-archive/user-google-auth'
import { writeFileSync, readFileSync, unlinkSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type {
  BulkImageJobItem, VideoRepurposeJobInput, ImageRepurposeJobInput, VideoCaptionJobInput, VideoCaptionItem,
  VideoTranscribeJobInput, VideoOcrJobInput, CaptionShuffleJobInput, CaptionGenerateJobInput, ComfyUIPodBulkJobInput,
  BulkCarouselJobInput, MyPodI2vJobInput, MyPodAnimateJobInput, MyPodTalkJobInput, CopyPasteJobInput,
  CopyPromptsJobInput, SeedanceI2VJobInput, InfiniteTalkJobInput,
} from '../../submit/route'
import { getPodSessionSecrets } from '@/lib/my-pod/session'
import { ensureRemoteWorkDir, cleanupRemoteJobDir } from '@/lib/my-pod/ssh'
import {
  uploadImageToComfy, submitComfyPrompt, pollComfyResult, downloadFromComfy, probeComfyHealth,
} from '@/lib/my-pod/comfy'
import { runI2vItem, runAnimateItem, runTalkItem } from '@/lib/my-pod/runners'
import { fishTts } from '@/lib/my-pod/fish-tts'
import { replicateCopyPasteItem } from '@/lib/monitor/process-item'

interface ComfyUIRow {
  prompt: string
  status: 'done' | 'error' | 'running'
  stage?: string
  driveLink?: string
  error?: string
}

interface MyPodRow {
  label: string
  status: 'done' | 'error' | 'running'
  stage?: string
  driveLink?: string
  error?: string
  /** ISO timestamp when this item finished (done or error). */
  finishedAt?: string
}

interface CarouselRow {
  prompt: string
  images: string[]
  status: 'done' | 'error'
  error?: string
}

interface CopyPasteRow {
  itemId: string
  status: 'done' | 'error'
  videoUrl?: string
  error?: string
}

interface TalkRow {
  imageUrl: string | null
  text: string | null
  audioUrl?: string
  videoUrl?: string
  costUsd?: number | null
  status: 'done' | 'error'
  error?: string
}

interface SeedanceRow {
  imageUrl: string
  /** Prompt the analysis produced for this still. */
  prompt?: string
  shotType?: string
  videoUrl?: string
  /** What the endpoint reported this render cost. */
  costUsd?: number | null
  status: 'done' | 'error'
  error?: string
}

interface CopyPromptsRow {
  promptId: string
  /** Prompt sent for the base slide — the Seedream edit itself. */
  prompt: string
  /** Prompt behind each extra carousel slide, index-aligned with images[1..]. */
  variantPrompts?: string[]
  /** Reference images this item was generated from, in the order sent. */
  referenceImageUrls?: string[]
  images: string[]
  status: 'done' | 'error'
  error?: string
}

const execFileAsync = promisify(execFile)
const CRON_SECRET = process.env.CRON_SECRET
const VIDEO_BATCH_SIZE = 3
/** No GPU/browser contention server-side (that was the whole point of this move), so this can run higher than the old client-side WORKER_CONCURRENCY=4. */
const IMAGE_REPURPOSE_BATCH_SIZE = 6
const GENERATE_BATCH_SIZE = 20
const EXAMPLE_SAMPLE_SIZE = 25
const CAROUSEL_BATCH_SIZE = 2
const COPY_PASTE_BATCH_SIZE = 2
const COPY_PROMPTS_BATCH_SIZE = 2
/** Renders run on RunPod's GPUs, not here, so a few at a time is pacing the provider, not this box. */
const SEEDANCE_BATCH_SIZE = 3
/** TTS then a lip-sync render; the render dominates and runs on RunPod. */
const TALK_BATCH_SIZE = 2

/** Lease heartbeat so cron can requeue zombie My Pod workers after deploy/crash. */
function packMyPodOutput(rows: MyPodRow[], stage: string) {
  return JSON.stringify({
    myPodRows: rows,
    stage,
    progressAt: new Date().toISOString(),
  })
}

function myPodItemDone(label: string, driveLink?: string): MyPodRow {
  return {
    label,
    status: 'done',
    stage: 'done',
    driveLink,
    finishedAt: new Date().toISOString(),
  }
}

function myPodItemError(label: string, error: string): MyPodRow {
  return {
    label,
    status: 'error',
    stage: 'error',
    error,
    finishedAt: new Date().toISOString(),
  }
}

/** Stop batch early if the job was cancelled, paused or deleted from the queue. */
async function jobStillRunning(id: string): Promise<boolean> {
  const row = await one<{ status: string }>(
    `SELECT status FROM generation_queue WHERE id = $1`,
    [id],
  )
  return row?.status === 'processing'
}

function packComfyOutput(rows: ComfyUIRow[], stage: string) {
  return JSON.stringify({
    comfyuiRows: rows,
    stage,
    progressAt: new Date().toISOString(),
  })
}

type RouteParams = { params: Promise<{ id: string }> }

interface JobRow {
  id: string
  user_id: string
  status: string
  job_type: string
  input: Record<string, unknown>
  output: {
    urls?: string[]
    rows?: { videoName: string; text: string }[]
    comfyuiRows?: ComfyUIRow[]
    myPodRows?: MyPodRow[]
    stage?: string
    texts?: string[]
    carouselRows?: CarouselRow[]
    copyPasteRows?: CopyPasteRow[]
    copyPromptsRows?: CopyPromptsRow[]
    seedanceRows?: SeedanceRow[]
    talkRows?: TalkRow[]
    progressAt?: string
  } | null
  attempts: number
  max_attempts: number
  done_items: number
  total_items: number
  pod_session_id: string | null
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  // Fail closed: without a configured secret this endpoint would be publicly callable.
  if (!CRON_SECRET) {
    console.error('[queue/process] CRON_SECRET is not set — refusing to run')
    return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 503 })
  }
  if (req.headers.get('x-cron-secret') !== CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params

  const job = await one<JobRow>(
    `SELECT id, user_id, status, job_type, input, output, attempts, max_attempts, done_items, total_items,
            pod_session_id
       FROM generation_queue WHERE id = $1`,
    [id],
  )

  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (job.status !== 'processing') {
    return NextResponse.json({ error: 'Job not in processing state' }, { status: 409 })
  }

  try {
    // ── bulk_image ────────────────────────────────────────────────────────────
    if (job.job_type === 'bulk_image') {
      const apiKey = await getUserApiKey(job.user_id, 'wavespeed_api_key').catch(() => '')
      const hfToken = await getUserApiKey(job.user_id, 'hf_token').catch(() => '')

      if (!apiKey) {
        await query(
          `UPDATE generation_queue SET status='failed', error=$1, finished_at=now() WHERE id=$2`,
          ['WAVESPEED_API_KEY not configured', id],
        )
        return NextResponse.json({ error: 'Missing API key' }, { status: 500 })
      }

      const inputJobs: BulkImageJobItem[] = (job.input as { jobs: BulkImageJobItem[] })?.jobs ?? []
      const allOutputUrls: string[] = []
      let doneCount = job.done_items

      for (let i = doneCount; i < inputJobs.length; i++) {
        // A Stop/Delete from the queue UI only flips the row; the worker has to
        // notice it, or the button lies and paid work keeps running.
        if (!(await jobStillRunning(id))) {
          console.log(`[queue/process] bulk_image ${id} stopped at ${i}/${inputJobs.length}`)
          return NextResponse.json({ ok: true, cancelled: true, done: doneCount })
        }
        const item = inputJobs[i]
        try {
          const urls = await generateImage({
            prompt: item.prompt,
            dimension: item.dimension,
            loraUrl: item.loraUrl,
            loraScale: item.loraScale,
            apiKey,
            hfToken,
            signal: AbortSignal.timeout(130_000),
          })

          for (let u = 0; u < urls.length; u++) {
            try {
              const stored = await uploadImageFromUrl(urls[u], `queue/${id}/${i + 1}_${u + 1}.jpg`)
              allOutputUrls.push(stored)
            } catch {
              allOutputUrls.push(urls[u])
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'failed'
          allOutputUrls.push(`error:${msg}`)
          console.error(`[queue/process] job ${id} item ${i} failed:`, msg)
        }

        doneCount++
        const progress = Math.round((doneCount / inputJobs.length) * 100)
        await query(
          `UPDATE generation_queue SET done_items=$1, progress=$2 WHERE id=$3`,
          [doneCount, progress, id],
        )
      }

      await query(
        `UPDATE generation_queue
            SET status='done', finished_at=now(), progress=100, done_items=$1,
                output=jsonb_build_object('urls', $2::jsonb)
          WHERE id=$3`,
        [doneCount, JSON.stringify(allOutputUrls), id],
      )

      return NextResponse.json({ ok: true, done: doneCount })
    }

    // ── video_repurpose ───────────────────────────────────────────────────────
    if (job.job_type === 'video_repurpose') {
      const {
        videoUrl, videoName, count, baseSeed, effects, archiveToDrive, characterKey, seriesLabel,
        driveFileId, outputDriveFolderId,
      } = job.input as unknown as VideoRepurposeJobInput
      let doneCount = job.done_items

      // Resume: load existing output URLs from DB
      const allOutputUrls: (string | null)[] = new Array(count).fill(null)
      const existingUrls = job.output?.urls ?? []
      for (let i = 0; i < Math.min(existingUrls.length, count); i++) {
        allOutputUrls[i] = existingUrls[i]
      }

      // Download source video to temp file. A Drive source is read with the
      // platform service account, same as the folder listing at submit time.
      let sourceBuffer: Buffer
      if (driveFileId) {
        sourceBuffer = await downloadDriveFile(driveFileId)
      } else {
        const videoRes = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) })
        if (!videoRes.ok) throw new Error(`Failed to download source video: ${videoRes.status}`)
        sourceBuffer = Buffer.from(await videoRes.arrayBuffer())
      }
      const inputPath = join(tmpdir(), `vr_in_${randomUUID()}.mp4`)
      writeFileSync(inputPath, sourceBuffer)

      const fadeDuration = effects.fade ? (await getVideoDuration(inputPath) ?? undefined) : undefined

      try {
        for (let batchStart = doneCount; batchStart < count; batchStart += VIDEO_BATCH_SIZE) {
          // A Stop/Delete from the queue UI only flips the row; the worker has to
          // notice it, or the button lies and paid work keeps running.
          if (!(await jobStillRunning(id))) {
            console.log(`[queue/process] video_repurpose ${id} stopped at ${doneCount}/${count}`)
            return NextResponse.json({ ok: true, cancelled: true, done: doneCount })
          }
          const batchEnd = Math.min(batchStart + VIDEO_BATCH_SIZE, count)
          const batchIndices = Array.from({ length: batchEnd - batchStart }, (_, i) => batchStart + i)

          await Promise.all(batchIndices.map(async (variantIdx) => {
            const seed = baseSeed + variantIdx * 1337
            const outputPath = await processVideoVariant(inputPath, seed, effects, fadeDuration)

            if (outputPath) {
              try {
                const buf = readFileSync(outputPath)
                const url = await uploadBuffer(buf, `queue/${id}/${variantIdx + 1}.mp4`, 'video/mp4')
                allOutputUrls[variantIdx] = url

                // Explicit destination folder. Its own try/catch: the variant is
                // already rendered and stored, so a Drive hiccup must not mark it
                // failed — it is logged and the run carries on.
                if (outputDriveFolderId) {
                  const base = (videoName ?? 'video').replace(/\.[^.]+$/, '')
                  try {
                    await uploadToDriveFolderResilient(
                      job.user_id,
                      outputDriveFolderId,
                      `${base}_${String(variantIdx + 1).padStart(3, '0')}.mp4`,
                      buf,
                      'video/mp4',
                    )
                  } catch (err) {
                    console.error(
                      `[queue/process] video_repurpose ${id} variant ${variantIdx + 1} Drive upload failed:`,
                      err instanceof Error ? err.message : err,
                    )
                  }
                }
              } catch {
                allOutputUrls[variantIdx] = `error:upload failed`
              } finally {
                try { unlinkSync(outputPath) } catch {}
              }
            } else {
              allOutputUrls[variantIdx] = `error:FFmpeg failed`
            }
          }))

          doneCount = batchEnd
          const progress = Math.round((doneCount / count) * 100)
          const urls = allOutputUrls.filter(Boolean) as string[]

          await query(
            `UPDATE generation_queue
                SET done_items=$1, progress=$2, output=jsonb_build_object('urls', $3::jsonb)
              WHERE id=$4`,
            [doneCount, progress, JSON.stringify(urls), id],
          )
        }
      } finally {
        try { unlinkSync(inputPath) } catch {}
      }

      const finalUrls = allOutputUrls.filter(Boolean) as string[]
      await query(
        `UPDATE generation_queue
            SET status='done', finished_at=now(), progress=100, done_items=$1,
                output=jsonb_build_object('urls', $2::jsonb)
          WHERE id=$3`,
        [count, JSON.stringify(finalUrls), id],
      )

      // Opt-in only: the Repurpose page never sets this, so its behaviour is
      // unchanged. Variants share one seriesId so Drive sorts them together
      // instead of scattering them by hash — same pattern as bulk_carousel.
      // Skipped when an explicit output folder was given: that is an override of
      // the computed {character}/{kind}/{stage}/{date} tree, not a second copy.
      if (archiveToDrive && !outputDriveFolderId) {
        try {
          const { enqueueDriveArchive } = await import('@/lib/drive-archive/enqueue')
          const good = finalUrls.filter(u => !u.startsWith('error:'))
          for (let vi = 0; vi < good.length; vi++) {
            await enqueueDriveArchive({
              userId: job.user_id,
              sourceType: 'queue_job',
              sourceId: `${id}:${vi}`,
              urls: [good[vi]],
              characterKey: characterKey ?? null,
              kind: 'reels',
              stage: 'ready',
              modelKey: 'repurpose',
              seriesId: id,
              seriesIndex: vi,
              seriesTotal: good.length,
              // Same prefix the source reel's raw/ copy carries, so an original
              // and its variants line up by name across the two folders.
              seriesLabel,
            })
          }
        } catch (err) {
          console.error(`[queue/process] video_repurpose ${id} drive archive failed:`, err)
        }
      }

      // Telegram push only for jobs the bot itself created (folder command /
      // "Repurpose ×N" button — enqueueRepurposeJob always sets archiveToDrive
      // true). A web-dashboard submission never sets this, so it stays silent —
      // nothing there was ever triggered from Telegram, so a Telegram DM about
      // it has no start-of-loop to close.
      if (archiveToDrive) {
        const { notifyRepurposeDone } = await import('@/lib/monitor/notify')
        await notifyRepurposeDone({
          userId: job.user_id,
          total: count,
          failed: finalUrls.filter(u => u.startsWith('error:')).length,
          videoName,
          outputDriveFolderId,
        }).catch(() => {})
      }

      return NextResponse.json({ ok: true, done: count })
    }

    // ── image_repurpose ────────────────────────────────────────────────────────
    if (job.job_type === 'image_repurpose') {
      const {
        imageUrl, imageName, count, baseSeed, settings, driveFileId, outputDriveFolderId,
      } = job.input as unknown as ImageRepurposeJobInput
      let doneCount = job.done_items

      // Resume: load existing output URLs from DB
      const allOutputUrls: (string | null)[] = new Array(count).fill(null)
      const existingUrls = job.output?.urls ?? []
      for (let i = 0; i < Math.min(existingUrls.length, count); i++) {
        allOutputUrls[i] = existingUrls[i]
      }

      // sharp works on buffers directly — no temp files needed, unlike the
      // ffmpeg video path above.
      let sourceBuffer: Buffer
      if (driveFileId) {
        sourceBuffer = await downloadDriveFile(driveFileId)
      } else {
        const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(60_000) })
        if (!imgRes.ok) throw new Error(`Failed to download source image: ${imgRes.status}`)
        sourceBuffer = Buffer.from(await imgRes.arrayBuffer())
      }

      for (let batchStart = doneCount; batchStart < count; batchStart += IMAGE_REPURPOSE_BATCH_SIZE) {
        // A Stop/Delete from the queue UI only flips the row; the worker has to
        // notice it, or the button lies and paid work keeps running.
        if (!(await jobStillRunning(id))) {
          console.log(`[queue/process] image_repurpose ${id} stopped at ${doneCount}/${count}`)
          return NextResponse.json({ ok: true, cancelled: true, done: doneCount })
        }
        const batchEnd = Math.min(batchStart + IMAGE_REPURPOSE_BATCH_SIZE, count)
        const batchIndices = Array.from({ length: batchEnd - batchStart }, (_, i) => batchStart + i)

        await Promise.all(batchIndices.map(async (variantIdx) => {
          const seed = baseSeed + variantIdx * 1337
          try {
            const buf = await processImageVariant(sourceBuffer, seed, settings)
            const url = await uploadBuffer(buf, `queue/${id}/${variantIdx + 1}.jpg`, 'image/jpeg')
            allOutputUrls[variantIdx] = url

            // Explicit destination folder. Its own try/catch: the variant is
            // already rendered and stored, so a Drive hiccup must not mark it
            // failed — it is logged and the run carries on.
            if (outputDriveFolderId) {
              const base = (imageName ?? 'image').replace(/\.[^.]+$/, '')
              try {
                await uploadToDriveFolderResilient(
                  job.user_id,
                  outputDriveFolderId,
                  `${base}_${String(variantIdx + 1).padStart(3, '0')}.jpg`,
                  buf,
                  'image/jpeg',
                )
              } catch (err) {
                console.error(
                  `[queue/process] image_repurpose ${id} variant ${variantIdx + 1} Drive upload failed:`,
                  err instanceof Error ? err.message : err,
                )
              }
            }
          } catch (err) {
            console.error(
              `[queue/process] image_repurpose ${id} variant ${variantIdx + 1} failed:`,
              err instanceof Error ? err.message : err,
            )
            allOutputUrls[variantIdx] = `error:${err instanceof Error ? err.message : 'processing failed'}`
          }
        }))

        doneCount = batchEnd
        const progress = Math.round((doneCount / count) * 100)
        const urls = allOutputUrls.filter(Boolean) as string[]

        await query(
          `UPDATE generation_queue
              SET done_items=$1, progress=$2, output=jsonb_build_object('urls', $3::jsonb)
            WHERE id=$4`,
          [doneCount, progress, JSON.stringify(urls), id],
        )
      }

      const finalUrls = allOutputUrls.filter(Boolean) as string[]
      await query(
        `UPDATE generation_queue
            SET status='done', finished_at=now(), progress=100, done_items=$1,
                output=jsonb_build_object('urls', $2::jsonb)
          WHERE id=$3`,
        [count, JSON.stringify(finalUrls), id],
      )

      // No Telegram origin exists for image_repurpose yet — it's only ever
      // submitted from the web dashboard, so there is nothing to notify back
      // to. Revisit if a Telegram-triggered path is ever added (mirror the
      // archiveToDrive gate video_repurpose uses above).

      return NextResponse.json({ ok: true, done: count })
    }

    // ── video_caption ─────────────────────────────────────────────────────────
    if (job.job_type === 'video_caption') {
      const input = job.input as unknown as VideoCaptionJobInput & {
        // legacy pre-bulk shape (rows submitted before the items[] rework)
        videoUrl?: string; videoName?: string; segments?: CaptionSegment[]
      }
      const items: VideoCaptionItem[] = input.items
        ?? (input.videoUrl ? [{ videoUrl: input.videoUrl, videoName: input.videoName ?? 'video.mp4' }] : [])
      const legacySegments = input.items ? undefined : input.segments
      const { style, customStyle, maxWords, maxDuration, textMode } = input

      if (items.length === 0) throw new Error('No items in job input')

      const hfToken = await getUserApiKey(job.user_id, 'hf_token').catch(() => '')
      const needsTranscription = items.some((it, idx) => !it.text?.trim() && !(idx === 0 && legacySegments?.length))
      if (!hfToken && needsTranscription) {
        await query(
          `UPDATE generation_queue SET status='failed', error=$1, finished_at=now() WHERE id=$2`,
          ['HF_TOKEN not configured', id],
        )
        return NextResponse.json({ error: 'Missing HF_TOKEN' }, { status: 500 })
      }

      const allOutputUrls: string[] = job.output?.urls ? [...job.output.urls] : []
      let doneCount = job.done_items

      for (let i = doneCount; i < items.length; i++) {
        // A Stop/Delete from the queue UI only flips the row; the worker has to
        // notice it, or the button lies and paid work keeps running.
        if (!(await jobStillRunning(id))) {
          console.log(`[queue/process] video_caption ${id} stopped at ${i}/${items.length}`)
          return NextResponse.json({ ok: true, cancelled: true, done: doneCount })
        }
        const item = items[i]
        const uid = randomUUID()
        const inputPath = join(tmpdir(), `cap_in_${uid}.mp4`)
        const assPath = join(tmpdir(), `cap_subs_${uid}.ass`)
        const outputPath = join(tmpdir(), `cap_out_${uid}.mp4`)

        try {
          const videoRes = await fetch(item.videoUrl, { signal: AbortSignal.timeout(120_000) })
          if (!videoRes.ok) throw new Error(`Failed to download source video: ${videoRes.status}`)
          writeFileSync(inputPath, Buffer.from(await videoRes.arrayBuffer()))

          let segments: CaptionSegment[]
          if (i === 0 && legacySegments?.length) {
            segments = legacySegments
          } else if (item.text?.trim()) {
            const duration = await getVideoDuration(inputPath)
            if (!duration) throw new Error('Could not determine video duration for manual captions')
            segments = textMode === 'static'
              ? buildStaticSegment(item.text, duration)
              : buildManualSegments(item.text, duration)
          } else {
            segments = await transcribeVideoFile(inputPath, hfToken, maxWords, maxDuration)
          }

          const dims = await getVideoDimensions(inputPath)
          const assContent = generateAssFile(segments, style, {
            ...customStyle,
            videoWidth: dims?.width ?? customStyle?.videoWidth,
            videoHeight: dims?.height ?? customStyle?.videoHeight,
          })
          writeFileSync(assPath, assContent, 'utf8')

          const assFilterPath = assPath
            .replace(/\\/g, '/')
            .replace(/^([A-Za-z]):/, '$1\\:')

          await execFileAsync('ffmpeg', [
            '-y', '-i', inputPath,
            '-vf', `subtitles='${assFilterPath}'`,
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
            '-c:a', 'copy', '-map_metadata', '-1', '-movflags', '+faststart',
            outputPath,
          ])

          const buf = readFileSync(outputPath)
          const outputName = (item.videoName ?? 'video').replace(/\.[^.]+$/, '')
          const storedUrl = await uploadBuffer(buf, `queue/${id}/${i + 1}_${outputName}_${style}.mp4`, 'video/mp4')
          allOutputUrls.push(storedUrl)
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'failed'
          allOutputUrls.push(`error:${msg}`)
          console.error(`[queue/process] video_caption ${id} item ${i} failed:`, msg)
        } finally {
          try { unlinkSync(inputPath) } catch {}
          try { unlinkSync(assPath) } catch {}
          try { unlinkSync(outputPath) } catch {}
        }

        doneCount++
        const progress = Math.round((doneCount / items.length) * 100)
        await query(
          `UPDATE generation_queue
              SET done_items=$1, progress=$2, output=jsonb_build_object('urls', $3::jsonb)
            WHERE id=$4`,
          [doneCount, progress, JSON.stringify(allOutputUrls), id],
        )
      }

      await query(
        `UPDATE generation_queue SET status='done', finished_at=now(), progress=100 WHERE id=$1`,
        [id],
      )

      return NextResponse.json({ ok: true, done: doneCount })
    }

    // ── video_transcribe ──────────────────────────────────────────────────────
    if (job.job_type === 'video_transcribe') {
      const { items } = job.input as unknown as VideoTranscribeJobInput
      if (!items?.length) throw new Error('No items in job input')

      const hfToken = await getUserApiKey(job.user_id, 'hf_token').catch(() => '')
      if (!hfToken) {
        await query(
          `UPDATE generation_queue SET status='failed', error=$1, finished_at=now() WHERE id=$2`,
          ['HF_TOKEN not configured', id],
        )
        return NextResponse.json({ error: 'Missing HF_TOKEN' }, { status: 500 })
      }

      const rows: { videoName: string; text: string }[] = job.output?.rows ? [...job.output.rows] : []
      let doneCount = job.done_items

      for (let i = doneCount; i < items.length; i++) {
        // A Stop/Delete from the queue UI only flips the row; the worker has to
        // notice it, or the button lies and paid work keeps running.
        if (!(await jobStillRunning(id))) {
          console.log(`[queue/process] video_transcribe ${id} stopped at ${i}/${items.length}`)
          return NextResponse.json({ ok: true, cancelled: true, done: doneCount })
        }
        const item = items[i]
        const inputPath = join(tmpdir(), `tr_in_${randomUUID()}.mp4`)

        try {
          const videoRes = await fetch(item.videoUrl, { signal: AbortSignal.timeout(120_000) })
          if (!videoRes.ok) throw new Error(`Failed to download source video: ${videoRes.status}`)
          writeFileSync(inputPath, Buffer.from(await videoRes.arrayBuffer()))

          // Large limits collapse grouping into one continuous block of prose per video
          const segments = await transcribeVideoFile(inputPath, hfToken, 100_000, 100_000)
          const text = segments.map(s => s.text).join(' ').trim()
          rows.push({ videoName: item.videoName, text: text || '(no speech detected)' })
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'failed'
          rows.push({ videoName: item.videoName, text: `error: ${msg}` })
          console.error(`[queue/process] video_transcribe ${id} item ${i} failed:`, msg)
        } finally {
          try { unlinkSync(inputPath) } catch {}
        }

        doneCount++
        const progress = Math.round((doneCount / items.length) * 100)
        await query(
          `UPDATE generation_queue
              SET done_items=$1, progress=$2, output=jsonb_build_object('rows', $3::jsonb)
            WHERE id=$4`,
          [doneCount, progress, JSON.stringify(rows), id],
        )
      }

      await query(
        `UPDATE generation_queue SET status='done', finished_at=now(), progress=100 WHERE id=$1`,
        [id],
      )

      return NextResponse.json({ ok: true, done: doneCount })
    }

    // ── video_ocr ──────────────────────────────────────────────────────────────
    if (job.job_type === 'video_ocr') {
      const { items } = job.input as unknown as VideoOcrJobInput
      if (!items?.length) throw new Error('No items in job input')

      if (!process.env.XAI_API_KEY) {
        await query(
          `UPDATE generation_queue SET status='failed', error=$1, finished_at=now() WHERE id=$2`,
          ['XAI_API_KEY not configured', id],
        )
        return NextResponse.json({ error: 'Missing XAI_API_KEY' }, { status: 500 })
      }

      const rows: { videoName: string; text: string }[] = job.output?.rows ? [...job.output.rows] : []
      let doneCount = job.done_items

      for (let i = doneCount; i < items.length; i++) {
        // A Stop/Delete from the queue UI only flips the row; the worker has to
        // notice it, or the button lies and paid work keeps running.
        if (!(await jobStillRunning(id))) {
          console.log(`[queue/process] video_ocr ${id} stopped at ${i}/${items.length}`)
          return NextResponse.json({ ok: true, cancelled: true, done: doneCount })
        }
        const item = items[i]
        const inputPath = join(tmpdir(), `ocr_in_${randomUUID()}.mp4`)

        try {
          const videoRes = await fetch(item.videoUrl, { signal: AbortSignal.timeout(120_000) })
          if (!videoRes.ok) throw new Error(`Failed to download source video: ${videoRes.status}`)
          writeFileSync(inputPath, Buffer.from(await videoRes.arrayBuffer()))

          const text = await extractOnScreenText(inputPath)
          rows.push({ videoName: item.videoName, text })
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'failed'
          rows.push({ videoName: item.videoName, text: `error: ${msg}` })
          console.error(`[queue/process] video_ocr ${id} item ${i} failed:`, msg)
        } finally {
          try { unlinkSync(inputPath) } catch {}
        }

        doneCount++
        const progress = Math.round((doneCount / items.length) * 100)
        await query(
          `UPDATE generation_queue
              SET done_items=$1, progress=$2, output=jsonb_build_object('rows', $3::jsonb)
            WHERE id=$4`,
          [doneCount, progress, JSON.stringify(rows), id],
        )
      }

      await query(
        `UPDATE generation_queue SET status='done', finished_at=now(), progress=100 WHERE id=$1`,
        [id],
      )

      return NextResponse.json({ ok: true, done: doneCount })
    }

    // ── caption_shuffle ────────────────────────────────────────────────────────
    if (job.job_type === 'caption_shuffle') {
      const { texts, strength } = job.input as unknown as CaptionShuffleJobInput
      if (!texts?.length) throw new Error('No texts in job input')

      if (!process.env.XAI_API_KEY) {
        await query(
          `UPDATE generation_queue SET status='failed', error=$1, finished_at=now() WHERE id=$2`,
          ['XAI_API_KEY not configured', id],
        )
        return NextResponse.json({ error: 'Missing XAI_API_KEY' }, { status: 500 })
      }

      const outTexts: string[] = job.output?.texts ? [...job.output.texts] : []
      let doneCount = job.done_items

      for (let i = doneCount; i < texts.length; i += SHUFFLE_BATCH_SIZE) {
        // A Stop/Delete from the queue UI only flips the row; the worker has to
        // notice it, or the button lies and paid work keeps running.
        if (!(await jobStillRunning(id))) {
          console.log(`[queue/process] caption_shuffle ${id} stopped at ${i}/${texts.length}`)
          return NextResponse.json({ ok: true, cancelled: true, done: doneCount })
        }
        const batch = texts.slice(i, i + SHUFFLE_BATCH_SIZE)

        try {
          outTexts.push(...await rewriteCaptionsBatch(batch, strength))
        } catch (err) {
          console.error(`[queue/process] caption_shuffle ${id} batch @${i} failed:`, err instanceof Error ? err.message : err)
          outTexts.push(...batch) // fall back to originals rather than dropping rows
        }

        doneCount = Math.min(i + SHUFFLE_BATCH_SIZE, texts.length)
        const progress = Math.round((doneCount / texts.length) * 100)
        await query(
          `UPDATE generation_queue
              SET done_items=$1, progress=$2, output=jsonb_build_object('texts', $3::jsonb)
            WHERE id=$4`,
          [doneCount, progress, JSON.stringify(outTexts), id],
        )
      }

      await query(
        `UPDATE generation_queue SET status='done', finished_at=now(), progress=100 WHERE id=$1`,
        [id],
      )

      return NextResponse.json({ ok: true, done: doneCount })
    }

    // ── caption_generate ───────────────────────────────────────────────────────
    if (job.job_type === 'caption_generate') {
      const { examples, count, hint } = job.input as unknown as CaptionGenerateJobInput
      if (!examples?.length) throw new Error('No examples in job input')

      if (!process.env.XAI_API_KEY) {
        await query(
          `UPDATE generation_queue SET status='failed', error=$1, finished_at=now() WHERE id=$2`,
          ['XAI_API_KEY not configured', id],
        )
        return NextResponse.json({ error: 'Missing XAI_API_KEY' }, { status: 500 })
      }

      const outTexts: string[] = job.output?.texts ? [...job.output.texts] : []
      // Safety cap so a run of all-duplicate generations can't loop forever —
      // the job just finishes with fewer than `count` captions instead of hanging.
      const maxAttempts = Math.ceil(count / GENERATE_BATCH_SIZE) * 4 + 20
      let attempts = 0

      while (outTexts.length < count && attempts < maxAttempts) {
        // A Stop/Delete from the queue UI only flips the row; the worker has to
        // notice it, or the button lies and paid work keeps running.
        if (!(await jobStillRunning(id))) {
          console.log(`[queue/process] caption_generate ${id} stopped at ${outTexts.length}/${count}`)
          return NextResponse.json({ ok: true, cancelled: true, done: outTexts.length })
        }
        attempts++
        const needed = Math.min(GENERATE_BATCH_SIZE, count - outTexts.length)
        const sample = sampleExamples(examples, EXAMPLE_SAMPLE_SIZE)

        try {
          const batch = await generateCaptionsBatch(sample, needed + 5, hint)
          const fresh = filterNewCaptions(batch, [...examples, ...outTexts])
          outTexts.push(...fresh.slice(0, count - outTexts.length))
        } catch (err) {
          console.error(`[queue/process] caption_generate ${id} attempt ${attempts} failed:`, err instanceof Error ? err.message : err)
        }

        const progress = Math.round((outTexts.length / count) * 100)
        await query(
          `UPDATE generation_queue
              SET done_items=$1, progress=$2, output=jsonb_build_object('texts', $3::jsonb)
            WHERE id=$4`,
          [outTexts.length, progress, JSON.stringify(outTexts), id],
        )
      }

      await query(
        `UPDATE generation_queue SET status='done', finished_at=now(), progress=100 WHERE id=$1`,
        [id],
      )

      return NextResponse.json({ ok: true, done: outTexts.length })
    }

    // ── comfyui_pod_bulk ───────────────────────────────────────────────────────
    if (job.job_type === 'comfyui_pod_bulk') {
      const { podUrl, templateId, outputDriveFolderId, items } = job.input as unknown as ComfyUIPodBulkJobInput
      if (!items?.length) throw new Error('No items in job input')

      const session = await getPodSessionSecrets(
        job.user_id,
        job.pod_session_id
          ?? (typeof job.input?.podSessionId === 'string' ? job.input.podSessionId : null),
      )
      const comfyUrl = (session?.comfyBaseUrl || podUrl).replace(/\/+$/, '')
      const apiToken = session?.comfyApiToken ?? null

      const health = await probeComfyHealth(comfyUrl, apiToken)
      if (!health.ok) throw new Error(`Pod offline — ${health.error}`)

      // Fail-fast: user must have Google connected (uploads use resilient OAuth per file).
      await getUserGoogleAccessToken(job.user_id)

      let remoteJobDir: string | null = null
      if (session) {
        try {
          const ensured = await ensureRemoteWorkDir(session.ssh, session.remoteWorkRoot, id)
          remoteJobDir = ensured.remoteJobDir
        } catch (err) {
          console.warn('[comfyui_pod_bulk] SSH mkdir skipped:', err instanceof Error ? err.message : err)
        }
      }

      const template = await one<{
        workflow_json: Record<string, unknown>
        prompt_node_id: string
        prompt_field: string
        image_node_id: string | null
        image_field: string | null
      }>(
        `SELECT workflow_json, prompt_node_id, prompt_field, image_node_id, image_field
           FROM comfyui_templates WHERE id = $1`,
        [templateId],
      )
      if (!template) throw new Error('Template no longer exists')

      const comfyuiRows: ComfyUIRow[] = job.output?.comfyuiRows ? [...job.output.comfyuiRows] : []
      let doneCount = job.done_items

      const persist = async (stage: string) => {
        const progress = Math.round((doneCount / items.length) * 100)
        await query(
          `UPDATE generation_queue
              SET done_items=$1, progress=$2, output=$3::jsonb
            WHERE id=$4`,
          [doneCount, progress, packComfyOutput(comfyuiRows, stage), id],
        )
      }

      for (let i = doneCount; i < items.length; i++) {
        const item = items[i]
        try {
          await persist('validating')
          const workflow = JSON.parse(JSON.stringify(template.workflow_json)) as Record<string, { inputs: Record<string, unknown> }>

          const promptNode = workflow[template.prompt_node_id]
          if (!promptNode) throw new Error(`Prompt node "${template.prompt_node_id}" missing from workflow`)
          promptNode.inputs[template.prompt_field] = item.prompt

          if (template.image_node_id && item.driveFileId) {
            await persist('uploading')
            const buf = await downloadDriveFile(item.driveFileId)
            let uploadedName: string
            try {
              uploadedName = await uploadImageToComfy(comfyUrl, buf, `input_${i}.png`, apiToken)
            } catch (err) {
              // one retry
              await new Promise(r => setTimeout(r, 2000))
              uploadedName = await uploadImageToComfy(comfyUrl, buf, `input_${i}.png`, apiToken)
              void err
            }
            const imageNode = workflow[template.image_node_id]
            if (!imageNode) throw new Error(`Image node "${template.image_node_id}" missing from workflow`)
            imageNode.inputs[template.image_field ?? 'image'] = uploadedName
          }

          await persist('running')
          const promptId = await submitComfyPrompt(comfyUrl, workflow, apiToken)
          const outputs = await pollComfyResult(comfyUrl, promptId, { apiToken })
          if (!outputs.length) throw new Error('Pod returned no output files')

          await persist('downloading')
          let lastLink = ''
          for (let f = 0; f < outputs.length; f++) {
            let buf: Buffer
            try {
              buf = await downloadFromComfy(comfyUrl, outputs[f], apiToken)
            } catch {
              await new Promise(r => setTimeout(r, 2000))
              buf = await downloadFromComfy(comfyUrl, outputs[f], apiToken)
            }
            const ext = outputs[f].filename.split('.').pop() ?? 'png'
            const mime = ext === 'mp4' ? 'video/mp4' : ext === 'webp' ? 'image/webp' : 'image/png'
            const uploaded = await uploadToDriveFolderResilient(
              job.user_id,
              outputDriveFolderId,
              `${i + 1}_${f + 1}.${ext}`,
              buf,
              mime,
            )
            lastLink = uploaded.link
          }
          comfyuiRows.push({ prompt: item.prompt, status: 'done', stage: 'done', driveLink: lastLink })
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'failed'
          comfyuiRows.push({ prompt: item.prompt, status: 'error', stage: 'error', error: msg })
          console.error(`[queue/process] comfyui_pod_bulk ${id} item ${i} failed:`, msg)
        }

        doneCount++
        await persist(doneCount >= items.length ? 'done' : 'uploading')
      }

      if (session && remoteJobDir) {
        await cleanupRemoteJobDir(session.ssh, remoteJobDir)
      }

      await query(
        `UPDATE generation_queue SET status='done', finished_at=now(), progress=100 WHERE id=$1`,
        [id],
      )

      return NextResponse.json({ ok: true, done: doneCount })
    }

    // ── my_pod_i2v ─────────────────────────────────────────────────────────────
    if (job.job_type === 'my_pod_i2v') {
      const input = job.input as unknown as MyPodI2vJobInput
      const session = await getPodSessionSecrets(
        job.user_id,
        job.pod_session_id
          ?? (typeof job.input?.podSessionId === 'string' ? job.input.podSessionId : null),
      )
      if (!session) throw new Error('Pod session expired — reconnect in My Pod')

      const health = await probeComfyHealth(session.comfyBaseUrl, session.comfyApiToken)
      if (!health.ok) throw new Error(`Pod offline — ${health.error}`)

      await getUserGoogleAccessToken(job.user_id)
      let remoteJobDir: string | null = null
      try {
        const d = await ensureRemoteWorkDir(session.ssh, session.remoteWorkRoot, id)
        remoteJobDir = d.remoteJobDir
      } catch (err) {
        console.warn('[my_pod_i2v] SSH workdir skipped:', err instanceof Error ? err.message : err)
      }
      const rows: MyPodRow[] = job.output?.myPodRows ? [...job.output.myPodRows] : []
      let doneCount = job.done_items
      let leaseStage = 'running'
      const touchLease = async () => {
        await query(
          `UPDATE generation_queue SET output = $1::jsonb WHERE id=$2`,
          [packMyPodOutput(rows, leaseStage), id],
        )
      }

      for (let i = doneCount; i < input.items.length; i++) {
        if (!(await jobStillRunning(id))) break
        const item = input.items[i]
        try {
          leaseStage = 'downloading_inputs'
          await query(
            `UPDATE generation_queue SET output = $1::jsonb, done_items=$2, progress=$3 WHERE id=$4 AND status='processing'`,
            [packMyPodOutput(rows, leaseStage), doneCount, Math.round((doneCount / input.items.length) * 100), id],
          )
          const imgBuf = await downloadDriveFile(item.driveFileId)
          leaseStage = 'running'
          await touchLease()
          const result = await runI2vItem({
            comfyBaseUrl: session.comfyBaseUrl,
            apiToken: session.comfyApiToken,
            ssh: session.ssh,
            imageBuffer: imgBuf,
            imageName: item.name,
            prompt: item.prompt ?? input.prompt,
            jobId: `${id}_${i}`,
            onHeartbeat: touchLease,
          })
          const ext = result.filename.split('.').pop() ?? 'mp4'
          const uploaded = await uploadToDriveFolderResilient(
            job.user_id,
            input.outputDriveFolderId,
            `${item.name.replace(/\.[^.]+$/, '')}_output.${ext}`,
            result.buffer,
            ext === 'webm' ? 'video/webm' : 'video/mp4',
          )
          rows.push(myPodItemDone(item.name, uploaded.link))
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'failed'
          rows.push(myPodItemError(item.name, msg))
          console.error(`[queue/process] my_pod_i2v ${id} item ${i}:`, msg)
        }
        doneCount++
        await query(
          `UPDATE generation_queue
              SET done_items=$1, progress=$2, output=$3::jsonb
            WHERE id=$4`,
          [doneCount, Math.round((doneCount / input.items.length) * 100), packMyPodOutput(rows, 'uploading'), id],
        )
      }

      if (remoteJobDir) await cleanupRemoteJobDir(session.ssh, remoteJobDir)
      await query(
        `UPDATE generation_queue SET status='done', finished_at=now(), progress=100 WHERE id=$1 AND status='processing'`,
        [id],
      )
      return NextResponse.json({ ok: true, done: doneCount })
    }

    // ── my_pod_animate ─────────────────────────────────────────────────────────
    if (job.job_type === 'my_pod_animate') {
      const input = job.input as unknown as MyPodAnimateJobInput
      const session = await getPodSessionSecrets(
        job.user_id,
        job.pod_session_id
          ?? (typeof job.input?.podSessionId === 'string' ? job.input.podSessionId : null),
      )
      if (!session) throw new Error('Pod session expired — reconnect in My Pod')

      const health = await probeComfyHealth(session.comfyBaseUrl, session.comfyApiToken)
      if (!health.ok) throw new Error(`Pod offline — ${health.error}`)

      await getUserGoogleAccessToken(job.user_id)
      let remoteJobDir: string | null = null
      try {
        const d = await ensureRemoteWorkDir(session.ssh, session.remoteWorkRoot, id)
        remoteJobDir = d.remoteJobDir
      } catch (err) {
        console.warn('[my_pod_animate] SSH workdir skipped:', err instanceof Error ? err.message : err)
      }
      const rows: MyPodRow[] = job.output?.myPodRows ? [...job.output.myPodRows] : []
      let doneCount = job.done_items

      const refBuf = await downloadDriveFile(input.referenceImageId)
      let leaseStage = 'running_windows'
      const touchLease = async () => {
        await query(
          `UPDATE generation_queue SET output = $1::jsonb WHERE id=$2`,
          [packMyPodOutput(rows, leaseStage), id],
        )
      }

      // Once per batch: install missing Animate nodes via Comfy URL + SSH shell (per pod).
      leaseStage = 'ensuring_nodes'
      await touchLease()
      const runAnimateEnsure = async () => {
        const { ensureAnimateNodes } = await import('@/lib/my-pod/ensure-comfy-nodes')
        const ensured = await ensureAnimateNodes({
          comfyBaseUrl: session.comfyBaseUrl,
          apiToken: session.comfyApiToken,
          ssh: session.ssh,
          onProgress: async () => { await touchLease() },
        })
        if (!ensured.ok) throw new Error(ensured.error)
        if (ensured.installed.length) {
          console.log(`[my_pod_animate] auto-installed: ${ensured.installed.join(', ')}`)
        }
      }
      await runAnimateEnsure()

      for (let i = doneCount; i < input.items.length; i++) {
        if (!(await jobStillRunning(id))) break
        const item = input.items[i]
        try {
          leaseStage = 'downloading_inputs'
          await touchLease()
          const vidBuf = await downloadDriveFile(item.driveFileId)
          leaseStage = 'building_graph'
          await touchLease()
          leaseStage = 'running_windows'
          await touchLease()
          let result
          try {
            result = await runAnimateItem({
              comfyBaseUrl: session.comfyBaseUrl,
              apiToken: session.comfyApiToken,
              ssh: session.ssh,
              imageBuffer: refBuf,
              imageName: input.referenceImageName,
              videoBuffer: vidBuf,
              videoName: item.name,
              jobId: `${id}_${i}`,
              onHeartbeat: touchLease,
              skipEnsureNodes: true,
            })
          } catch (firstErr) {
            const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr)
            // Node 107 = Sam2Segmentation — re-ensure once then retry this item.
            if (/missing node ids:\s*107|Sam2Segmentation|DWPreprocessor/i.test(firstMsg)) {
              leaseStage = 'ensuring_nodes'
              await touchLease()
              await runAnimateEnsure()
              leaseStage = 'running_windows'
              await touchLease()
              result = await runAnimateItem({
                comfyBaseUrl: session.comfyBaseUrl,
                apiToken: session.comfyApiToken,
                ssh: session.ssh,
                imageBuffer: refBuf,
                imageName: input.referenceImageName,
                videoBuffer: vidBuf,
                videoName: item.name,
                jobId: `${id}_${i}_retry`,
                onHeartbeat: touchLease,
                skipEnsureNodes: true,
              })
            } else {
              throw firstErr
            }
          }
          const ext = result.filename.split('.').pop() ?? 'mp4'
          const uploaded = await uploadToDriveFolderResilient(
            job.user_id,
            input.outputDriveFolderId,
            `${item.name.replace(/\.[^.]+$/, '')}_animate.${ext}`,
            result.buffer,
            'video/mp4',
          )
          rows.push(myPodItemDone(item.name, uploaded.link))
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'failed'
          rows.push(myPodItemError(item.name, msg))
          console.error(`[queue/process] my_pod_animate ${id} item ${i}:`, msg)
        }
        doneCount++
        await query(
          `UPDATE generation_queue
              SET done_items=$1, progress=$2, output=$3::jsonb
            WHERE id=$4 AND status='processing'`,
          [doneCount, Math.round((doneCount / input.items.length) * 100), packMyPodOutput(rows, 'uploading'), id],
        )
      }

      if (remoteJobDir) await cleanupRemoteJobDir(session.ssh, remoteJobDir)
      await query(
        `UPDATE generation_queue SET status='done', finished_at=now(), progress=100 WHERE id=$1 AND status='processing'`,
        [id],
      )
      return NextResponse.json({ ok: true, done: doneCount })
    }

    // ── my_pod_talk (InfiniteTalk + Fish TTS) ──────────────────────────────────
    if (job.job_type === 'my_pod_talk') {
      const input = job.input as unknown as MyPodTalkJobInput
      const session = await getPodSessionSecrets(
        job.user_id,
        job.pod_session_id
          ?? (typeof job.input?.podSessionId === 'string' ? job.input.podSessionId : null),
      )
      if (!session) throw new Error('Pod session expired — reconnect in My Pod')

      const health = await probeComfyHealth(session.comfyBaseUrl, session.comfyApiToken)
      if (!health.ok) throw new Error(`Pod offline — ${health.error}`)

      const fishKey = session.fishApiKey?.trim()
      if (!fishKey) throw new Error('Fish API key missing — reconnect in My Pod → Connection')

      await getUserGoogleAccessToken(job.user_id)

      // Talk is fully remote HTTP (like sheets COMFY_REMOTE=1) — SSH disk check is best-effort.
      let remoteJobDir: string | null = null
      try {
        const d = await ensureRemoteWorkDir(session.ssh, session.remoteWorkRoot, id)
        remoteJobDir = d.remoteJobDir
      } catch (err) {
        console.warn('[my_pod_talk] SSH workdir skipped:', err instanceof Error ? err.message : err)
      }
      const rows: MyPodRow[] = job.output?.myPodRows ? [...job.output.myPodRows] : []
      let doneCount = job.done_items
      let leaseStage = 'running'
      const touchLease = async () => {
        await query(
          `UPDATE generation_queue SET output = $1::jsonb WHERE id=$2`,
          [packMyPodOutput(rows, leaseStage), id],
        )
      }

      // Once per batch: MultiTalkWav2VecEmbeds etc. — auto-install WanVideoWrapper if missing.
      leaseStage = 'ensuring_nodes'
      await touchLease()
      {
        const { ensureTalkNodes } = await import('@/lib/my-pod/ensure-comfy-nodes')
        const ensured = await ensureTalkNodes({
          comfyBaseUrl: session.comfyBaseUrl,
          apiToken: session.comfyApiToken,
          ssh: session.ssh,
          onProgress: async () => { await touchLease() },
        })
        if (!ensured.ok) throw new Error(ensured.error)
        if (ensured.installed.length) {
          console.log(`[my_pod_talk] auto-installed: ${ensured.installed.join(', ')}`)
        }
      }

      for (let i = doneCount; i < input.items.length; i++) {
        if (!(await jobStillRunning(id))) break
        const item = input.items[i]
        try {
          leaseStage = 'downloading_inputs'
          await query(
            `UPDATE generation_queue SET output = $1::jsonb, done_items=$2, progress=$3 WHERE id=$4 AND status='processing'`,
            [packMyPodOutput(rows, leaseStage), doneCount, Math.round((doneCount / input.items.length) * 100), id],
          )
          const imgBuf = await downloadDriveFile(item.driveFileId)

          leaseStage = 'fish_tts'
          await touchLease()
          const speechSource = item.spokenText?.trim() || item.text
          const audioBuf = await fishTts({
            apiKey: fishKey,
            voiceId: input.fishVoiceId,
            text: speechSource,
            style: input.style,
          })

          leaseStage = 'running'
          await touchLease()
          const result = await runTalkItem({
            comfyBaseUrl: session.comfyBaseUrl,
            apiToken: session.comfyApiToken,
            ssh: session.ssh,
            imageBuffer: imgBuf,
            imageName: item.name,
            audioBuffer: audioBuf,
            jobId: `${id}_${i}`,
            onHeartbeat: touchLease,
            skipEnsureNodes: true,
          })
          const ext = result.filename.split('.').pop() ?? 'mp4'
          const uploaded = await uploadToDriveFolderResilient(
            job.user_id,
            input.outputDriveFolderId,
            `${item.name.replace(/\.[^.]+$/, '')}_talk.${ext}`,
            result.buffer,
            ext === 'webm' ? 'video/webm' : 'video/mp4',
          )
          rows.push(myPodItemDone(item.name, uploaded.link))
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'failed'
          rows.push(myPodItemError(item.name, msg))
          console.error(`[queue/process] my_pod_talk ${id} item ${i}:`, msg)
        }
        doneCount++
        await query(
          `UPDATE generation_queue
              SET done_items=$1, progress=$2, output=$3::jsonb
            WHERE id=$4`,
          [doneCount, Math.round((doneCount / input.items.length) * 100), packMyPodOutput(rows, 'uploading'), id],
        )
      }

      if (remoteJobDir) await cleanupRemoteJobDir(session.ssh, remoteJobDir)
      await query(
        `UPDATE generation_queue SET status='done', finished_at=now(), progress=100 WHERE id=$1 AND status='processing'`,
        [id],
      )
      return NextResponse.json({ ok: true, done: doneCount })
    }

    // ── bulk_carousel ─────────────────────────────────────────────────────────
    if (job.job_type === 'bulk_carousel') {
      const { items, variantsExtra, presetId, grokSmart, referenceImageUrls, seedreamOnly, seedreamResolution, seriesLabel } = job.input as unknown as BulkCarouselJobInput
      if (!items?.length) throw new Error('No items in job input')
      // Per-item scene references satisfy seedream-only on their own — see the
      // matching check in queue/submit.
      if (seedreamOnly && !referenceImageUrls?.length && !items.every(it => it.referenceImageUrls?.length)) {
        throw new Error('Seedream-only carousel requires referenceImageUrls')
      }

      const apiKey = await getUserApiKey(job.user_id, 'wavespeed_api_key').catch(() => '')
      const hfToken = await getUserApiKey(job.user_id, 'hf_token').catch(() => '')
      if (!apiKey) {
        await query(
          `UPDATE generation_queue SET status='failed', error=$1, finished_at=now() WHERE id=$2`,
          ['WAVESPEED_API_KEY not configured', id],
        )
        return NextResponse.json({ error: 'Missing API key' }, { status: 500 })
      }

      const carouselRows: CarouselRow[] = job.output?.carouselRows ? [...job.output.carouselRows] : []
      let doneCount = job.done_items

      for (let batchStart = doneCount; batchStart < items.length; batchStart += CAROUSEL_BATCH_SIZE) {
        // A Stop/Delete from the queue UI only flips the row; the worker has to
        // notice it, or the button lies and paid work keeps running.
        if (!(await jobStillRunning(id))) {
          console.log(`[queue/process] bulk_carousel ${id} stopped at ${doneCount}/${items.length}`)
          return NextResponse.json({ ok: true, cancelled: true, done: doneCount })
        }
        const batchEnd = Math.min(batchStart + CAROUSEL_BATCH_SIZE, items.length)
        const batchIndices = Array.from({ length: batchEnd - batchStart }, (_, i) => batchStart + i)

        const results = await Promise.all(batchIndices.map(async (i): Promise<CarouselRow> => {
          const item = items[i]
          try {
            const carouselPreset = presetId ?? DEFAULT_CAROUSEL_PRESET_ID
            const baseGenerationPrompt = buildCarouselBasePrompt(item.prompt, carouselPreset)
            const seedreamRes = seedreamResolution === '2k' ? '2k' : '1k'
            // Scene reference first, character references after it — a scene
            // edit prompt names the images by position ("image 1 is the scene,
            // image 2 is the identity"), so this order is load-bearing. Items
            // with no scene reference send exactly what they always did.
            const itemRefUrls = item.referenceImageUrls?.length
              ? [...item.referenceImageUrls, ...(referenceImageUrls ?? [])]
              : [...(referenceImageUrls ?? [])]

            let baseStoredUrl: string
            if (seedreamOnly) {
              const baseUrls = await editImage({
                imageUrls: itemRefUrls.slice(0, SEEDREAM_MAX_IMAGES),
                prompt: baseGenerationPrompt,
                size: item.dimension,
                resolution: seedreamRes,
                apiKey,
                signal: AbortSignal.timeout(600_000),
              })
              if (!baseUrls.length) throw new Error('No base image returned from Seedream')
              baseStoredUrl = await uploadImageFromUrl(baseUrls[0], `queue/${id}/${i + 1}_base.jpg`)
            } else {
              const baseUrls = await generateImage({
                prompt: baseGenerationPrompt,
                dimension: item.dimension,
                loraUrl: item.loraUrl,
                loraScale: item.loraScale,
                apiKey,
                hfToken,
                signal: AbortSignal.timeout(130_000),
              })
              if (!baseUrls.length) throw new Error('No base image returned')
              baseStoredUrl = await uploadImageFromUrl(baseUrls[0], `queue/${id}/${i + 1}_base.jpg`)
            }

            const images: string[] = [baseStoredUrl]
            const variantPrompts = await resolveCarouselVariantPrompts({
              presetId: carouselPreset,
              count: variantsExtra,
              scenePrompt: baseGenerationPrompt,
              grokSmart: grokSmart ?? false,
              baseImageUrl: baseStoredUrl,
            })

            const variantResults = await Promise.allSettled(
              variantPrompts.map(async (variantPrompt, vi) => {
                const editUrls = await editImage({
                  imageUrls: [
                    baseStoredUrl,
                    // Base slide takes one of Seedream's image slots.
                    ...itemRefUrls.slice(0, SEEDREAM_MAX_IMAGES - 1),
                  ],
                  prompt: variantPrompt,
                  size: item.dimension,
                  resolution: seedreamRes,
                  apiKey,
                  signal: AbortSignal.timeout(600_000),
                })
                if (!editUrls.length) throw new Error('No variant image returned')
                return uploadImageFromUrl(editUrls[0], `queue/${id}/${i + 1}_v${vi + 1}.jpg`)
              }),
            )
            for (const r of variantResults) {
              if (r.status === 'fulfilled') images.push(r.value)
            }

            // bulk_carousel had no automatic Drive archive at all before this --
            // only a manual ZIP download. Each slide gets its own enqueueDriveArchive
            // call (own dedup key) but shares one seriesId + this slide's position,
            // so Drive sorts them in order instead of not having them at all.
            try {
              const { enqueueDriveArchive } = await import('@/lib/drive-archive/enqueue')
              const { seriesFolderName } = await import('@/lib/drive-archive/label')
              const characterKey = item.characterName || item.characterId || null
              const seriesId = `${id}:${i}`
              // One folder per carousel, so slides are never mixed in with
              // everything else archived for this girl that day. Empty when the
              // user gave no name — then nothing changes from before.
              const seriesFolder = seriesFolderName(seriesLabel, i + 1)
              for (let si = 0; si < images.length; si++) {
                await enqueueDriveArchive({
                  userId: job.user_id,
                  sourceType: 'queue_job',
                  sourceId: `${seriesId}:${si}`,
                  urls: [images[si]],
                  characterKey,
                  kind: 'carousels',
                  stage: 'ready',
                  modelKey: 'bulk_carousel',
                  seriesLabel,
                  seriesFolder,
                  seriesId,
                  seriesIndex: si,
                  seriesTotal: images.length,
                })
              }
            } catch (err) {
              console.error(`[queue/process] bulk_carousel ${id} item ${i} drive archive failed:`, err)
            }

            return { prompt: item.prompt, images, status: 'done' }
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'failed'
            console.error(`[queue/process] bulk_carousel ${id} item ${i} failed:`, msg)
            return { prompt: item.prompt, images: [], status: 'error', error: msg }
          }
        }))

        carouselRows.push(...results)
        doneCount = batchEnd
        const progress = Math.round((doneCount / items.length) * 100)
        await query(
          `UPDATE generation_queue
              SET done_items=$1, progress=$2, output=jsonb_build_object('carouselRows', $3::jsonb)
            WHERE id=$4`,
          [doneCount, progress, JSON.stringify(carouselRows), id],
        )
      }

      await query(
        `UPDATE generation_queue SET status='done', finished_at=now(), progress=100 WHERE id=$1`,
        [id],
      )

      return NextResponse.json({ ok: true, done: doneCount })
    }

    // ── copy_paste_v2 ─────────────────────────────────────────────────────────
    if (job.job_type === 'copy_paste_v2') {
      const { itemIds, endFrame, repurposeCount, outputDriveFolderId, customPrompt } = job.input as unknown as CopyPasteJobInput
      if (!itemIds?.length) throw new Error('No items in job input')

      const copyPasteRows: CopyPasteRow[] = job.output?.copyPasteRows ? [...job.output.copyPasteRows] : []
      let doneCount = job.done_items

      for (let batchStart = doneCount; batchStart < itemIds.length; batchStart += COPY_PASTE_BATCH_SIZE) {
        // Each item is minutes of paid model time — stop promptly if cancelled.
        if (!(await jobStillRunning(id))) {
          console.log(`[queue/process] copy_paste_v2 ${id} cancelled at ${doneCount}/${itemIds.length}`)
          return NextResponse.json({ ok: true, cancelled: true, done: doneCount })
        }

        const batchEnd = Math.min(batchStart + COPY_PASTE_BATCH_SIZE, itemIds.length)
        const batchIds = itemIds.slice(batchStart, batchEnd)

        const results = await Promise.all(batchIds.map(async (itemId): Promise<CopyPasteRow> => {
          try {
            const result = await replicateCopyPasteItem(itemId, job.user_id, {
              endFrame,
              repurposeCount,
              outputDriveFolderId,
              customPrompt,
            })
            return { itemId, status: 'done', videoUrl: result.videoUrl }
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'failed'
            console.error(`[queue/process] copy_paste_v2 ${id} item ${itemId} failed:`, msg)
            return { itemId, status: 'error', error: msg }
          }
        }))

        copyPasteRows.push(...results)
        doneCount = batchEnd
        const progress = Math.round((doneCount / itemIds.length) * 100)
        // progressAt is the liveness heartbeat cron uses to tell a slow job from a
        // dead one — a long bulk run must not be requeued while it is still working.
        await query(
          `UPDATE generation_queue
              SET done_items=$1, progress=$2,
                  output=jsonb_build_object('copyPasteRows', $3::jsonb, 'progressAt', $5::text)
            WHERE id=$4`,
          [doneCount, progress, JSON.stringify(copyPasteRows), id, new Date().toISOString()],
        )
      }

      await query(
        `UPDATE generation_queue SET status='done', finished_at=now(), progress=100 WHERE id=$1`,
        [id],
      )

      return NextResponse.json({ ok: true, done: doneCount })
    }

    // ── infinite_talk — still + Fish voice-over → talking clip ─────────────
    if (job.job_type === 'infinite_talk') {
      const { items, voiceId, style, resolution, prompt, folderName } =
        job.input as unknown as InfiniteTalkJobInput
      if (!items?.length) throw new Error('No items in job input')

      const runpodKey = await resolveKey(job.user_id, 'RUNPOD_API_KEY')
      const fishKey = await resolveKey(job.user_id, 'FISH_API_KEY')
      const missing = !runpodKey ? 'RunPod' : !fishKey ? 'Fish Audio' : null
      if (missing) {
        await query(
          `UPDATE generation_queue SET status='failed', error=$1, finished_at=now() WHERE id=$2`,
          [`No ${missing} API key — add it in Settings`, id],
        )
        return NextResponse.json({ error: `Missing ${missing} key` }, { status: 500 })
      }

      const rows: TalkRow[] = job.output?.talkRows ? [...job.output.talkRows] : []
      let doneCount = job.done_items

      for (let start = doneCount; start < items.length; start += TALK_BATCH_SIZE) {
        if (!(await jobStillRunning(id))) {
          console.log(`[queue/process] infinite_talk ${id} cancelled at ${doneCount}/${items.length}`)
          return NextResponse.json({ ok: true, cancelled: true, done: doneCount })
        }

        const end = Math.min(start + TALK_BATCH_SIZE, items.length)
        const batch = Array.from({ length: end - start }, (_, k) => start + k)

        const results = await Promise.all(batch.map(async (i): Promise<TalkRow> => {
          const item = items[i]
          // An uneven batch reaches here as an item missing one half. It is
          // recorded as a failure rather than skipped, so the results show
          // exactly which images or lines had no partner.
          if (!item.imageUrl || !item.text) {
            return {
              imageUrl: item.imageUrl,
              text: item.text,
              status: 'error',
              error: item.imageUrl ? 'No CSV line for this image' : 'No image for this line',
            }
          }

          try {
            const wav = await fishTts({
              apiKey: fishKey!,
              voiceId,
              text: item.text,
              style: style ?? undefined,
            })
            // RunPod fetches the audio by URL, so it has to be hosted first.
            const audioUrl = await uploadBuffer(wav, `queue/${id}/${i + 1}.wav`, 'audio/wav')

            const video = await generateTalkingVideo({
              imageUrl: item.imageUrl,
              audioUrl,
              prompt,
              resolution,
              apiKey: runpodKey!,
            })

            const stored = await uploadImageFromUrl(video.videoUrl, `queue/${id}/${i + 1}.mp4`)

            try {
              const { enqueueDriveArchive } = await import('@/lib/drive-archive/enqueue')
              await enqueueDriveArchive({
                userId: job.user_id,
                sourceType: 'queue_job',
                sourceId: `${id}:${i}`,
                urls: [stored],
                characterKey: folderName,
                kind: 'reels',
                stage: 'ready',
                modelKey: 'infinitetalk',
              })
            } catch (err) {
              console.error(`[queue/process] infinite_talk ${id} item ${i} drive archive failed:`, err)
            }

            return {
              imageUrl: item.imageUrl,
              text: item.text,
              audioUrl,
              videoUrl: stored,
              costUsd: video.costUsd,
              status: 'done',
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'failed'
            console.error(`[queue/process] infinite_talk ${id} item ${i} failed:`, msg)
            return { imageUrl: item.imageUrl, text: item.text, status: 'error', error: msg }
          }
        }))

        rows.push(...results)
        doneCount = end
        await query(
          `UPDATE generation_queue
              SET done_items=$1, progress=$2,
                  output=jsonb_build_object('talkRows', $3::jsonb, 'progressAt', $5::text)
            WHERE id=$4`,
          [
            doneCount,
            Math.round((doneCount / items.length) * 100),
            JSON.stringify(rows),
            id,
            new Date().toISOString(),
          ],
        )
      }

      await query(
        `UPDATE generation_queue SET status='done', finished_at=now(), progress=100 WHERE id=$1`,
        [id],
      )
      const ok = rows.filter(r => r.status === 'done').length
      const spent = rows.reduce((s, r) => s + (r.costUsd ?? 0), 0)
      console.log(`[queue/process] infinite_talk ${id} done — ${ok}/${rows.length} clips, $${spent.toFixed(2)}`)
      return NextResponse.json({ ok: true, done: doneCount })
    }

    // ── seedance_i2v — stills to 9:16 clips on RunPod ──────────────────────
    if (job.job_type === 'seedance_i2v') {
      const { items, duration, resolution, folderName, generateAudio } =
        job.input as unknown as SeedanceI2VJobInput
      if (!items?.length) throw new Error('No items in job input')

      const apiKey = await resolveKey(job.user_id, 'RUNPOD_API_KEY')
      if (!apiKey) {
        await query(
          `UPDATE generation_queue SET status='failed', error=$1, finished_at=now() WHERE id=$2`,
          ['No RunPod API key — add it in Settings', id],
        )
        return NextResponse.json({ error: 'Missing RunPod key' }, { status: 500 })
      }

      const rows: SeedanceRow[] = job.output?.seedanceRows ? [...job.output.seedanceRows] : []
      let doneCount = job.done_items

      for (let start = doneCount; start < items.length; start += SEEDANCE_BATCH_SIZE) {
        // Stop has to bite between batches: a 500-item run is real money, and
        // the row's status is the only signal the worker gets.
        if (!(await jobStillRunning(id))) {
          console.log(`[queue/process] seedance_i2v ${id} cancelled at ${doneCount}/${items.length}`)
          return NextResponse.json({ ok: true, cancelled: true, done: doneCount })
        }

        const end = Math.min(start + SEEDANCE_BATCH_SIZE, items.length)
        const batch = Array.from({ length: end - start }, (_, k) => start + k)

        const results = await Promise.all(batch.map(async (i): Promise<SeedanceRow> => {
          const item = items[i]
          try {
            // One cheap vision call decides the shot type; the motion itself
            // comes from a table, not from the model — see seedance-prompt.ts.
            const composed = await promptForImage(item.imageUrl)

            const video = await generateSeedanceVideo({
              imageUrl: item.imageUrl,
              prompt: composed.prompt,
              duration,
              resolution,
              cameraFixed: composed.cameraFixed,
              generateAudio: generateAudio ?? false,
              apiKey,
            })

            // RunPod hands back a CDN URL of unknown lifetime, so the file is
            // pulled into our own storage before anything else points at it.
            const stored = await uploadImageFromUrl(
              video.videoUrl,
              `queue/${id}/${i + 1}.mp4`,
            )

            try {
              const { enqueueDriveArchive } = await import('@/lib/drive-archive/enqueue')
              await enqueueDriveArchive({
                userId: job.user_id,
                sourceType: 'queue_job',
                sourceId: `${id}:${i}`,
                urls: [stored],
                characterKey: folderName,
                kind: 'reels',
                stage: 'ready',
                modelKey: 'seedance-i2v',
              })
            } catch (err) {
              console.error(`[queue/process] seedance_i2v ${id} item ${i} drive archive failed:`, err)
            }

            return {
              imageUrl: item.imageUrl,
              prompt: composed.prompt,
              shotType: composed.shotType,
              videoUrl: stored,
              costUsd: video.costUsd,
              status: 'done',
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'failed'
            console.error(`[queue/process] seedance_i2v ${id} item ${i} failed:`, msg)
            return { imageUrl: item.imageUrl, status: 'error', error: msg }
          }
        }))

        rows.push(...results)
        doneCount = end
        await query(
          `UPDATE generation_queue
              SET done_items=$1, progress=$2,
                  output=jsonb_build_object('seedanceRows', $3::jsonb, 'progressAt', $5::text)
            WHERE id=$4`,
          [
            doneCount,
            Math.round((doneCount / items.length) * 100),
            JSON.stringify(rows),
            id,
            new Date().toISOString(),
          ],
        )
      }

      await query(
        `UPDATE generation_queue SET status='done', finished_at=now(), progress=100 WHERE id=$1`,
        [id],
      )
      const spent = rows.reduce((s, r) => s + (r.costUsd ?? 0), 0)
      console.log(`[queue/process] seedance_i2v ${id} done — ${rows.length} clips, $${spent.toFixed(2)}`)
      return NextResponse.json({ ok: true, done: doneCount })
    }

    // ── copy_prompts_generate ───────────────────────────────────────────────
    if (job.job_type === 'copy_prompts_generate') {
      const {
        items, mode, loraUrl, loraScale, referenceImageUrls, dimension,
        folderName, carousel, seedreamResolution, contentFormat,
      } = job.input as unknown as CopyPromptsJobInput
      if (!items?.length) throw new Error('No items in job input')

      const apiKey = await getUserApiKey(job.user_id, 'wavespeed_api_key').catch(() => '')
      const hfToken = await getUserApiKey(job.user_id, 'hf_token').catch(() => '')
      if (!apiKey) {
        await query(
          `UPDATE generation_queue SET status='failed', error=$1, finished_at=now() WHERE id=$2`,
          ['WAVESPEED_API_KEY not configured', id],
        )
        return NextResponse.json({ error: 'Missing API key' }, { status: 500 })
      }

      const copyPromptsRows: CopyPromptsRow[] = job.output?.copyPromptsRows ? [...job.output.copyPromptsRows] : []
      let doneCount = job.done_items

      for (let batchStart = doneCount; batchStart < items.length; batchStart += COPY_PROMPTS_BATCH_SIZE) {
        // Every item is paid Seedream time, so Stop has to take effect between
        // batches rather than only flipping the row's status while the worker
        // keeps spending. Work already finished stays in output.
        if (!(await jobStillRunning(id))) {
          console.log(`[queue/process] copy_prompts_generate ${id} cancelled at ${doneCount}/${items.length}`)
          return NextResponse.json({ ok: true, cancelled: true, done: doneCount })
        }

        const batchEnd = Math.min(batchStart + COPY_PROMPTS_BATCH_SIZE, items.length)
        const batchIndices = Array.from({ length: batchEnd - batchStart }, (_, i) => batchStart + i)

        const results = await Promise.all(batchIndices.map(async (i): Promise<CopyPromptsRow> => {
          const item = items[i]
          try {
            const seedreamRes = seedreamResolution === '2k' ? '2k' : '1k'
            // Scene reference first, character references after it — a scene
            // edit prompt names the images by position ("image 1 is the scene,
            // image 2 is the identity"), so this order is load-bearing.
            // Items with no scene reference send exactly what they always did.
            const itemRefUrls = item.referenceImageUrls?.length
              ? [...item.referenceImageUrls, ...(referenceImageUrls ?? [])]
              : [...(referenceImageUrls ?? [])]

            let baseStoredUrl: string
            if (mode === 'seedream-edit') {
              const baseUrls = await editImage({
                imageUrls: itemRefUrls.slice(0, SEEDREAM_MAX_IMAGES),
                prompt: item.prompt,
                size: dimension,
                resolution: seedreamRes,
                apiKey,
                signal: AbortSignal.timeout(600_000),
              })
              if (!baseUrls.length) throw new Error('No base image returned from Seedream')
              baseStoredUrl = await uploadImageFromUrl(baseUrls[0], `queue/${id}/${i + 1}_base.jpg`)
            } else {
              const baseUrls = await generateImage({
                prompt: item.prompt,
                dimension,
                loraUrl,
                loraScale,
                apiKey,
                hfToken,
                signal: AbortSignal.timeout(130_000),
              })
              if (!baseUrls.length) throw new Error('No base image returned')
              baseStoredUrl = await uploadImageFromUrl(baseUrls[0], `queue/${id}/${i + 1}_base.jpg`)
            }

            const images: string[] = [baseStoredUrl]
            // Recorded alongside the images so the batch view can show which
            // prompt produced which slide. Carousel variants come from a preset
            // or from Grok, so without this the only prompt anyone could see
            // was the base one — and the variants are what actually differ.
            const usedVariantPrompts: string[] = []
            if (carousel?.enabled) {
              const variantPrompts = await resolveCarouselVariantPrompts({
                presetId: carousel.presetId,
                count: carousel.count,
                scenePrompt: item.prompt,
                grokSmart: carousel.grokSmart ?? false,
                baseImageUrl: baseStoredUrl,
              })

              const variantResults = await Promise.allSettled(
                variantPrompts.map(async (variantPrompt, vi) => {
                  const editUrls = await editImage({
                    imageUrls: [
                      baseStoredUrl,
                      ...itemRefUrls.slice(0, SEEDREAM_MAX_IMAGES - 1),
                    ],
                    prompt: variantPrompt,
                    size: dimension,
                    resolution: seedreamRes,
                    apiKey,
                    signal: AbortSignal.timeout(600_000),
                  })
                  if (!editUrls.length) throw new Error('No variant image returned')
                  return uploadImageFromUrl(editUrls[0], `queue/${id}/${i + 1}_v${vi + 1}.jpg`)
                }),
              )
              // Kept index-aligned with the images actually produced: a failed
              // variant contributes neither an image nor a prompt, so slide N
              // in the grid always maps to prompt N here.
              variantResults.forEach((r, vi) => {
                if (r.status === 'fulfilled') {
                  images.push(r.value)
                  usedVariantPrompts.push(variantPrompts[vi])
                }
              })
            }

            try {
              const { enqueueDriveArchive } = await import('@/lib/drive-archive/enqueue')
              // The form's publish format wins when it was sent; jobs queued
              // before that field existed keep the old carousel-or-stories rule.
              const kind = contentFormat ?? (carousel?.enabled ? 'carousels' : 'stories')
              const seriesId = `${id}:${i}`
              for (let si = 0; si < images.length; si++) {
                await enqueueDriveArchive({
                  userId: job.user_id,
                  sourceType: 'queue_job',
                  sourceId: `${seriesId}:${si}`,
                  urls: [images[si]],
                  characterKey: folderName,
                  kind,
                  stage: 'ready',
                  modelKey: 'copy_prompts_generate',
                  seriesId,
                  seriesIndex: si,
                  seriesTotal: images.length,
                })
              }
            } catch (err) {
              console.error(`[queue/process] copy_prompts_generate ${id} item ${i} drive archive failed:`, err)
            }

            return {
              promptId: item.promptId,
              prompt: item.prompt,
              variantPrompts: usedVariantPrompts,
              referenceImageUrls: itemRefUrls,
              images,
              status: 'done',
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'failed'
            console.error(`[queue/process] copy_prompts_generate ${id} item ${i} failed:`, msg)
            return { promptId: item.promptId, prompt: item.prompt, images: [], status: 'error', error: msg }
          }
        }))

        copyPromptsRows.push(...results)
        doneCount = batchEnd
        const progress = Math.round((doneCount / items.length) * 100)
        // progressAt is the liveness heartbeat cron uses to tell a slow batch
        // from a dead worker. Without it a long run trips the blunt 30-minute
        // reset, burns its three attempts, and then sits in 'processing' with
        // nothing left to requeue it.
        await query(
          `UPDATE generation_queue
              SET done_items=$1, progress=$2,
                  output=jsonb_build_object('copyPromptsRows', $3::jsonb, 'progressAt', $5::text)
            WHERE id=$4`,
          [doneCount, progress, JSON.stringify(copyPromptsRows), id, new Date().toISOString()],
        )
      }

      await query(
        `UPDATE generation_queue SET status='done', finished_at=now(), progress=100 WHERE id=$1`,
        [id],
      )

      return NextResponse.json({ ok: true, done: doneCount })
    }

    // Unknown job type
    await query(
      `UPDATE generation_queue SET status='failed', error=$1, finished_at=now() WHERE id=$2`,
      [`Unknown job_type: ${job.job_type}`, id],
    )
    return NextResponse.json({ error: 'Unknown job type' }, { status: 400 })

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error'
    console.error(`[queue/process] job ${id} fatal error:`, errMsg)

    if (job.attempts >= job.max_attempts) {
      await query(
        `UPDATE generation_queue SET status='failed', error=$1, finished_at=now() WHERE id=$2`,
        [errMsg, id],
      )
      // Same archiveToDrive gate as the success path: only jobs the bot itself
      // queued (folder command / "Repurpose ×N" button) get a Telegram push.
      const repurposeInput = job.input as { videoName?: string; archiveToDrive?: boolean } | undefined
      if (job.job_type === 'video_repurpose' && repurposeInput?.archiveToDrive) {
        const { notifyRepurposeFailed } = await import('@/lib/monitor/notify')
        await notifyRepurposeFailed(job.user_id, errMsg, repurposeInput.videoName).catch(() => {})
      }
    } else {
      await query(
        `UPDATE generation_queue SET status='pending', error=$1 WHERE id=$2`,
        [errMsg, id],
      )
    }

    return NextResponse.json({ error: errMsg }, { status: 500 })
  }
}
