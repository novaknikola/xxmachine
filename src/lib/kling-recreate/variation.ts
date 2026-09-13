import type { KlingI2VInput } from './kling-client'
import type { KlingRecreateJobRow, KlingUserSettings, KlingVideoContext } from './types'

export const VARIATION_COUNT_MIN = 1
export const VARIATION_COUNT_MAX = 6
export const VARIATION_AWAITING_PREFIX = 'variation:'
export const VARIATION_INSTRUCTION = 'Apply this change to the video:'

export function clampVariationCount(n: number): number {
  if (!Number.isFinite(n)) return VARIATION_COUNT_MIN
  return Math.min(VARIATION_COUNT_MAX, Math.max(VARIATION_COUNT_MIN, Math.round(n)))
}

export interface VariationParseOk {
  change: string
  count: number
}

export interface VariationParseErr {
  change: null
  count: number
}

export type VariationParse = VariationParseOk | VariationParseErr

/** True when the next Telegram text must be treated as a variation delta, not reel URLs. */
export function isVariationAwaiting(awaiting: string | null | undefined): awaiting is `variation:${string}` {
  return typeof awaiting === 'string' && awaiting.startsWith(VARIATION_AWAITING_PREFIX)
}

export function variationAwaitingJobId(awaiting: string | null | undefined): string | null {
  if (!isVariationAwaiting(awaiting)) return null
  const id = awaiting.slice(VARIATION_AWAITING_PREFIX.length).trim()
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null
}

export function variationAwaitingValue(jobId: string): string {
  return `${VARIATION_AWAITING_PREFIX}${jobId}`
}

/**
 * Pull count 1–6 and the change text from one message.
 * Accepts `softer smile, 3` / `3\\nwarmer lighting` / `make it night, count: 2`.
 * Omitting a number defaults to 1. A number with no change text is an error.
 */
export function parseVariationRequest(raw: string): VariationParse {
  const text = String(raw ?? '').replace(/\r/g, '').trim()
  if (!text) return { change: null, count: 1 }

  let count: number | null = null
  let rest = text

  const labelled = rest.match(/\bcount\s*[:=]\s*(\d+)\b/i)
  if (labelled) {
    count = Number(labelled[1])
    rest = rest.replace(labelled[0], ' ')
  }

  if (count == null) {
    const lines = rest.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines[0] && /^\d+$/.test(lines[0])) {
      count = Number(lines[0])
      rest = lines.slice(1).join('\n')
    }
  }

  if (count == null) {
    const lead = rest.match(/^(\d+)\s+(?:copies?\s+)?(?:with\s+)?(.+)$/is)
    if (lead) {
      count = Number(lead[1])
      rest = lead[2]
    }
  }

  if (count == null) {
    const trail = rest.match(/[,\s]+(\d+)\s*$/)
    if (trail) {
      count = Number(trail[1])
      rest = rest.slice(0, trail.index)
    }
  }

  const change = rest.replace(/\s+/g, ' ').replace(/^[,.\s]+|[,.\s]+$/g, '').trim()
  return {
    change: change.length ? change : null,
    count: clampVariationCount(count ?? 1),
  }
}

export function applyVariationDelta(base: string, change: string): string {
  const delta = `${VARIATION_INSTRUCTION} ${change.trim()}`
  const body = base.trim()
  return body ? `${body}\n\n${delta}` : delta
}

/** Keep the parent's prompt XOR multi_prompt choice; apply the delta to whichever is set. */
export function applyVariationToKlingInput(input: KlingI2VInput, change: string): KlingI2VInput {
  const next: KlingI2VInput = { ...input }
  if (next.multi_prompt?.length) {
    next.multi_prompt = next.multi_prompt.map(shot => ({
      ...shot,
      prompt: applyVariationDelta(shot.prompt, change),
    }))
    delete next.prompt
  } else {
    next.prompt = applyVariationDelta(next.prompt ?? '', change)
    delete next.multi_prompt
  }
  return next
}

export function variationSkipsUpstream(row: { parent_job_id?: string | null }): boolean {
  return Boolean(row.parent_job_id)
}

export type VariationCallbackAction = 'change' | 'skip'

export function parseVariationCallback(data: string): { action: VariationCallbackAction; jobId: string } | null {
  const parts = data.split(':')
  if (parts[0] !== 'kr') return null
  if (parts[1] !== 'var' && parts[1] !== 'skip') return null
  const jobId = parts.slice(2).join(':')
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return null
  return { action: parts[1] === 'skip' ? 'skip' : 'change', jobId }
}

/** Skip never enqueues. Change only arms the next-message parser. */
export function planVariationCallback(action: VariationCallbackAction): {
  enqueueCount: number
  awaitPrompt: boolean
} {
  if (action === 'skip') return { enqueueCount: 0, awaitPrompt: false }
  return { enqueueCount: 0, awaitPrompt: true }
}

export interface VariationJobDraft {
  parentJobId: string
  sourceUrl: string
  videoUrl: string | null
  durationSec: number | string | null
  referenceImageUrl: string | null
  characterImageUrl: string
  masterPrompt: string
  context: KlingVideoContext | Record<string, unknown> | null
  settings: KlingUserSettings | Record<string, unknown>
  variationNote: string
  skipScrape: true
  skipAnalyze: true
  skipStill: true
  skipIdeas: true
  klingPrompt: string
}

export function buildVariationJobDrafts(
  parent: Pick<
    KlingRecreateJobRow,
    'id' | 'source_url' | 'video_url' | 'duration_sec' | 'reference_image_url'
    | 'character_image_url' | 'master_prompt' | 'context' | 'settings'
  >,
  change: string,
  count: number,
): VariationJobDraft[] {
  const note = change.trim()
  if (!note) throw new Error('Change text is required')
  if (!parent.character_image_url) throw new Error('Parent job has no character still')
  const n = clampVariationCount(count)
  const master = parent.master_prompt ?? ''
  return Array.from({ length: n }, () => ({
    parentJobId: parent.id,
    sourceUrl: parent.source_url,
    videoUrl: parent.video_url,
    durationSec: parent.duration_sec,
    referenceImageUrl: parent.reference_image_url,
    characterImageUrl: parent.character_image_url!,
    masterPrompt: master,
    context: parent.context,
    settings: parent.settings,
    variationNote: note,
    skipScrape: true,
    skipAnalyze: true,
    skipStill: true,
    skipIdeas: true,
    klingPrompt: applyVariationDelta(master, note),
  }))
}
