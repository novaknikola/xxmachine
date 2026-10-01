/**
 * Paste reel URLs → resolve to playable video URLs → enqueue for Copy-Paste.
 *
 * Lifted out of /api/monitor/enqueue-urls so the Telegram bot can run the same
 * path. That route authenticates with a session, which a webhook does not have,
 * so the caller passes the user id instead and the route stays a thin wrapper.
 */
import { one, query } from '@/lib/db'
import { resolveKey } from '@/lib/user-keys'
import {
  ensureReelAudio,
  fetchPostsViaIntropix,
  listProfileReels,
  resolveVideoUrlViaRapidApi,
  resolveVideoUrlsViaApify,
} from '@/lib/instagram-scrape'
import {
  describeReelFailure,
  finalReelFailure,
  runReelProviderChain,
  type ChainOutcome,
  type FinalReelFailure,
  type ReelProviders,
  type ReelSourceErrorType,
} from './reel-source'
import { enqueueDiscoveryReels, type EnqueueReelInput } from './enqueue'
import { parseReelUrlList } from './parse-reel-url'
import { scheduleAutoClassify } from './auto-classify'
import { isPlayableVideoUrl } from './video-url'
import { videoHasAudio } from './video-audio'

export const MAX_URLS = 30
const LIST_LIMIT = 50

/**
 * Label for reels whose owner the pasted URL does not reveal (a bare
 * instagram.com/reel/<code> link). It names the card and the Drive folder, so it
 * must never be guessed from tracked_profiles: identity comes from the uploaded
 * reference photo, and borrowing an unrelated persona filed output under the
 * wrong character.
 */
export const UNKNOWN_SOURCE_LABEL = 'copy-paste'

export interface ResolveError {
  permalink: string
  error: string
}

export class EnqueueUrlsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: {
      resolveErrors?: ResolveError[]
      invalid?: string[]
      apifyDown?: boolean
      /** Why nothing could be fetched, when every reel failed for the same reason. */
      reason?: ReelSourceErrorType
      /** The deciding failure per reel. */
      failures?: { permalink: string; failure: FinalReelFailure }[]
    },
  ) {
    super(message)
  }
}

export interface ResolveReelUrlsResult {
  reels: EnqueueReelInput[]
  resolveErrors: ResolveError[]
  invalid: string[]
  username: string
  sourceUsername: string | null
  truncated: boolean
}

/** The production providers behind runReelProviderChain. */
const PROVIDERS: ReelProviders = {
  apifyAnonymous: resolveVideoUrlsViaApify,
  intropix: fetchPostsViaIntropix,
  rapidApi: resolveVideoUrlViaRapidApi,
  listProfile: listProfileReels,
  ensureAudio: ensureReelAudio,
  sleep: ms => new Promise(r => setTimeout(r, ms)),
}

/**
 * The actual link → playable video URL resolution (cached lookup, then
 * runReelProviderChain: anonymous Apify, the authenticated Apify actor for what
 * it could not see, RapidAPI, profile listing, one delayed Apify retry for an
 * empty answer) — everything enqueueReelUrlsForUser needs BEFORE it
 * decides what to do with the resolved reels. Split out 2026-09-20 so the
 * new Wan 3.0 Copy-Paste pipeline (wan-jobs.ts) can reuse this exact
 * resolution chain without going through discovery_items at all — that
 * table's UNIQUE(user_id, content_id) is wrong for "the same reel, a
 * different character" (see migration 097's comment).
 */
export async function resolveReelUrls(opts: {
  userId: string
  /** Newline/whitespace separated reel links. */
  rawText: string
  username?: string | null
  sourceUsername?: string | null
}): Promise<ResolveReelUrlsResult> {
  const { userId, rawText } = opts

  const { parsed, invalid } = parseReelUrlList(rawText, MAX_URLS)
  if (!parsed.length) {
    throw new EnqueueUrlsError(
      invalid.length ? 'No valid Instagram reel links' : 'Paste at least one Instagram reel URL',
      400,
      { invalid },
    )
  }

  const explicitUsername = String(opts.username ?? '').trim().replace(/^@/, '')
  const fromUrls = parsed.map(p => p.ownerUsername).find(Boolean) ?? null
  const username = explicitUsername || fromUrls || UNKNOWN_SOURCE_LABEL

  // Null when nobody told us the real owner. Only a real handle can be listed on
  // Instagram, so the fallback label must not leak into a scrape call.
  const sourceUsername =
    String(opts.sourceUsername ?? '').trim().replace(/^@/, '') || fromUrls || null

  const resolved = new Map<string, EnqueueReelInput>()
  const resolveErrors: ResolveError[] = []
  const rapidApiKey = await resolveKey(userId, 'RAPIDAPI_KEY')

  // 1) Anything already downloaded for this user
  for (const p of parsed) {
    const cached = await one<{
      content_id: string
      content_url: string
      video_url: string | null
      thumbnail_url: string | null
      views: number
      likes: number
    }>(
      `SELECT content_id, content_url, video_url, thumbnail_url, views, likes
         FROM discovery_items
        WHERE user_id = $1 AND lower(content_id) = lower($2)
          AND video_url IS NOT NULL
        LIMIT 1`,
      [userId, p.shortCode],
    )
    // A cached link with no sound (an earlier video-only download) is not reused —
    // falling through re-resolves it with its audio track. Unprobeable stays as before.
    if (cached?.video_url && isPlayableVideoUrl(cached.video_url)
      && (await videoHasAudio(cached.video_url)) !== false) {
      resolved.set(p.shortCode.toLowerCase(), {
        id: cached.content_id,
        permalink: cached.content_url || p.permalink,
        videoUrl: cached.video_url,
        thumbnailUrl: cached.thumbnail_url,
        views: cached.views,
        likes: cached.likes,
      })
      continue
    }

    const dl = await one<{
      shortcode: string
      permalink: string
      video_url: string
      thumbnail_url: string | null
      views: number
      likes: number
    }>(
      `SELECT shortcode, permalink, video_url, thumbnail_url, views, likes
         FROM ig_downloader_reels
        WHERE user_id = $1 AND lower(shortcode) = lower($2)
          AND video_url IS NOT NULL AND video_url <> ''
        LIMIT 1`,
      [userId, p.shortCode],
    )
    if (dl?.video_url && isPlayableVideoUrl(dl.video_url)
      && (await videoHasAudio(dl.video_url)) !== false) {
      resolved.set(p.shortCode.toLowerCase(), {
        id: dl.shortcode,
        permalink: dl.permalink || p.permalink,
        videoUrl: dl.video_url,
        thumbnailUrl: dl.thumbnail_url,
        views: dl.views,
        likes: dl.likes,
      })
    }
  }

  // 2) The providers, for whatever the cache did not have.
  const missing = parsed.filter(p => !resolved.has(p.shortCode.toLowerCase()))
  const apifyEnabled = !!process.env.APIFY_API_KEY
  const { resolved: found, attempts }: ChainOutcome = missing.length
    ? await runReelProviderChain(
        missing.map(p => ({ shortCode: p.shortCode, permalink: p.permalink })),
        { apifyEnabled, rapidApiKey, sourceUsername, listLimit: LIST_LIMIT, retryDelayMs: 4_000 },
        PROVIDERS,
      )
    : { resolved: new Map(), attempts: new Map() }
  for (const p of missing) {
    const hit = found.get(p.shortCode.toLowerCase())
    if (!hit) continue
    const m = hit.metadata ?? {}
    resolved.set(p.shortCode.toLowerCase(), {
      id: m.shortCode ?? p.shortCode,
      permalink: m.permalink ?? p.permalink,
      videoUrl: hit.videoUrl,
      thumbnailUrl: m.thumbnailUrl ?? null,
      views: m.views ?? 0,
      likes: m.likes ?? 0,
      comments: m.comments ?? 0,
      postedAt: m.postedAt ?? null,
    })
    if (hit.provider !== 'apify') console.log(`[reel-source] ${p.shortCode} resolved by ${hit.provider}`)
  }

  const failures = parsed
    .filter(p => !resolved.has(p.shortCode.toLowerCase()))
    .map(p => {
      const tried = attempts.get(p.shortCode.toLowerCase()) ?? []
      console.warn(`[reel-source] ${p.shortCode} not resolved: ${tried.map(f => `${f.provider} ${f.errorType}`).join(' → ') || 'no provider ran'}`)
      return { permalink: p.permalink, failure: finalReelFailure(tried) }
    })
  for (const { permalink, failure } of failures) {
    resolveErrors.push({ permalink, error: `${failure.errorType}: ${describeReelFailure(failure)}` })
  }

  const reels = [...resolved.values()]
  if (!reels.length) {
    const apifyDown = !apifyEnabled
    if (apifyDown && !rapidApiKey) {
      throw new EnqueueUrlsError(
        'Could not fetch that reel. No reel fetcher configured — set APIFY_API_KEY or add a RapidAPI key in Settings.',
        502,
        { resolveErrors, invalid, apifyDown },
      )
    }
    // One reason for the whole batch only when every reel shares it.
    const types = [...new Set(failures.map(f => f.failure.errorType))]
    const reason = types.length === 1 ? types[0] : undefined
    const message = failures.length === 1 || reason
      ? `Could not fetch that reel. ${describeReelFailure(failures[0].failure)}`
      : `Could not fetch those reels: ${types.map(t => `${failures.filter(f => f.failure.errorType === t).length} ${t}`).join(', ')}.`
    throw new EnqueueUrlsError(message, 502, { resolveErrors, invalid, apifyDown, reason, failures })
  }

  for (const reel of reels) {
    try {
      await query(
        `INSERT INTO ig_downloader_reels
           (user_id, username, shortcode, permalink, video_url, thumbnail_url, views, likes, comments, posted_at, source, scraped_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,'rapidapi', now())
         ON CONFLICT (user_id, shortcode) DO UPDATE SET
           video_url = COALESCE(EXCLUDED.video_url, ig_downloader_reels.video_url),
           thumbnail_url = COALESCE(EXCLUDED.thumbnail_url, ig_downloader_reels.thumbnail_url),
           scraped_at = now()`,
        [
          userId,
          sourceUsername ?? username, // column is NOT NULL — fall back to the label
          reel.id,
          reel.permalink,
          reel.videoUrl ?? null,
          reel.thumbnailUrl ?? null,
          reel.views ?? 0,
          reel.likes ?? 0,
          reel.comments ?? 0,
          reel.postedAt ?? null,
        ],
      )
    } catch {
      /* cache write is best-effort */
    }
  }

  return {
    reels,
    resolveErrors,
    invalid,
    username,
    sourceUsername,
    truncated: parseReelUrlList(rawText, MAX_URLS + 1).parsed.length > MAX_URLS,
  }
}

export interface EnqueueUrlsResult {
  ids: string[]
  enqueued: number
  resolved: number
  resolveErrors: ResolveError[]
  invalid: string[]
  sourceUsername: string | null
  characterProfile: string
  truncated: boolean
}

export async function enqueueReelUrlsForUser(opts: {
  userId: string
  /** Newline/whitespace separated reel links. */
  rawText: string
  username?: string | null
  sourceUsername?: string | null
  referenceImageUrl?: string | null
  /**
   * Called once background classification finishes, with the ids that
   * succeeded. Replication itself is queued separately, synchronously,
   * wherever the caller decides to act on this (e.g. a confirm button) —
   * see scheduleAutoClassify for why it does not happen automatically here.
   */
  onClassified?: (r: { classifiedIds: string[]; failed: number }) => Promise<void>
}): Promise<EnqueueUrlsResult> {
  const { userId, rawText } = opts
  const referenceImageUrl = String(opts.referenceImageUrl ?? '').trim() || null

  const { reels, resolveErrors, invalid, username, sourceUsername, truncated } =
    await resolveReelUrls(opts)

  const result = await enqueueDiscoveryReels(userId, username, reels, { referenceImageUrl })
  scheduleAutoClassify(userId, result.ids, { onClassified: opts.onClassified })

  return {
    ids: result.ids,
    enqueued: result.ids.length,
    resolved: reels.length,
    resolveErrors,
    invalid,
    sourceUsername,
    characterProfile: username,
    truncated,
  }
}
