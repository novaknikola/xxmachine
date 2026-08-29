import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { one } from '@/lib/db'
import { listDriveFiles, listDriveImages } from '@/lib/google-drive'
import { getUserGoogleAccessToken } from '@/lib/drive-archive/user-google-auth'
import { sanitizeArchiveLabel } from '@/lib/drive-archive/label'
import type { VideoEffectOpts } from '@/lib/video-ffmpeg'
import type { ReproduceSettings } from '@/app/(dashboard)/repurpose/reproduce-logic'
import type { CaptionStyle, CaptionCustomStyle } from '@/lib/captions'
import { dedupeCaptions } from '@/lib/caption-shuffle'
import { SEEDREAM_MAX_IMAGES } from '@/lib/wavespeed'
import { maxItemsForJob, MAX_SEEDREAM_SLIDES_PER_JOB } from '@/lib/queue-limits'
import { normalizeContentFormat, type ContentFormat } from '@/lib/drive-archive/content-format'

export interface BulkImageJobItem {
  prompt: string
  dimension: string
  loraUrl?: string | null
  loraScale?: number
  characterId?: string
  characterName?: string
  /**
   * Per-item Seedream reference URLs — one scene/composition reference for this
   * carousel alone (e.g. a pasted Pinterest pin). Job-level referenceImageUrls
   * stay shared across items and are sent first, so the character keeps the
   * primary image slot and items without their own refs behave as before.
   */
  referenceImageUrls?: string[]
}

export interface SeedanceI2VItem {
  /** Publicly reachable still — RunPod fetches it directly, nothing is uploaded. */
  imageUrl: string
  /** Where it came from (upload / drive / history), carried through for the results view. */
  source?: string | null
}

export interface SeedanceI2VJobInput {
  items: SeedanceI2VItem[]
  /** Clip length and resolution are per batch, not per image. */
  duration: number
  resolution: '480p' | '720p'
  /** Drive folder these land in. */
  folderName: string
  generateAudio?: boolean
}

export interface InfiniteTalkItem {
  /** Still for this clip. Null when there were more lines than images. */
  imageUrl: string | null
  /** Line the voice speaks. Null when there were more images than lines. */
  text: string | null
  source?: string | null
}

export interface InfiniteTalkJobInput {
  /**
   * Images and CSV lines zipped by position. Anything left over on either side
   * is still an item, with the missing half null — the worker records it as a
   * failure so an uneven batch is visible in the results rather than silently
   * dropped.
   */
  items: InfiniteTalkItem[]
  /** Fish Audio voice, one per batch. */
  voiceId: string
  /** Optional delivery hint prepended to every line before TTS. */
  style?: string | null
  resolution: '480p' | '720p'
  /** Scene direction for the renderer; the audio drives the performance. */
  prompt: string
  folderName: string
}

export interface CopyPasteJobInput {
  itemIds: string[]
  /** Pin the clip's end with a matching second keyframe. Default 'auto'. */
  endFrame?: 'auto' | 'always' | 'off'
  /** Fan each finished video out into N repurposed variants. 0 = off. */
  repurposeCount?: number
  /** Where repurpose variants land. Empty = the computed archive tree. */
  outputDriveFolderId?: string | null
  /** Appended to the end of every item's rendered prompt. */
  customPrompt?: string | null
}

export interface CopyPromptsJobItem {
  /**
   * Provenance — links a result back to its source card. A scraped_prompts.id
   * for library prompts, a pinterest_pins.id when the batch came from a board.
   * Carried through to the output row, not a foreign key.
   */
  promptId: string
  /**
   * This item's own Seedream reference — the pin it was built from. Sent
   * *before* the job-level referenceImageUrls (the character), because a scene
   * edit prompt names the images by position: image 1 is the scene, image 2 is
   * the identity. Items without one are unaffected.
   */
  referenceImageUrls?: string[]
  /** Fully composed final prompt text (style prefix + trigger word already applied client-side). */
  prompt: string
}

export interface CopyPromptsJobInput {
  items: CopyPromptsJobItem[]
  mode: 'turbo-lora' | 'seedream-edit'
  loraUrl?: string | null
  loraScale?: number
  /** Required for mode === 'seedream-edit' — the character's reference photo(s). */
  referenceImageUrls?: string[]
  dimension: string
  /** User-typed Drive folder name — passed through as characterKey, unsanitized. */
  folderName: string
  /**
   * Publish destination picked in the form → which folder the Drive archive
   * files this under. Omitted by older callers, which keep the previous
   * carousel-or-stories behaviour.
   */
  contentFormat?: ContentFormat
  characterId?: string | null
  characterName?: string | null
  carousel?: {
    enabled: boolean
    count: 1 | 2 | 3 | 4
    /** User-written pose-change prompt, edited against the base (first generated) image. */
    posePrompt: string
  }
  seedreamResolution?: '1k' | '2k'
}

export interface BulkCarouselJobInput {
  items: BulkImageJobItem[]
  variantsExtra: 1 | 2 | 3 | 4
  /**
   * User-chosen base name for the whole batch. Sanitised once at submit so the
   * Drive filename and the ZIP can never disagree about what it was. Empty
   * keeps the machine-generated names.
   */
  seriesLabel?: string
  presetId?: string
  grokSmart?: boolean
  /** Extra Seedream reference URLs (base image is generated per item). */
  referenceImageUrls?: string[]
  /** Skip Z-image — base slide is Seedream edit from referenceImageUrls only. */
  seedreamOnly?: boolean
  /** Seedream edit output resolution — default 1k. */
  seedreamResolution?: '1k' | '2k'
}

export interface VideoRepurposeJobInput {
  /** Empty when the source is a Drive file — see driveFileId. */
  videoUrl: string
  videoName: string
  count: number
  baseSeed: number
  effects: VideoEffectOpts
  /**
   * Opt-in so the existing Repurpose page keeps behaving exactly as before.
   * Set by the Copy-Paste chain, which does want its variants in Drive.
   */
  archiveToDrive?: boolean
  /** Drive folder to file under when archiving — the source profile label. */
  characterKey?: string | null
  /** Base file name; the Copy-Paste chain derives it from the source reel. */
  seriesLabel?: string | null
  /** Source lives in Drive rather than storage; downloaded with the platform token. */
  driveFileId?: string | null
  /**
   * Override destination. Empty keeps the computed
   * {character}/{kind}/{stage}/{date} archive tree, which is what keeps
   * everything sorted — this only exists for "put these right here" runs.
   */
  outputDriveFolderId?: string | null
}

export interface ImageRepurposeJobInput {
  /** Empty when the source is a Drive file — see driveFileId. */
  imageUrl: string
  imageName: string
  count: number
  baseSeed: number
  settings: ReproduceSettings
  /** Source lives in Drive rather than storage; downloaded with the platform token. */
  driveFileId?: string | null
  /** Optional — empty means results only land in the results grid (storage URLs), not Drive. */
  outputDriveFolderId?: string | null
}

export interface VideoCaptionItem {
  videoUrl: string
  videoName: string
  text?: string   // present = manually-authored captions, split by line; absent = auto-transcribe
}

export interface VideoCaptionJobInput {
  items: VideoCaptionItem[]
  style: CaptionStyle
  customStyle?: CaptionCustomStyle
  maxWords?: number
  maxDuration?: number
  textMode?: 'sequential' | 'static'   // how manually-supplied item.text is timed; default 'sequential'
}

export interface VideoTranscribeItem {
  videoUrl: string
  videoName: string
}

export interface VideoTranscribeJobInput {
  items: VideoTranscribeItem[]
}

export interface VideoOcrItem {
  videoUrl: string
  videoName: string
}

export interface VideoOcrJobInput {
  items: VideoOcrItem[]
}

export interface CaptionShuffleJobInput {
  texts: string[]
  strength: 'light' | 'medium' | 'heavy'
}

export interface CaptionGenerateJobInput {
  examples: string[]
  count: number
  hint?: string
}

export interface ComfyUIPodBulkItem {
  prompt: string
  driveFileId?: string
}

export interface ComfyUIPodBulkJobInput {
  podUrl: string
  templateId: string
  outputDriveFolderId: string
  items: ComfyUIPodBulkItem[]
}

export interface MyPodI2vJobInput {
  inputDriveFolderId: string
  outputDriveFolderId: string
  prompt?: string
  podSessionId?: string
  items: { driveFileId: string; name: string; prompt?: string }[]
}

export interface MyPodAnimateJobInput {
  inputDriveFolderId: string
  outputDriveFolderId: string
  referenceImageId: string
  referenceImageName: string
  podSessionId?: string
  items: { driveFileId: string; name: string }[]
}

export interface MyPodTalkJobInput {
  inputDriveFolderId: string
  outputDriveFolderId: string
  fishVoiceId: string
  style?: string
  podSessionId?: string
  items: {
    driveFileId: string
    name: string
    text: string
    spokenText?: string
  }[]
}

const MAX_CAPTION_ITEMS = 200
const MAX_TRANSCRIBE_ITEMS = 200
const MAX_OCR_ITEMS = 200
const MAX_SHUFFLE_ITEMS = 5000
const MAX_GENERATE_COUNT = 5000
const MAX_GENERATE_EXAMPLES = 2000
const MAX_CAROUSEL_ITEMS = 25

/**
 * Videos per Image-to-Video batch. High on purpose: the render runs on RunPod's
 * GPUs, not on this box, so a long batch costs wall clock and money rather than
 * local resources. The job resumes from done_items and can be stopped, so the
 * ceiling only exists to bound one mis-click.
 */
const MAX_SEEDANCE_ITEMS = 500

/**
 * Uploads need the user's Google OAuth (service account has no My Drive quota).
 * List/download keep using the platform service account (folders shared with SA).
 */
async function requireUserDriveUploadToken(userId: string): Promise<string | NextResponse> {
  try {
    return await getUserGoogleAccessToken(userId)
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error
          ? err.message
          : 'Google Drive not connected — connect in Settings → Drive archive',
      },
      { status: 400 },
    )
  }
}

/**
 * Claim a just-inserted pending job and fire its worker over loopback right
 * away, instead of leaving it for the once-a-minute cron sweep — same pattern
 * copy_paste_v2 and copy_prompts_generate already use. Loopback on purpose:
 * going through the public URL would put nginx's proxy_read_timeout between
 * us and a job that can run for minutes. Fire-and-forget; the atomic
 * pending→processing claim means a racing cron tick just no-ops.
 */
async function fireQueueWorkerNow(jobId: string): Promise<void> {
  const secret = process.env.CRON_SECRET
  if (!secret) return
  const claimed = await one<{ id: string }>(
    `UPDATE generation_queue
        SET status = 'processing', started_at = now(), attempts = attempts + 1
      WHERE id = $1 AND status = 'pending'
      RETURNING id`,
    [jobId],
  ).catch(() => null)
  if (!claimed) return
  const internalBase = `http://127.0.0.1:${process.env.PORT ?? 3000}`
  fetch(`${internalBase}/api/queue/process/${jobId}`, {
    method: 'POST',
    headers: { 'x-cron-secret': secret },
  }).catch(err => console.error(`[queue/submit] fire worker ${jobId}:`, err))
}

// Only RunPod's own HTTP proxy domain is accepted — hard SSRF guard, no exceptions.
const RUNPOD_POD_URL_RE = /^https:\/\/[a-z0-9-]+-\d+\.proxy\.runpod\.net\/?$/i

export type QueueSubmitBody =
  | { job_type: 'bulk_image'; input: { jobs: BulkImageJobItem[] } }
  // inputDriveFolderId is submit-only — it fans out into one job per video and
  // is never stored on the job itself.
  | {
      job_type: 'video_repurpose'
      input: VideoRepurposeJobInput & { inputDriveFolderId?: string | null }
    }
  | {
      job_type: 'image_repurpose'
      input: ImageRepurposeJobInput & { inputDriveFolderId?: string | null }
    }
  | { job_type: 'video_caption'; input: VideoCaptionJobInput }
  | { job_type: 'video_transcribe'; input: VideoTranscribeJobInput }
  | { job_type: 'video_ocr'; input: VideoOcrJobInput }
  | { job_type: 'caption_shuffle'; input: CaptionShuffleJobInput }
  | { job_type: 'caption_generate'; input: CaptionGenerateJobInput }
  | {
      job_type: 'comfyui_pod_bulk'
      input: {
        podUrl?: string
        usePodSession?: boolean
        podSessionId?: string
        templateId: string
        inputDriveFolderId?: string
        outputDriveFolderId: string
        prompts: string[]
      }
    }
  | {
      job_type: 'my_pod_i2v'
      input: { inputDriveFolderId: string; outputDriveFolderId: string; prompt?: string; podSessionId?: string }
    }
  | {
      job_type: 'my_pod_animate'
      input: { inputDriveFolderId: string; outputDriveFolderId: string; podSessionId?: string }
    }
  | {
      job_type: 'my_pod_talk'
      input: {
        inputDriveFolderId: string
        outputDriveFolderId: string
        fishVoiceId: string
        style?: string
        podSessionId?: string
        /** One caption/script per line; paired with images (cycled if counts differ). */
        texts: string[]
        /** Optional spoken overrides (1 per line); blank line = use Text. */
        spokenTexts?: string[]
      }
    }
  | { job_type: 'bulk_carousel'; input: BulkCarouselJobInput }
  | { job_type: 'copy_paste_v2'; input: CopyPasteJobInput }
  | { job_type: 'copy_prompts_generate'; input: CopyPromptsJobInput }
  | { job_type: 'seedance_i2v'; input: SeedanceI2VJobInput }
  | { job_type: 'infinite_talk'; input: InfiniteTalkJobInput }

export async function POST(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const body = await req.json() as QueueSubmitBody

  if (body.job_type === 'bulk_image') {
    const jobItems = body.input?.jobs
    if (!Array.isArray(jobItems) || jobItems.length === 0) {
      return NextResponse.json({ error: 'No jobs provided' }, { status: 400 })
    }
    if (jobItems.length > 500) {
      return NextResponse.json({ error: 'Max 500 items per submission' }, { status: 400 })
    }

    const row = await one<{ id: string }>(
      `INSERT INTO generation_queue (user_id, job_type, input, total_items)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [user.id, body.job_type, JSON.stringify(body.input), jobItems.length],
    )
    return NextResponse.json({ id: row!.id })
  }

  if (body.job_type === 'video_repurpose') {
    const {
      videoUrl, videoName, count, baseSeed, effects, archiveToDrive, characterKey,
      inputDriveFolderId, outputDriveFolderId, seriesLabel,
    } = body.input ?? {}
    const inputFolder = String(inputDriveFolderId ?? '').trim()
    const outputFolder = String(outputDriveFolderId ?? '').trim()

    if (!inputFolder && (!videoUrl || typeof videoUrl !== 'string')) {
      return NextResponse.json(
        { error: 'videoUrl or inputDriveFolderId required' },
        { status: 400 },
      )
    }
    if (!count || count < 1 || count > 100) {
      return NextResponse.json({ error: 'count must be 1–100' }, { status: 400 })
    }
    // Writing needs the user's own OAuth — the service account has no My Drive
    // quota. Fail here rather than after the variants have been rendered.
    if (outputFolder) {
      const driveUploadOk = await requireUserDriveUploadToken(user.id)
      if (driveUploadOk instanceof NextResponse) return driveUploadOk
    }

    const effectsInput = effects ?? {
      brightness: true, contrast: true, saturation: true,
      hue: false, speed: false, flipH: false, crop: true, fade: false,
    }

    // One source per job, exactly as the upload path already works — a folder is
    // just a different way of naming the sources.
    let sources: { videoUrl: string; videoName: string; driveFileId: string | null }[]
    if (inputFolder) {
      let files
      try {
        // Listed with the platform service account: input folders are typically
        // *shared with* it, which user OAuth's drive.file scope cannot see.
        files = await listDriveFiles(inputFolder)
      } catch (err) {
        return NextResponse.json(
          { error: `Could not read input Drive folder: ${err instanceof Error ? err.message : 'failed'}` },
          { status: 400 },
        )
      }
      const videos = files.filter(f => /\.(mp4|webm|mov|mkv)$/i.test(f.name))
      if (!videos.length) {
        return NextResponse.json(
          { error: 'Input folder has no videos (mp4/webm/mov/mkv)' },
          { status: 400 },
        )
      }
      sources = videos.map(f => ({ videoUrl: '', videoName: f.name, driveFileId: f.id }))
    } else {
      sources = [{
        videoUrl: videoUrl as string,
        videoName: videoName ?? 'video.mp4',
        driveFileId: null,
      }]
    }

    const ids: string[] = []
    for (const src of sources) {
      const input: VideoRepurposeJobInput = {
        videoUrl: src.videoUrl,
        videoName: src.videoName,
        count,
        baseSeed: baseSeed ?? Math.floor(Math.random() * 0xffffff),
        effects: effectsInput,
        archiveToDrive: archiveToDrive === true,
        characterKey: characterKey ?? null,
        seriesLabel: sanitizeArchiveLabel(seriesLabel) || null,
        driveFileId: src.driveFileId,
        outputDriveFolderId: outputFolder || null,
      }
      const row = await one<{ id: string }>(
        `INSERT INTO generation_queue (user_id, job_type, input, total_items)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [user.id, body.job_type, JSON.stringify(input), count],
      )
      ids.push(row!.id)
      // Single-upload submissions (Run/Queue from the web UI) start now. A
      // Drive-folder fan-out can be dozens of jobs — those stay on cron so they
      // don't all hit ffmpeg on this box at once.
      if (!inputFolder) await fireQueueWorkerNow(row!.id)
    }

    // `id` stays the response shape every existing caller reads.
    return NextResponse.json({ id: ids[0], ids })
  }

  if (body.job_type === 'image_repurpose') {
    const {
      imageUrl, imageName, count, baseSeed, settings,
      inputDriveFolderId, outputDriveFolderId,
    } = body.input ?? {}
    const inputFolder = String(inputDriveFolderId ?? '').trim()
    const outputFolder = String(outputDriveFolderId ?? '').trim()

    if (!inputFolder && (!imageUrl || typeof imageUrl !== 'string')) {
      return NextResponse.json(
        { error: 'imageUrl or inputDriveFolderId required' },
        { status: 400 },
      )
    }
    if (!count || count < 1 || count > 100) {
      return NextResponse.json({ error: 'count must be 1–100' }, { status: 400 })
    }
    if (!settings) {
      return NextResponse.json({ error: 'settings required' }, { status: 400 })
    }
    // Writing needs the user's own OAuth — the service account has no My Drive
    // quota. Fail here rather than after the variants have been rendered.
    if (outputFolder) {
      const driveUploadOk = await requireUserDriveUploadToken(user.id)
      if (driveUploadOk instanceof NextResponse) return driveUploadOk
    }

    // One source per job, exactly as the upload path already works — a folder
    // is just a different way of naming the sources.
    let sources: { imageUrl: string; imageName: string; driveFileId: string | null }[]
    if (inputFolder) {
      let files
      try {
        // Listed with the platform service account: input folders are typically
        // *shared with* it, which user OAuth's drive.file scope cannot see.
        files = await listDriveImages(inputFolder)
      } catch (err) {
        return NextResponse.json(
          { error: `Could not read input Drive folder: ${err instanceof Error ? err.message : 'failed'}` },
          { status: 400 },
        )
      }
      if (!files.length) {
        return NextResponse.json({ error: 'Input folder has no images' }, { status: 400 })
      }
      sources = files.map(f => ({ imageUrl: '', imageName: f.name, driveFileId: f.id }))
    } else {
      sources = [{
        imageUrl: imageUrl as string,
        imageName: imageName ?? 'image.jpg',
        driveFileId: null,
      }]
    }

    const ids: string[] = []
    for (const src of sources) {
      const input: ImageRepurposeJobInput = {
        imageUrl: src.imageUrl,
        imageName: src.imageName,
        count,
        baseSeed: baseSeed ?? Math.floor(Math.random() * 0xffffff),
        settings,
        driveFileId: src.driveFileId,
        outputDriveFolderId: outputFolder || null,
      }
      const row = await one<{ id: string }>(
        `INSERT INTO generation_queue (user_id, job_type, input, total_items)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [user.id, body.job_type, JSON.stringify(input), count],
      )
      ids.push(row!.id)
      if (!inputFolder) await fireQueueWorkerNow(row!.id)
    }

    return NextResponse.json({ id: ids[0], ids })
  }

  if (body.job_type === 'video_caption') {
    const { items, style, customStyle, maxWords, maxDuration, textMode } = body.input ?? {}
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'items required' }, { status: 400 })
    }
    if (items.length > MAX_CAPTION_ITEMS) {
      return NextResponse.json({ error: `Max ${MAX_CAPTION_ITEMS} videos per submission` }, { status: 400 })
    }
    if (items.some(it => !it?.videoUrl || typeof it.videoUrl !== 'string')) {
      return NextResponse.json({ error: 'Every item needs a videoUrl' }, { status: 400 })
    }
    if (!style) {
      return NextResponse.json({ error: 'style required' }, { status: 400 })
    }

    const input: VideoCaptionJobInput = { items, style, customStyle, maxWords, maxDuration, textMode }

    const row = await one<{ id: string }>(
      `INSERT INTO generation_queue (user_id, job_type, input, total_items)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [user.id, body.job_type, JSON.stringify(input), items.length],
    )
    return NextResponse.json({ id: row!.id })
  }

  if (body.job_type === 'video_transcribe') {
    const { items } = body.input ?? {}
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'items required' }, { status: 400 })
    }
    if (items.length > MAX_TRANSCRIBE_ITEMS) {
      return NextResponse.json({ error: `Max ${MAX_TRANSCRIBE_ITEMS} videos per submission` }, { status: 400 })
    }
    if (items.some(it => !it?.videoUrl || typeof it.videoUrl !== 'string')) {
      return NextResponse.json({ error: 'Every item needs a videoUrl' }, { status: 400 })
    }

    const input: VideoTranscribeJobInput = { items }

    const row = await one<{ id: string }>(
      `INSERT INTO generation_queue (user_id, job_type, input, total_items)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [user.id, body.job_type, JSON.stringify(input), items.length],
    )
    return NextResponse.json({ id: row!.id })
  }

  if (body.job_type === 'video_ocr') {
    const { items } = body.input ?? {}
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'items required' }, { status: 400 })
    }
    if (items.length > MAX_OCR_ITEMS) {
      return NextResponse.json({ error: `Max ${MAX_OCR_ITEMS} videos per submission` }, { status: 400 })
    }
    if (items.some(it => !it?.videoUrl || typeof it.videoUrl !== 'string')) {
      return NextResponse.json({ error: 'Every item needs a videoUrl' }, { status: 400 })
    }

    const input: VideoOcrJobInput = { items }

    const row = await one<{ id: string }>(
      `INSERT INTO generation_queue (user_id, job_type, input, total_items)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [user.id, body.job_type, JSON.stringify(input), items.length],
    )
    return NextResponse.json({ id: row!.id })
  }

  if (body.job_type === 'caption_shuffle') {
    const { texts, strength } = body.input ?? {}
    if (!Array.isArray(texts) || texts.length === 0) {
      return NextResponse.json({ error: 'texts required' }, { status: 400 })
    }
    if (!strength || !['light', 'medium', 'heavy'].includes(strength)) {
      return NextResponse.json({ error: 'strength must be light, medium, or heavy' }, { status: 400 })
    }

    const deduped = dedupeCaptions(texts)
    if (deduped.length === 0) {
      return NextResponse.json({ error: 'No non-empty captions found' }, { status: 400 })
    }
    if (deduped.length > MAX_SHUFFLE_ITEMS) {
      return NextResponse.json({ error: `Max ${MAX_SHUFFLE_ITEMS} captions per submission (after dedup)` }, { status: 400 })
    }

    const input: CaptionShuffleJobInput = { texts: deduped, strength }

    const row = await one<{ id: string }>(
      `INSERT INTO generation_queue (user_id, job_type, input, total_items)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [user.id, body.job_type, JSON.stringify(input), deduped.length],
    )
    return NextResponse.json({ id: row!.id, dedupedCount: deduped.length, originalCount: texts.length })
  }

  if (body.job_type === 'caption_generate') {
    const { examples, count, hint } = body.input ?? {}
    if (!Array.isArray(examples) || examples.length === 0) {
      return NextResponse.json({ error: 'examples required' }, { status: 400 })
    }
    if (!count || count < 1) {
      return NextResponse.json({ error: 'count must be at least 1' }, { status: 400 })
    }
    if (count > MAX_GENERATE_COUNT) {
      return NextResponse.json({ error: `Max ${MAX_GENERATE_COUNT} captions per submission` }, { status: 400 })
    }

    const dedupedExamples = dedupeCaptions(examples)
    if (dedupedExamples.length === 0) {
      return NextResponse.json({ error: 'No non-empty example captions found' }, { status: 400 })
    }
    if (dedupedExamples.length > MAX_GENERATE_EXAMPLES) {
      return NextResponse.json({ error: `Max ${MAX_GENERATE_EXAMPLES} example captions (after dedup)` }, { status: 400 })
    }

    const input: CaptionGenerateJobInput = { examples: dedupedExamples, count, hint: hint?.trim() || undefined }

    const row = await one<{ id: string }>(
      `INSERT INTO generation_queue (user_id, job_type, input, total_items)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [user.id, body.job_type, JSON.stringify(input), count],
    )
    return NextResponse.json({ id: row!.id, exampleCount: dedupedExamples.length })
  }

  if (body.job_type === 'comfyui_pod_bulk') {
    const { podUrl, usePodSession, podSessionId, templateId, inputDriveFolderId, outputDriveFolderId, prompts } = body.input ?? {}

    let resolvedPodUrl = podUrl?.trim() ?? ''
    let pinnedPodSessionId: string | null = null
    if (usePodSession || !resolvedPodUrl || podSessionId) {
      try {
        const {
          resolvePodSessionId, requireHealthyPodSession, setWorkflowDefault,
        } = await import('@/lib/my-pod/session')
        pinnedPodSessionId = await resolvePodSessionId(user.id, 'i2v', podSessionId)
        const secrets = await requireHealthyPodSession(user.id, pinnedPodSessionId)
        resolvedPodUrl = secrets.comfyBaseUrl
        await setWorkflowDefault(user.id, 'i2v', pinnedPodSessionId).catch(() => {})
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : 'Pod session required' },
          { status: 400 },
        )
      }
    } else if (!RUNPOD_POD_URL_RE.test(resolvedPodUrl)) {
      return NextResponse.json({ error: 'podUrl must be a RunPod proxy URL like https://<pod-id>-8188.proxy.runpod.net' }, { status: 400 })
    }
    if (!templateId) return NextResponse.json({ error: 'templateId required' }, { status: 400 })
    if (!outputDriveFolderId?.trim()) return NextResponse.json({ error: 'outputDriveFolderId required' }, { status: 400 })
    if (!Array.isArray(prompts) || prompts.filter(p => p?.trim()).length === 0) {
      return NextResponse.json({ error: 'At least one prompt required' }, { status: 400 })
    }

    const template = await one<{ id: string; image_node_id: string | null }>(
      `SELECT id, image_node_id FROM comfyui_templates WHERE id = $1 AND user_id = $2`,
      [templateId, user.id],
    )
    if (!template) return NextResponse.json({ error: 'Template not found' }, { status: 404 })

    const cleanPrompts = prompts.map(p => p.trim()).filter(Boolean)

    const driveUploadOk = await requireUserDriveUploadToken(user.id)
    if (driveUploadOk instanceof NextResponse) return driveUploadOk

    let items: ComfyUIPodBulkItem[]
    if (template.image_node_id) {
      if (!inputDriveFolderId?.trim()) {
        return NextResponse.json({ error: 'This template needs an input image — set inputDriveFolderId' }, { status: 400 })
      }
      let files
      try {
        // Platform SA lists shared input folders; user OAuth (drive.file) cannot see them.
        files = await listDriveImages(inputDriveFolderId.trim())
      } catch (err) {
        return NextResponse.json({ error: `Could not read input Drive folder: ${err instanceof Error ? err.message : 'failed'}` }, { status: 400 })
      }
      if (!files.length) return NextResponse.json({ error: 'Input Drive folder has no image files' }, { status: 400 })
      items = cleanPrompts.map((prompt, i) => ({ prompt, driveFileId: files[i % files.length].id }))
    } else {
      items = cleanPrompts.map(prompt => ({ prompt }))
    }

    const input: ComfyUIPodBulkJobInput = {
      podUrl: resolvedPodUrl,
      templateId,
      outputDriveFolderId: outputDriveFolderId.trim(),
      items,
    }

    const row = await one<{ id: string }>(
      `INSERT INTO generation_queue (user_id, job_type, input, total_items, pod_session_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [user.id, body.job_type, JSON.stringify({ ...input, podSessionId: pinnedPodSessionId }), items.length, pinnedPodSessionId],
    )
    return NextResponse.json({ id: row!.id })
  }

  if (body.job_type === 'my_pod_i2v') {
    const { inputDriveFolderId, outputDriveFolderId, prompt, podSessionId } = body.input ?? {}
    if (!inputDriveFolderId?.trim() || !outputDriveFolderId?.trim()) {
      return NextResponse.json({ error: 'inputDriveFolderId and outputDriveFolderId required' }, { status: 400 })
    }
    let pinnedPodSessionId: string
    try {
      const {
        resolvePodSessionId, requireHealthyPodSession, setWorkflowDefault,
      } = await import('@/lib/my-pod/session')
      pinnedPodSessionId = await resolvePodSessionId(user.id, 'i2v', podSessionId)
      await requireHealthyPodSession(user.id, pinnedPodSessionId)
      await setWorkflowDefault(user.id, 'i2v', pinnedPodSessionId).catch(() => {})
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Pod session required' }, { status: 400 })
    }

    const driveUploadOk = await requireUserDriveUploadToken(user.id)
    if (driveUploadOk instanceof NextResponse) return driveUploadOk

    let files
    try {
      files = await listDriveImages(inputDriveFolderId.trim())
    } catch (err) {
      return NextResponse.json({ error: `Could not read input Drive folder: ${err instanceof Error ? err.message : 'failed'}` }, { status: 400 })
    }
    if (!files.length) return NextResponse.json({ error: 'Input Drive folder has no image files' }, { status: 400 })

    const items = files.map(f => ({
      driveFileId: f.id,
      name: f.name,
      prompt: prompt?.trim() || undefined,
    }))
    const input: MyPodI2vJobInput = {
      inputDriveFolderId: inputDriveFolderId.trim(),
      outputDriveFolderId: outputDriveFolderId.trim(),
      prompt: prompt?.trim() || undefined,
      items,
      podSessionId: pinnedPodSessionId,
    }
    const row = await one<{ id: string }>(
      `INSERT INTO generation_queue (user_id, job_type, input, total_items, pod_session_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [user.id, body.job_type, JSON.stringify(input), items.length, pinnedPodSessionId],
    )
    return NextResponse.json({ id: row!.id })
  }

  if (body.job_type === 'my_pod_animate') {
    const { inputDriveFolderId, outputDriveFolderId, podSessionId } = body.input ?? {}
    if (!inputDriveFolderId?.trim() || !outputDriveFolderId?.trim()) {
      return NextResponse.json({ error: 'inputDriveFolderId and outputDriveFolderId required' }, { status: 400 })
    }
    let pinnedPodSessionId: string
    try {
      const {
        resolvePodSessionId, requireHealthyPodSession, setWorkflowDefault,
      } = await import('@/lib/my-pod/session')
      pinnedPodSessionId = await resolvePodSessionId(user.id, 'animate', podSessionId)
      await requireHealthyPodSession(user.id, pinnedPodSessionId)
      await setWorkflowDefault(user.id, 'animate', pinnedPodSessionId).catch(() => {})
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Pod session required' }, { status: 400 })
    }

    const driveUploadOk = await requireUserDriveUploadToken(user.id)
    if (driveUploadOk instanceof NextResponse) return driveUploadOk

    let allFiles
    try {
      allFiles = await listDriveFiles(inputDriveFolderId.trim())
    } catch (err) {
      return NextResponse.json({ error: `Could not read input Drive folder: ${err instanceof Error ? err.message : 'failed'}` }, { status: 400 })
    }
    const images = allFiles.filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f.name))
    const videos = allFiles.filter(f => /\.(mp4|webm|mov|mkv)$/i.test(f.name))
    if (!images.length) return NextResponse.json({ error: 'Input folder needs a reference image' }, { status: 400 })
    if (!videos.length) return NextResponse.json({ error: 'Input folder needs at least one driving video' }, { status: 400 })

    const ref = images[0]
    const items = videos.map(f => ({ driveFileId: f.id, name: f.name }))
    const input: MyPodAnimateJobInput = {
      inputDriveFolderId: inputDriveFolderId.trim(),
      outputDriveFolderId: outputDriveFolderId.trim(),
      referenceImageId: ref.id,
      referenceImageName: ref.name,
      items,
      podSessionId: pinnedPodSessionId,
    }
    const row = await one<{ id: string }>(
      `INSERT INTO generation_queue (user_id, job_type, input, total_items, pod_session_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [user.id, body.job_type, JSON.stringify(input), items.length, pinnedPodSessionId],
    )
    return NextResponse.json({ id: row!.id })
  }

  if (body.job_type === 'my_pod_talk') {
    const {
      inputDriveFolderId, outputDriveFolderId, fishVoiceId, style, texts, spokenTexts, podSessionId,
    } = body.input ?? {}
    if (!inputDriveFolderId?.trim() || !outputDriveFolderId?.trim()) {
      return NextResponse.json({ error: 'inputDriveFolderId and outputDriveFolderId required' }, { status: 400 })
    }
    if (!fishVoiceId?.trim()) {
      return NextResponse.json({ error: 'fishVoiceId required (Fish Audio voice reference ID)' }, { status: 400 })
    }
    const cleanTexts = (Array.isArray(texts) ? texts : [])
      .map(t => (typeof t === 'string' ? t.trim() : ''))
      .filter(Boolean)
    if (!cleanTexts.length) {
      return NextResponse.json({ error: 'At least one text line required' }, { status: 400 })
    }
    let pinnedPodSessionId: string
    try {
      const {
        resolvePodSessionId, requireHealthyPodSession, setWorkflowDefault,
      } = await import('@/lib/my-pod/session')
      pinnedPodSessionId = await resolvePodSessionId(user.id, 'talk', podSessionId)
      const secrets = await requireHealthyPodSession(user.id, pinnedPodSessionId)
      if (!secrets.fishApiKey?.trim()) {
        return NextResponse.json(
          { error: 'Fish API key required — paste it on this pod in My Pod → Connection' },
          { status: 400 },
        )
      }
      await setWorkflowDefault(user.id, 'talk', pinnedPodSessionId).catch(() => {})
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Pod session required' }, { status: 400 })
    }

    const driveUploadOk = await requireUserDriveUploadToken(user.id)
    if (driveUploadOk instanceof NextResponse) return driveUploadOk

    let files
    try {
      files = await listDriveImages(inputDriveFolderId.trim())
    } catch (err) {
      return NextResponse.json({ error: `Could not read input Drive folder: ${err instanceof Error ? err.message : 'failed'}` }, { status: 400 })
    }
    if (!files.length) return NextResponse.json({ error: 'Input Drive folder has no image files' }, { status: 400 })

    const spokenLines = Array.isArray(spokenTexts)
      ? spokenTexts.map(t => (typeof t === 'string' ? t.trim() : ''))
      : []

    const count = Math.max(cleanTexts.length, files.length)
    const items = Array.from({ length: count }, (_, i) => {
      const file = files[i % files.length]
      const text = cleanTexts[i % cleanTexts.length]
      const spoken = spokenLines[i]?.trim()
      return {
        driveFileId: file.id,
        name: file.name,
        text,
        spokenText: spoken || undefined,
      }
    })

    const input: MyPodTalkJobInput = {
      inputDriveFolderId: inputDriveFolderId.trim(),
      outputDriveFolderId: outputDriveFolderId.trim(),
      fishVoiceId: fishVoiceId.trim(),
      style: style?.trim() || undefined,
      items,
      podSessionId: pinnedPodSessionId,
    }
    const row = await one<{ id: string }>(
      `INSERT INTO generation_queue (user_id, job_type, input, total_items, pod_session_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [user.id, body.job_type, JSON.stringify(input), items.length, pinnedPodSessionId],
    )
    return NextResponse.json({ id: row!.id })
  }

  if (body.job_type === 'bulk_carousel') {
    const { items, variantsExtra } = body.input ?? {}
    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'items required' }, { status: 400 })
    }
    if (items.length > MAX_CAROUSEL_ITEMS) {
      return NextResponse.json({ error: `Max ${MAX_CAROUSEL_ITEMS} carousels per submission` }, { status: 400 })
    }
    if (![1, 2, 3, 4].includes(variantsExtra)) {
      return NextResponse.json({ error: 'variantsExtra must be 1, 2, 3, or 4' }, { status: 400 })
    }
    const carouselItems = items as BulkImageJobItem[]
    const jobRefCount = body.input?.referenceImageUrls?.length ?? 0
    // A per-item scene reference is a valid Seedream base on its own, so
    // seedream-only no longer demands job-level refs — it only demands that
    // every item ends up with at least one image from either level.
    if (
      body.input?.seedreamOnly
      && !jobRefCount
      && !carouselItems.every(it => it.referenceImageUrls?.length)
    ) {
      return NextResponse.json({ error: 'referenceImageUrls required for Seedream-only carousel' }, { status: 400 })
    }
    if (jobRefCount > SEEDREAM_MAX_IMAGES) {
      return NextResponse.json(
        { error: `referenceImageUrls accepts at most ${SEEDREAM_MAX_IMAGES} images` },
        { status: 400 },
      )
    }
    // Both levels compete for the same Seedream image slots, so they are capped
    // together rather than each on its own.
    if (carouselItems.some(it => jobRefCount + (it.referenceImageUrls?.length ?? 0) > SEEDREAM_MAX_IMAGES)) {
      return NextResponse.json(
        { error: `Job-level and per-item referenceImageUrls together accept at most ${SEEDREAM_MAX_IMAGES} images` },
        { status: 400 },
      )
    }

    const input: BulkCarouselJobInput = {
      items,
      variantsExtra,
      presetId: body.input?.presetId,
      grokSmart: body.input?.grokSmart ?? false,
      referenceImageUrls: body.input?.referenceImageUrls,
      seedreamOnly: body.input?.seedreamOnly ?? false,
      seedreamResolution: body.input?.seedreamResolution === '2k' ? '2k' : '1k',
      // Sanitised here, not at use: the ZIP builder in the browser and the Drive
      // enqueue on the server both read this value, and they must agree.
      seriesLabel: sanitizeArchiveLabel(body.input?.seriesLabel) || undefined,
    }

    const row = await one<{ id: string }>(
      `INSERT INTO generation_queue (user_id, job_type, input, total_items)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [user.id, body.job_type, JSON.stringify(input), items.length],
    )
    return NextResponse.json({ id: row!.id })
  }

  if (body.job_type === 'seedance_i2v') {
    const { items, duration, resolution, folderName, generateAudio } = body.input ?? {}

    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'Pick at least one image' }, { status: 400 })
    }
    if (items.length > MAX_SEEDANCE_ITEMS) {
      return NextResponse.json(
        { error: `Max ${MAX_SEEDANCE_ITEMS} videos per batch` },
        { status: 400 },
      )
    }
    if (items.some((it: SeedanceI2VItem) => !it?.imageUrl?.trim())) {
      return NextResponse.json({ error: 'Every item needs an imageUrl' }, { status: 400 })
    }
    if (resolution !== '480p' && resolution !== '720p') {
      return NextResponse.json({ error: 'resolution must be 480p or 720p' }, { status: 400 })
    }
    const dur = Number(duration)
    if (!Number.isFinite(dur) || dur < 3 || dur > 12) {
      return NextResponse.json({ error: 'duration must be between 3 and 12 seconds' }, { status: 400 })
    }
    if (!String(folderName ?? '').trim()) {
      return NextResponse.json({ error: 'folderName required' }, { status: 400 })
    }

    const input: SeedanceI2VJobInput = {
      items: items.map((it: SeedanceI2VItem) => ({
        imageUrl: it.imageUrl.trim(),
        source: it.source ?? null,
      })),
      duration: Math.round(dur),
      resolution,
      folderName: String(folderName).trim(),
      generateAudio: generateAudio === true,
    }

    const row = await one<{ id: string }>(
      `INSERT INTO generation_queue (user_id, job_type, input, total_items)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [user.id, body.job_type, JSON.stringify(input), input.items.length],
    )
    return NextResponse.json({ id: row!.id })
  }

  if (body.job_type === 'infinite_talk') {
    const { items, voiceId, style, resolution, prompt, folderName } = body.input ?? {}

    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'Add images and a CSV first' }, { status: 400 })
    }
    if (items.length > MAX_SEEDANCE_ITEMS) {
      return NextResponse.json(
        { error: `Max ${MAX_SEEDANCE_ITEMS} clips per batch` },
        { status: 400 },
      )
    }
    // Every item must carry at least one half; a pair with neither is a bug in
    // the caller, not an uneven batch.
    if (items.some((it: InfiniteTalkItem) => !it?.imageUrl && !it?.text)) {
      return NextResponse.json({ error: 'An item has neither an image nor a line' }, { status: 400 })
    }
    if (!String(voiceId ?? '').trim()) {
      return NextResponse.json({ error: 'Fish Audio voice id required' }, { status: 400 })
    }
    if (resolution !== '480p' && resolution !== '720p') {
      return NextResponse.json({ error: 'resolution must be 480p or 720p' }, { status: 400 })
    }
    if (!String(folderName ?? '').trim()) {
      return NextResponse.json({ error: 'folderName required' }, { status: 400 })
    }

    const input: InfiniteTalkJobInput = {
      items: items.map((it: InfiniteTalkItem) => ({
        imageUrl: it.imageUrl?.trim() || null,
        text: it.text?.trim() || null,
        source: it.source ?? null,
      })),
      voiceId: String(voiceId).trim(),
      style: String(style ?? '').trim() || null,
      resolution,
      prompt: String(prompt ?? '').trim() || 'a woman speaking to the camera',
      folderName: String(folderName).trim(),
    }

    const row = await one<{ id: string }>(
      `INSERT INTO generation_queue (user_id, job_type, input, total_items)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [user.id, body.job_type, JSON.stringify(input), input.items.length],
    )
    return NextResponse.json({ id: row!.id })
  }

  if (body.job_type === 'copy_paste_v2') {
    const { itemIds, endFrame, repurposeCount } = body.input ?? {}
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return NextResponse.json({ error: 'itemIds required' }, { status: 400 })
    }
    if (itemIds.length > 100) {
      return NextResponse.json({ error: 'Max 100 items per submission' }, { status: 400 })
    }
    const repurpose = Number(repurposeCount) || 0
    if (repurpose < 0 || repurpose > 20) {
      return NextResponse.json({ error: 'repurposeCount must be 0–20' }, { status: 400 })
    }

    const input: CopyPasteJobInput = {
      itemIds,
      endFrame: endFrame === 'always' || endFrame === 'off' ? endFrame : 'auto',
      repurposeCount: repurpose,
    }
    const row = await one<{ id: string }>(
      `INSERT INTO generation_queue (user_id, job_type, input, total_items)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [user.id, body.job_type, JSON.stringify(input), itemIds.length],
    )
    // Start now instead of waiting up to a minute for cron. The worker is called
    // on the loopback port on purpose: going through the public URL would put
    // nginx's proxy_read_timeout between us and a job that runs for minutes.
    const secret = process.env.CRON_SECRET
    if (row && secret) {
      const claimed = await one<{ id: string }>(
        `UPDATE generation_queue
            SET status = 'processing', started_at = now(), attempts = attempts + 1
          WHERE id = $1 AND status = 'pending'
          RETURNING id`,
        [row.id],
      ).catch(() => null)
      if (claimed) {
        const internalBase = `http://127.0.0.1:${process.env.PORT ?? 3000}`
        fetch(`${internalBase}/api/queue/process/${row.id}`, {
          method: 'POST',
          headers: { 'x-cron-secret': secret },
        }).catch(err => console.error('[queue/submit] fire copy_paste_v2 worker:', err))
      }
    }
    return NextResponse.json({ id: row!.id })
  }

  if (body.job_type === 'copy_prompts_generate') {
    const {
      items, mode, loraUrl, loraScale, referenceImageUrls, dimension,
      folderName, characterId, characterName, carousel, seedreamResolution,
      contentFormat,
    } = body.input ?? {}

    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'items required' }, { status: 400 })
    }
    if (items.some(it => !it?.promptId || !it?.prompt?.trim())) {
      return NextResponse.json({ error: 'Every item needs a promptId and prompt' }, { status: 400 })
    }
    if (mode !== 'turbo-lora' && mode !== 'seedream-edit') {
      return NextResponse.json({ error: 'mode must be turbo-lora or seedream-edit' }, { status: 400 })
    }
    if (mode === 'turbo-lora' && !loraUrl?.trim()) {
      return NextResponse.json({ error: 'loraUrl required for turbo-lora mode' }, { status: 400 })
    }
    const cpItems = items as CopyPromptsJobItem[]
    const cpJobRefs = referenceImageUrls?.length ?? 0
    // A per-item scene reference (a picked pin) is a valid Seedream base on its
    // own, so job-level refs are only required when some item lacks one.
    if (
      mode === 'seedream-edit'
      && !cpJobRefs
      && !cpItems.every(it => it.referenceImageUrls?.length)
    ) {
      return NextResponse.json({ error: 'referenceImageUrls required for seedream-edit mode' }, { status: 400 })
    }
    if (cpJobRefs > SEEDREAM_MAX_IMAGES) {
      return NextResponse.json(
        { error: `referenceImageUrls accepts at most ${SEEDREAM_MAX_IMAGES} images` },
        { status: 400 },
      )
    }
    // Both levels share Seedream's image slots, so they are capped together.
    if (cpItems.some(it => cpJobRefs + (it.referenceImageUrls?.length ?? 0) > SEEDREAM_MAX_IMAGES)) {
      return NextResponse.json(
        { error: `Job-level and per-item referenceImageUrls together accept at most ${SEEDREAM_MAX_IMAGES} images` },
        { status: 400 },
      )
    }
    if (!folderName?.trim()) {
      return NextResponse.json({ error: 'folderName required' }, { status: 400 })
    }
    if (carousel?.enabled && ![1, 2, 3, 4].includes(carousel.count)) {
      return NextResponse.json({ error: 'carousel.count must be 1, 2, 3, or 4' }, { status: 400 })
    }
    if (carousel?.enabled && !carousel.posePrompt?.trim()) {
      return NextResponse.json({ error: 'carousel.posePrompt required when carousel is enabled' }, { status: 400 })
    }

    // Budgeted by images produced, not by items: with carousel on, one item is
    // 1 + variants Seedream calls, so a flat item cap means wildly different
    // amounts of work. Same helper the panel uses, so the two never disagree.
    const usesSeedream = mode === 'seedream-edit' || Boolean(carousel?.enabled)
    const slidesPerItem = carousel?.enabled ? 1 + carousel.count : 1
    const maxItems = maxItemsForJob({
      usesSeedream,
      carouselCount: carousel?.enabled ? carousel.count : null,
    })
    if (items.length > maxItems) {
      return NextResponse.json(
        {
          error: carousel?.enabled
            ? `Max ${maxItems} items with a ${slidesPerItem}-slide carousel (${MAX_SEEDREAM_SLIDES_PER_JOB} images per batch) — split the selection or lower the carousel count`
            : `Max ${maxItems} items per submission`,
        },
        { status: 400 },
      )
    }

    const input: CopyPromptsJobInput = {
      items,
      mode,
      loraUrl: loraUrl ?? null,
      loraScale,
      referenceImageUrls,
      dimension: dimension || '9:16',
      folderName: folderName.trim(),
      // Normalized here so a bad value cannot reach the archive as a folder name.
      contentFormat: contentFormat ? normalizeContentFormat(contentFormat) : undefined,
      characterId: characterId ?? null,
      characterName: characterName ?? null,
      carousel: carousel?.enabled
        ? { enabled: true, count: carousel.count, posePrompt: carousel.posePrompt.trim() }
        : undefined,
      seedreamResolution: seedreamResolution === '2k' ? '2k' : '1k',
    }

    const row = await one<{ id: string }>(
      `INSERT INTO generation_queue (user_id, job_type, input, total_items)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [user.id, body.job_type, JSON.stringify(input), items.length],
    )

    // Start now instead of waiting up to a minute for cron — same pattern as copy_paste_v2.
    const secret = process.env.CRON_SECRET
    if (row && secret) {
      const claimed = await one<{ id: string }>(
        `UPDATE generation_queue
            SET status = 'processing', started_at = now(), attempts = attempts + 1
          WHERE id = $1 AND status = 'pending'
          RETURNING id`,
        [row.id],
      ).catch(() => null)
      if (claimed) {
        const internalBase = `http://127.0.0.1:${process.env.PORT ?? 3000}`
        fetch(`${internalBase}/api/queue/process/${row.id}`, {
          method: 'POST',
          headers: { 'x-cron-secret': secret },
        }).catch(err => console.error('[queue/submit] fire copy_prompts_generate worker:', err))
      }
    }

    return NextResponse.json({ id: row!.id })
  }

  return NextResponse.json({ error: 'Invalid job_type' }, { status: 400 })
}
