import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { one } from '@/lib/db'
import { listDriveFiles } from '@/lib/google-drive'
import type { VideoEffectOpts } from '@/lib/video-ffmpeg'
import type { CaptionStyle, CaptionCustomStyle } from '@/lib/captions'
import { dedupeCaptions } from '@/lib/caption-shuffle'
import { SEEDREAM_MAX_IMAGES } from '@/lib/wavespeed'

export interface BulkImageJobItem {
  prompt: string
  dimension: string
  loraUrl?: string | null
  loraScale?: number
  characterId?: string
  characterName?: string
}

export interface BulkCarouselJobInput {
  items: BulkImageJobItem[]
  variantsExtra: 1 | 2 | 3 | 4
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
  videoUrl: string
  videoName: string
  count: number
  baseSeed: number
  effects: VideoEffectOpts
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
  items: { driveFileId: string; name: string; prompt?: string }[]
}

export interface MyPodAnimateJobInput {
  inputDriveFolderId: string
  outputDriveFolderId: string
  referenceImageId: string
  referenceImageName: string
  items: { driveFileId: string; name: string }[]
}

export interface MyPodTalkJobInput {
  inputDriveFolderId: string
  outputDriveFolderId: string
  fishVoiceId: string
  style?: string
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
const MAX_COMFYUI_ITEMS = 50
const MAX_SHUFFLE_ITEMS = 5000
const MAX_GENERATE_COUNT = 5000
const MAX_GENERATE_EXAMPLES = 2000
const MAX_CAROUSEL_ITEMS = 25

// Only RunPod's own HTTP proxy domain is accepted — hard SSRF guard, no exceptions.
const RUNPOD_POD_URL_RE = /^https:\/\/[a-z0-9-]+-\d+\.proxy\.runpod\.net\/?$/i

export type QueueSubmitBody =
  | { job_type: 'bulk_image'; input: { jobs: BulkImageJobItem[] } }
  | { job_type: 'video_repurpose'; input: VideoRepurposeJobInput }
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
        templateId: string
        inputDriveFolderId?: string
        outputDriveFolderId: string
        prompts: string[]
      }
    }
  | {
      job_type: 'my_pod_i2v'
      input: { inputDriveFolderId: string; outputDriveFolderId: string; prompt?: string }
    }
  | {
      job_type: 'my_pod_animate'
      input: { inputDriveFolderId: string; outputDriveFolderId: string }
    }
  | {
      job_type: 'my_pod_talk'
      input: {
        inputDriveFolderId: string
        outputDriveFolderId: string
        fishVoiceId: string
        style?: string
        /** One caption/script per line; paired with images (cycled if counts differ). */
        texts: string[]
        /** Optional spoken overrides (1 per line); blank line = use Text. */
        spokenTexts?: string[]
      }
    }
  | { job_type: 'bulk_carousel'; input: BulkCarouselJobInput }

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
    const { videoUrl, videoName, count, baseSeed, effects } = body.input ?? {}
    if (!videoUrl || typeof videoUrl !== 'string') {
      return NextResponse.json({ error: 'videoUrl required' }, { status: 400 })
    }
    if (!count || count < 1 || count > 100) {
      return NextResponse.json({ error: 'count must be 1–100' }, { status: 400 })
    }

    const input: VideoRepurposeJobInput = {
      videoUrl,
      videoName: videoName ?? 'video.mp4',
      count,
      baseSeed: baseSeed ?? Math.floor(Math.random() * 0xffffff),
      effects: effects ?? {
        brightness: true, contrast: true, saturation: true,
        hue: false, speed: false, flipH: false, crop: true, fade: false,
      },
    }

    const row = await one<{ id: string }>(
      `INSERT INTO generation_queue (user_id, job_type, input, total_items)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [user.id, body.job_type, JSON.stringify(input), count],
    )
    return NextResponse.json({ id: row!.id })
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
    const { podUrl, usePodSession, templateId, inputDriveFolderId, outputDriveFolderId, prompts } = body.input ?? {}

    let resolvedPodUrl = podUrl?.trim() ?? ''
    if (usePodSession || !resolvedPodUrl) {
      try {
        const { requireHealthyPodSession } = await import('@/lib/my-pod/session')
        const secrets = await requireHealthyPodSession(user.id)
        resolvedPodUrl = secrets.comfyBaseUrl
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

    const cleanPrompts = prompts.map(p => p.trim()).filter(Boolean).slice(0, MAX_COMFYUI_ITEMS)

    let items: ComfyUIPodBulkItem[]
    if (template.image_node_id) {
      if (!inputDriveFolderId?.trim()) {
        return NextResponse.json({ error: 'This template needs an input image — set inputDriveFolderId' }, { status: 400 })
      }
      let files
      try {
        files = await listDriveFiles(inputDriveFolderId.trim(), 'image/')
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
      `INSERT INTO generation_queue (user_id, job_type, input, total_items)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [user.id, body.job_type, JSON.stringify(input), items.length],
    )
    return NextResponse.json({ id: row!.id })
  }

  if (body.job_type === 'my_pod_i2v') {
    const { inputDriveFolderId, outputDriveFolderId, prompt } = body.input ?? {}
    if (!inputDriveFolderId?.trim() || !outputDriveFolderId?.trim()) {
      return NextResponse.json({ error: 'inputDriveFolderId and outputDriveFolderId required' }, { status: 400 })
    }
    try {
      const { requireHealthyPodSession } = await import('@/lib/my-pod/session')
      await requireHealthyPodSession(user.id)
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Pod session required' }, { status: 400 })
    }

    let files
    try {
      files = await listDriveFiles(inputDriveFolderId.trim(), 'image/')
    } catch (err) {
      return NextResponse.json({ error: `Could not read input Drive folder: ${err instanceof Error ? err.message : 'failed'}` }, { status: 400 })
    }
    if (!files.length) return NextResponse.json({ error: 'Input Drive folder has no image files' }, { status: 400 })

    const items = files.slice(0, MAX_COMFYUI_ITEMS).map(f => ({
      driveFileId: f.id,
      name: f.name,
      prompt: prompt?.trim() || undefined,
    }))
    const input: MyPodI2vJobInput = {
      inputDriveFolderId: inputDriveFolderId.trim(),
      outputDriveFolderId: outputDriveFolderId.trim(),
      prompt: prompt?.trim() || undefined,
      items,
    }
    const row = await one<{ id: string }>(
      `INSERT INTO generation_queue (user_id, job_type, input, total_items)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [user.id, body.job_type, JSON.stringify(input), items.length],
    )
    return NextResponse.json({ id: row!.id })
  }

  if (body.job_type === 'my_pod_animate') {
    const { inputDriveFolderId, outputDriveFolderId } = body.input ?? {}
    if (!inputDriveFolderId?.trim() || !outputDriveFolderId?.trim()) {
      return NextResponse.json({ error: 'inputDriveFolderId and outputDriveFolderId required' }, { status: 400 })
    }
    try {
      const { requireHealthyPodSession } = await import('@/lib/my-pod/session')
      await requireHealthyPodSession(user.id)
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Pod session required' }, { status: 400 })
    }

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
    const items = videos.slice(0, MAX_COMFYUI_ITEMS).map(f => ({ driveFileId: f.id, name: f.name }))
    const input: MyPodAnimateJobInput = {
      inputDriveFolderId: inputDriveFolderId.trim(),
      outputDriveFolderId: outputDriveFolderId.trim(),
      referenceImageId: ref.id,
      referenceImageName: ref.name,
      items,
    }
    const row = await one<{ id: string }>(
      `INSERT INTO generation_queue (user_id, job_type, input, total_items)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [user.id, body.job_type, JSON.stringify(input), items.length],
    )
    return NextResponse.json({ id: row!.id })
  }

  if (body.job_type === 'my_pod_talk') {
    const {
      inputDriveFolderId, outputDriveFolderId, fishVoiceId, style, texts, spokenTexts,
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
      .slice(0, MAX_COMFYUI_ITEMS)
    if (!cleanTexts.length) {
      return NextResponse.json({ error: 'At least one text line required' }, { status: 400 })
    }
    try {
      const { requireHealthyPodSession } = await import('@/lib/my-pod/session')
      const secrets = await requireHealthyPodSession(user.id)
      if (!secrets.fishApiKey?.trim()) {
        return NextResponse.json(
          { error: 'Fish API key required — paste it in My Pod → Connection' },
          { status: 400 },
        )
      }
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Pod session required' }, { status: 400 })
    }

    let files
    try {
      files = await listDriveFiles(inputDriveFolderId.trim(), 'image/')
    } catch (err) {
      return NextResponse.json({ error: `Could not read input Drive folder: ${err instanceof Error ? err.message : 'failed'}` }, { status: 400 })
    }
    if (!files.length) return NextResponse.json({ error: 'Input Drive folder has no image files' }, { status: 400 })

    const spokenLines = Array.isArray(spokenTexts)
      ? spokenTexts.map(t => (typeof t === 'string' ? t.trim() : ''))
      : []

    const count = Math.min(MAX_COMFYUI_ITEMS, Math.max(cleanTexts.length, files.length))
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
    }
    const row = await one<{ id: string }>(
      `INSERT INTO generation_queue (user_id, job_type, input, total_items)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [user.id, body.job_type, JSON.stringify(input), items.length],
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
    if (body.input?.seedreamOnly && !body.input.referenceImageUrls?.length) {
      return NextResponse.json({ error: 'referenceImageUrls required for Seedream-only carousel' }, { status: 400 })
    }
    if ((body.input?.referenceImageUrls?.length ?? 0) > SEEDREAM_MAX_IMAGES) {
      return NextResponse.json(
        { error: `referenceImageUrls accepts at most ${SEEDREAM_MAX_IMAGES} images` },
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
    }

    const row = await one<{ id: string }>(
      `INSERT INTO generation_queue (user_id, job_type, input, total_items)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [user.id, body.job_type, JSON.stringify(input), items.length],
    )
    return NextResponse.json({ id: row!.id })
  }

  return NextResponse.json({ error: 'Invalid job_type' }, { status: 400 })
}
