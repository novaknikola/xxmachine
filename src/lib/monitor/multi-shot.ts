import { existsSync, unlinkSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { one, query } from '@/lib/db'
import { uploadBuffer } from '@/lib/supabase-storage'
import { generateReplicaVideo } from './replicate'
import { notifyReplicationDone } from './notify'
import {
  downloadToFile,
  expandRefsForMotion,
  MAX_SEGMENTS,
  MIN_MOTION_REF_SECONDS,
  planSegments,
  splitAndUploadSegments,
  stitchSegments,
  type SourceSegment,
} from './segments'

const execFileAsync = promisify(execFile)
const SCENE_THRESHOLD = 0.35

export interface MonitorMultiShotJobInput {
  discoveryItemId: string
  imageUrl: string
  sourceVideoUrl: string
}

export interface MonitorMultiShotJobOutput {
  segmentUrls?: string[]
  clipUrls?: (string | null)[]
  finalUrl?: string
  error?: string
}

/**
 * Enqueues background per-segment motion transfer + stitch. Returns the job id.
 * Caller is responsible for setting discovery_items.replicate_status.
 */
export async function enqueueMultiShotJob(opts: {
  userId: string
  discoveryItemId: string
  imageUrl: string
  sourceVideoUrl: string
  segmentCount: number
}): Promise<string> {
  const input: MonitorMultiShotJobInput = {
    discoveryItemId: opts.discoveryItemId,
    imageUrl: opts.imageUrl,
    sourceVideoUrl: opts.sourceVideoUrl,
  }
  const row = await one<{ id: string }>(
    `INSERT INTO generation_queue (user_id, job_type, input, total_items)
     VALUES ($1, 'monitor_multi_shot', $2::jsonb, $3)
     RETURNING id`,
    [opts.userId, JSON.stringify(input), Math.max(1, opts.segmentCount)],
  )
  if (!row) throw new Error('Failed to enqueue multi-shot job')
  return row.id
}

async function localDuration(path: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_format', path,
    ])
    const d = parseFloat(JSON.parse(stdout).format?.duration ?? '0')
    return d > 0 ? d : null
  } catch {
    return null
  }
}

async function localCutTimes(path: string): Promise<number[]> {
  try {
    const { stderr } = await execFileAsync('ffmpeg', [
      '-i', path,
      '-vf', `select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
      '-f', 'null', '-',
    ], { maxBuffer: 20_000_000 })
    const times: number[] = []
    for (const m of stderr.matchAll(/pts_time:([0-9.]+)/g)) {
      const t = parseFloat(m[1])
      if (Number.isFinite(t)) times.push(t)
    }
    return times.sort((a, b) => a - b)
  } catch {
    return []
  }
}

/**
 * Shared-keyframe multi-shot: one character image, motion-control per cut segment,
 * stitch back with the original audio track.
 */
export async function processMultiShotJob(opts: {
  jobId: string
  userId: string
  input: MonitorMultiShotJobInput
  doneItems: number
  existingOutput: MonitorMultiShotJobOutput | null
}): Promise<{ done: number; finalUrl: string }> {
  const { jobId, input } = opts
  const sourcePath = join(tmpdir(), `mon_ms_src_${randomUUID()}.mp4`)
  const stitchedPath = join(tmpdir(), `mon_ms_out_${randomUUID()}.mp4`)
  const clipPaths: string[] = []

  try {
    await downloadToFile(input.sourceVideoUrl, sourcePath)

    const duration = await localDuration(sourcePath)
    if (!duration) throw new Error('Could not measure source duration for multi-shot')

    const cutTimes = await localCutTimes(sourcePath)
    let planned: SourceSegment[] = planSegments(cutTimes, duration)
    if (planned.length < 2) {
      planned = planSegments([], duration)
    }
    if (planned.length > MAX_SEGMENTS) {
      throw new Error(`Too many segments (${planned.length}); max is ${MAX_SEGMENTS}`)
    }

    // Expand short shots' reference windows so Kling accepts them (≥3s), but keep
    // original cut lengths for the final stitch rhythm.
    const refs = expandRefsForMotion(planned, duration, MIN_MOTION_REF_SECONDS)
    const tooShort = refs.some(r => r.reference.duration < MIN_MOTION_REF_SECONDS)
    if (tooShort) {
      // Whole clip itself is under the floor — one shot is the only option.
      planned = planSegments([], duration)
      refs.length = 0
      refs.push(...expandRefsForMotion(planned, duration, MIN_MOTION_REF_SECONDS))
    }

    const trimSegments = refs.map(r => r.trim)
    const referenceSegments = refs.map(r => r.reference)

    console.log(
      '[monitor/multi-shot] refs',
      refs.map(r =>
        `trim ${r.trim.start.toFixed(2)}-${r.trim.end.toFixed(2)} ` +
        `ref ${r.reference.start.toFixed(2)}-${r.reference.end.toFixed(2)}(${r.reference.duration}s)`,
      ).join(' | '),
    )

    await query(
      `UPDATE generation_queue SET total_items = $2 WHERE id = $1`,
      [jobId, refs.length],
    )

    const storagePrefix = `monitor/${input.discoveryItemId}/${jobId}`
    const output: MonitorMultiShotJobOutput = {
      segmentUrls: opts.existingOutput?.segmentUrls,
      clipUrls: opts.existingOutput?.clipUrls
        ? [...opts.existingOutput.clipUrls]
        : new Array(refs.length).fill(null),
      finalUrl: opts.existingOutput?.finalUrl,
    }

    if (!output.segmentUrls?.length) {
      output.segmentUrls = await splitAndUploadSegments(sourcePath, referenceSegments, storagePrefix)
      await query(
        `UPDATE generation_queue
            SET output = $2::jsonb, progress = 5
          WHERE id = $1`,
        [jobId, JSON.stringify(output)],
      )
    }

    let done = opts.doneItems
    for (let i = done; i < refs.length; i++) {
      const segmentUrl = output.segmentUrls[i]
      if (!segmentUrl) throw new Error(`Missing uploaded segment ${i}`)

      const result = await generateReplicaVideo({
        technique: 'motion_transfer',
        imageUrl: input.imageUrl,
        sourceVideoUrl: segmentUrl,
        duration: referenceSegments[i].duration,
      })

      let stored = result.videoUrl
      try {
        const res = await fetch(result.videoUrl, { signal: AbortSignal.timeout(120_000) })
        if (res.ok) {
          stored = await uploadBuffer(
            Buffer.from(await res.arrayBuffer()),
            `${storagePrefix}/gen_${i + 1}.mp4`,
            'video/mp4',
          )
        }
      } catch {
        // Keep the Wavespeed URL if our storage upload fails.
      }

      output.clipUrls![i] = stored
      done = i + 1
      const progress = Math.round((done / refs.length) * 90)
      await query(
        `UPDATE generation_queue
            SET done_items = $2, progress = $3, output = $4::jsonb
          WHERE id = $1`,
        [jobId, done, progress, JSON.stringify(output)],
      )
    }

    // Download generated clips locally for stitching.
    for (let i = 0; i < refs.length; i++) {
      const url = output.clipUrls![i]
      if (!url) throw new Error(`Segment ${i} has no generated clip`)
      const path = join(tmpdir(), `mon_ms_clip_${randomUUID()}.mp4`)
      await downloadToFile(url, path)
      clipPaths.push(path)
    }

    await stitchSegments({
      clipPaths,
      segments: trimSegments,
      audioSourcePath: sourcePath,
      outputPath: stitchedPath,
    })

    const finalUrl = await uploadBuffer(
      readFileSync(stitchedPath),
      `${storagePrefix}/final.mp4`,
      'video/mp4',
    )
    output.finalUrl = finalUrl

    const item = await one<{
      profile: string
      content_url: string
      content_type: string | null
      generated_image_url: string | null
      user_id: string
    }>(
      `SELECT profile, content_url, content_type, generated_image_url, user_id
         FROM discovery_items WHERE id = $1`,
      [input.discoveryItemId],
    )

    await query(
      `UPDATE discovery_items
          SET kling_video_url = $2,
              video_model = $3,
              video_technique = 'multi_shot',
              replicate_status = 'done',
              replicate_error = NULL
        WHERE id = $1`,
      [input.discoveryItemId, finalUrl, 'multi_shot+kling-motion-control'],
    )

    if (item) {
      await notifyReplicationDone({
        userId: item.user_id,
        profile: item.profile,
        contentUrl: item.content_url,
        contentType: item.content_type ?? 'video_gen',
        imageUrl: item.generated_image_url,
        videoUrl: finalUrl,
      }).catch(() => {})
    }

    await query(
      `UPDATE generation_queue
          SET status = 'done', finished_at = now(), progress = 100,
              done_items = $2, output = $3::jsonb
        WHERE id = $1`,
      [jobId, refs.length, JSON.stringify(output)],
    )

    return { done: refs.length, finalUrl }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await query(
      `UPDATE discovery_items
          SET replicate_status = 'failed', replicate_error = $2
        WHERE id = $1 AND replicate_status = 'video_generating'`,
      [input.discoveryItemId, msg],
    )
    throw err
  } finally {
    for (const p of [sourcePath, stitchedPath, ...clipPaths]) {
      try { if (existsSync(p)) unlinkSync(p) } catch {}
    }
  }
}
