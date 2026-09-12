import { parseReelUrl } from '@/lib/monitor/parse-reel-url'
import type { KlingShotBeat, KlingVideoContext } from './types'
import type { HashedIdea } from './ideas'

export const KLING_ANALYSIS_TAB = 'Kling Analysis'
export const KLING_IDEAS_TAB = 'Kling Ideas'

export const KLING_ANALYSIS_HEADERS = [
  'Job ID',
  'Added At',
  'Source URL',
  'Profile',
  'Views',
  'Viral',
  'Duration s',
  'Setting',
  'Action',
  'Camera',
  'Speech',
  'Master prompt',
  'Prompt mode',
  'Shots',
  'Status',
  'Kling video URL',
] as const

export const KLING_IDEA_HEADERS = [
  'Added At',
  'Niche',
  'Prompt',
  'Source URL',
  'Viral',
  'Views',
  'Job ID',
  'Hash',
  'Used',
  'Notes',
] as const

export interface ViralSheetFields {
  profile: string
  views: string
  viral: string
}

export const EMPTY_VIRAL_FIELDS: ViralSheetFields = { profile: '', views: '', viral: '' }

/** Lowercased Instagram shortcode, or null if the string is not a reel/post URL. */
export function instagramShortcode(urlOrCode: string): string | null {
  const parsed = parseReelUrl(urlOrCode.trim())
  return parsed?.shortCode.toLowerCase() ?? null
}

/** True when both strings resolve to the same IG shortcode (/reel/ vs /p/ etc.). */
export function urlsShareShortcode(a: string, b: string): boolean {
  const left = instagramShortcode(a)
  const right = instagramShortcode(b)
  return !!left && !!right && left === right
}

export interface ViralLookupRow {
  profile_username: string
  video_url: string
  shortcode: string | null
  last_views: string | number | null
  reported_at: string | Date | null
}

export function matchViralRow(sourceUrl: string, rows: ViralLookupRow[]): ViralLookupRow | null {
  const code = instagramShortcode(sourceUrl)
  if (!code) return null
  return rows.find(row => {
    if (row.shortcode && row.shortcode.toLowerCase() === code) return true
    return instagramShortcode(row.video_url) === code
  }) ?? null
}

export function viralFieldsFromRow(row: ViralLookupRow | null): ViralSheetFields {
  if (!row) return { ...EMPTY_VIRAL_FIELDS }
  return {
    profile: row.profile_username ?? '',
    views: row.last_views == null || row.last_views === '' ? '' : String(row.last_views),
    viral: row.reported_at ? 'YES' : '',
  }
}

export function formatShots(shots: KlingShotBeat[] | null | undefined): string {
  if (!shots?.length) return ''
  return shots
    .map(s => `${s.t_start}-${s.t_end}s: ${s.prompt}`.trim())
    .filter(Boolean)
    .join(' | ')
}

export interface AnalysisSheetInput {
  jobId: string
  addedAt: string
  sourceUrl: string
  viral: ViralSheetFields
  durationSec: number | string | null
  context: Partial<KlingVideoContext> | null
  masterPrompt: string | null
  status: string
  klingVideoUrl: string | null
}

export function buildAnalysisSheetRow(input: AnalysisSheetInput): string[] {
  const ctx = input.context ?? {}
  const duration = input.durationSec ?? ctx.duration_sec ?? ''
  return [
    input.jobId,
    input.addedAt,
    input.sourceUrl,
    input.viral.profile,
    input.viral.views,
    input.viral.viral,
    duration === '' || duration == null ? '' : String(duration),
    ctx.setting ?? '',
    ctx.character_action ?? '',
    ctx.camera ?? '',
    ctx.speech ?? '',
    input.masterPrompt ?? '',
    ctx.prompt_mode ?? '',
    formatShots(ctx.shots),
    input.status,
    input.klingVideoUrl ?? '',
  ]
}

export interface IdeaSheetInput {
  addedAt: string
  idea: HashedIdea
  sourceUrl: string
  viral: ViralSheetFields
  jobId: string | null
}

/**
 * New idea rows always leave Used and Notes empty — those columns are for
 * humans. Callers must not PUT over existing idea rows.
 */
export function buildIdeaSheetRow(input: IdeaSheetInput): string[] {
  return [
    input.addedAt,
    input.idea.niche,
    input.idea.prompt,
    input.sourceUrl,
    input.viral.viral,
    input.viral.views,
    input.jobId ?? '',
    input.idea.hash,
    '',
    '',
  ]
}

/** 1-based sheet row of a Job ID in column A, or null. Skips the header row. */
export function findAnalysisRowNumber(values: string[][], jobId: string): number | null {
  for (let i = 1; i < values.length; i++) {
    if ((values[i]?.[0] ?? '').trim() === jobId) return i + 1
  }
  return null
}

export function existingIdeaHashes(values: string[][]): Set<string> {
  const hashes = new Set<string>()
  for (let i = 1; i < values.length; i++) {
    const hash = (values[i]?.[7] ?? '').trim()
    if (hash && hash !== 'Hash') hashes.add(hash)
  }
  return hashes
}

export function ideasNotAlreadyInSheet(ideas: HashedIdea[], existingHashes: Iterable<string>): HashedIdea[] {
  const seen = new Set(existingHashes)
  return ideas.filter(idea => {
    if (seen.has(idea.hash)) return false
    seen.add(idea.hash)
    return true
  })
}
