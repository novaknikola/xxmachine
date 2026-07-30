import { NextRequest, NextResponse } from 'next/server'
import { one, query } from '@/lib/db'
import { generateImage, editImage, SEEDREAM_MAX_IMAGES } from '@/lib/wavespeed'
import { resolveCarouselVariantPrompts } from '@/lib/carousel-variants'
import { buildCarouselBasePrompt, DEFAULT_CAROUSEL_PRESET_ID } from '@/lib/carousel-presets'
import { uploadImageFromUrl, uploadBuffer } from '@/lib/supabase-storage'
import { processVideoVariant, getVideoDuration, getVideoDimensions } from '@/lib/video-ffmpeg'
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
  BulkImageJobItem, VideoRepurposeJobInput, VideoCaptionJobInput, VideoCaptionItem,
  VideoTranscribeJobInput, VideoOcrJobInput, CaptionShuffleJobInput, CaptionGenerateJobInput, ComfyUIPodBulkJobInput,
  BulkCarouselJobInput, MyPodI2vJobInput, MyPodAnimateJobInput, MyPodTalkJobInput,
} from '../../submit/route'
import { getPodSessionSecrets } from '@/lib/my-pod/session'
import { ensureRemoteWorkDir, cleanupRemoteJobDir } from '@/lib/my-pod/ssh'
import {
  uploadImageToComfy, submitComfyPrompt, pollComfyResult, downloadFromComfy, probeComfyHealth,
} from '@/lib/my-pod/comfy'
import { runI2vItem, runAnimateItem, runTalkItem } from '@/lib/my-pod/runners'
import { fishTts } from '@/lib/my-pod/fish-tts'
import {
  processMultiShotJob,
  type MonitorMultiShotJobInput,
  type MonitorMultiShotJobOutput,
} from '@/lib/monitor/multi-shot'

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
}

interface CarouselRow {
  prompt: string
  images: string[]
  status: 'done' | 'error'
  error?: string
}

const execFileAsync = promisify(execFile)
const CRON_SECRET = process.env.CRON_SECRET
const VIDEO_BATCH_SIZE = 3
const GENERATE_BATCH_SIZE = 20
const EXAMPLE_SAMPLE_SIZE = 25
const CAROUSEL_BATCH_SIZE = 2

/** Lease heartbeat so cron can requeue zombie My Pod workers after deploy/crash. */
function packMyPodOutput(rows: MyPodRow[], stage: string) {
  return JSON.stringify({
    myPodRows: rows,
    stage,
    progressAt: new Date().toISOString(),
  })
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
  } & MonitorMultiShotJobOutput | null
  attempts: number
  max_attempts: number
  done_items: number
  total_items: number
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
    `SELECT id, user_id, status, job_type, input, output, attempts, max_attempts, done_items, total_items
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
      const apiKey = process.env.WAVESPEED_API_KEY ?? ''
      const hfToken = process.env.HF_TOKEN ?? ''

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
      const { videoUrl, count, baseSeed, effects } = job.input as unknown as VideoRepurposeJobInput
      let doneCount = job.done_items

      // Resume: load existing output URLs from DB
      const allOutputUrls: (string | null)[] = new Array(count).fill(null)
      const existingUrls = job.output?.urls ?? []
      for (let i = 0; i < Math.min(existingUrls.length, count); i++) {
        allOutputUrls[i] = existingUrls[i]
      }

      // Download source video to temp file
      const videoRes = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) })
      if (!videoRes.ok) throw new Error(`Failed to download source video: ${videoRes.status}`)
      const videoBuffer = await videoRes.arrayBuffer()
      const inputPath = join(tmpdir(), `vr_in_${randomUUID()}.mp4`)
      writeFileSync(inputPath, Buffer.from(videoBuffer))

      const fadeDuration = effects.fade ? (await getVideoDuration(inputPath) ?? undefined) : undefined

      try {
        for (let batchStart = doneCount; batchStart < count; batchStart += VIDEO_BATCH_SIZE) {
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

      const hfToken = process.env.HF_TOKEN ?? ''
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

      const hfToken = process.env.HF_TOKEN ?? ''
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

      const session = await getPodSessionSecrets(job.user_id)
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
      const session = await getPodSessionSecrets(job.user_id)
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
        const item = input.items[i]
        try {
          leaseStage = 'downloading_inputs'
          await query(
            `UPDATE generation_queue SET output = $1::jsonb, done_items=$2, progress=$3 WHERE id=$4`,
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
          rows.push({ label: item.name, status: 'done', stage: 'done', driveLink: uploaded.link })
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'failed'
          rows.push({ label: item.name, status: 'error', stage: 'error', error: msg })
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
      await query(`UPDATE generation_queue SET status='done', finished_at=now(), progress=100 WHERE id=$1`, [id])
      return NextResponse.json({ ok: true, done: doneCount })
    }

    // ── my_pod_animate ─────────────────────────────────────────────────────────
    if (job.job_type === 'my_pod_animate') {
      const input = job.input as unknown as MyPodAnimateJobInput
      const session = await getPodSessionSecrets(job.user_id)
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

      for (let i = doneCount; i < input.items.length; i++) {
        const item = input.items[i]
        try {
          leaseStage = 'downloading_inputs'
          await touchLease()
          const vidBuf = await downloadDriveFile(item.driveFileId)
          leaseStage = 'building_graph'
          await touchLease()
          leaseStage = 'running_windows'
          await touchLease()
          const result = await runAnimateItem({
            comfyBaseUrl: session.comfyBaseUrl,
            apiToken: session.comfyApiToken,
            ssh: session.ssh,
            imageBuffer: refBuf,
            imageName: input.referenceImageName,
            videoBuffer: vidBuf,
            videoName: item.name,
            jobId: `${id}_${i}`,
            onHeartbeat: touchLease,
          })
          const ext = result.filename.split('.').pop() ?? 'mp4'
          const uploaded = await uploadToDriveFolderResilient(
            job.user_id,
            input.outputDriveFolderId,
            `${item.name.replace(/\.[^.]+$/, '')}_animate.${ext}`,
            result.buffer,
            'video/mp4',
          )
          rows.push({ label: item.name, status: 'done', stage: 'done', driveLink: uploaded.link })
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'failed'
          rows.push({ label: item.name, status: 'error', stage: 'error', error: msg })
          console.error(`[queue/process] my_pod_animate ${id} item ${i}:`, msg)
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
      await query(`UPDATE generation_queue SET status='done', finished_at=now(), progress=100 WHERE id=$1`, [id])
      return NextResponse.json({ ok: true, done: doneCount })
    }

    // ── my_pod_talk (InfiniteTalk + Fish TTS) ──────────────────────────────────
    if (job.job_type === 'my_pod_talk') {
      const input = job.input as unknown as MyPodTalkJobInput
      const session = await getPodSessionSecrets(job.user_id)
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

      for (let i = doneCount; i < input.items.length; i++) {
        const item = input.items[i]
        try {
          leaseStage = 'downloading_inputs'
          await query(
            `UPDATE generation_queue SET output = $1::jsonb, done_items=$2, progress=$3 WHERE id=$4`,
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
          })
          const ext = result.filename.split('.').pop() ?? 'mp4'
          const uploaded = await uploadToDriveFolderResilient(
            job.user_id,
            input.outputDriveFolderId,
            `${item.name.replace(/\.[^.]+$/, '')}_talk.${ext}`,
            result.buffer,
            ext === 'webm' ? 'video/webm' : 'video/mp4',
          )
          rows.push({ label: item.name, status: 'done', stage: 'done', driveLink: uploaded.link })
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'failed'
          rows.push({ label: item.name, status: 'error', stage: 'error', error: msg })
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
      await query(`UPDATE generation_queue SET status='done', finished_at=now(), progress=100 WHERE id=$1`, [id])
      return NextResponse.json({ ok: true, done: doneCount })
    }

    // ── bulk_carousel ─────────────────────────────────────────────────────────
    if (job.job_type === 'bulk_carousel') {
      const { items, variantsExtra, presetId, grokSmart, referenceImageUrls, seedreamOnly, seedreamResolution } = job.input as unknown as BulkCarouselJobInput
      if (!items?.length) throw new Error('No items in job input')
      if (seedreamOnly && !referenceImageUrls?.length) {
        throw new Error('Seedream-only carousel requires referenceImageUrls')
      }

      const apiKey = process.env.WAVESPEED_API_KEY ?? ''
      const hfToken = process.env.HF_TOKEN ?? ''
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
        const batchEnd = Math.min(batchStart + CAROUSEL_BATCH_SIZE, items.length)
        const batchIndices = Array.from({ length: batchEnd - batchStart }, (_, i) => batchStart + i)

        const results = await Promise.all(batchIndices.map(async (i): Promise<CarouselRow> => {
          const item = items[i]
          try {
            const carouselPreset = presetId ?? DEFAULT_CAROUSEL_PRESET_ID
            const baseGenerationPrompt = buildCarouselBasePrompt(item.prompt, carouselPreset)
            const seedreamRes = seedreamResolution === '2k' ? '2k' : '1k'

            let baseStoredUrl: string
            if (seedreamOnly) {
              const baseUrls = await editImage({
                imageUrls: referenceImageUrls!,
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
                    ...(referenceImageUrls ?? []).slice(0, SEEDREAM_MAX_IMAGES - 1),
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

    // ── monitor_multi_shot ────────────────────────────────────────────────────
    if (job.job_type === 'monitor_multi_shot') {
      const input = job.input as unknown as MonitorMultiShotJobInput
      if (!input?.discoveryItemId || !input.imageUrl || !input.sourceVideoUrl) {
        throw new Error('Invalid monitor_multi_shot input')
      }
      const result = await processMultiShotJob({
        jobId: id,
        userId: job.user_id,
        input,
        doneItems: job.done_items,
        existingOutput: job.output,
      })
      return NextResponse.json({ ok: true, done: result.done, finalUrl: result.finalUrl })
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
    } else {
      await query(
        `UPDATE generation_queue SET status='pending', error=$1 WHERE id=$2`,
        [errMsg, id],
      )
    }

    return NextResponse.json({ error: errMsg }, { status: 500 })
  }
}
