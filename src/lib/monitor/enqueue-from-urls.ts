/**
 * Paste reel URLs → resolve to playable video URLs → enqueue for Copy-Paste.
 *
 * Lifted out of /api/monitor/enqueue-urls so the Telegram bot can run the same
 * path. That route authenticates with a session, which a webhook does not have,
 * so the caller passes the user id instead and the route stays a thin wrapper.
 */
import { query } from '@/lib/db'
import { enqueueDiscoveryReels } from './enqueue'
import { parseReelUrlList } from './parse-reel-url'
import { scheduleAutoClassify } from './auto-classify'
import { resolvePlayableReels } from './resolve-playable-reel'

export const MAX_URLS = 30

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
    },
  ) {
    super(message)
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
  const referenceImageUrl = String(opts.referenceImageUrl ?? '').trim() || null

  const { resolved, apifyError, quotaExhausted, hasRapidApiKey } = await resolvePlayableReels({
    userId,
    parsed,
    sourceUsername,
  })
  const resolveErrors: ResolveError[] = []

  for (const p of parsed.filter(p => !resolved.has(p.shortCode.toLowerCase()))) {
    resolveErrors.push({
      permalink: p.permalink,
      error: 'no playable video URL from download API or profile listing',
    })
  }

  const reels = [...resolved.values()]
  if (!reels.length) {
    // Prefer a concrete reason over a vague "try again" — usually RapidAPI
    // download outage + Apify quota + age-gated profile with empty listing.
    const apifyDown = !process.env.APIFY_API_KEY
    // Apify runs first now, so lead with its verdict. Blaming the RapidAPI quota
    // when Apify is the path that actually failed sends people to buy the wrong
    // upgrade — and vice versa once Apify is out of credit too.
    const detail = apifyDown && !hasRapidApiKey
      ? 'No reel fetcher configured — set APIFY_API_KEY or add a RapidAPI key in Settings.'
      : apifyError
        ? `Apify could not fetch it (${apifyError})${quotaExhausted ? ', and the RapidAPI fallback is out of monthly requests (HTTP 429)' : ''}.`
        : quotaExhausted
          // Named exactly, because the fix is a plan upgrade and no amount of
          // retrying or picking a different reel will help.
          ? 'Apify returned nothing for this reel and your RapidAPI fallback is out of requests for this month (HTTP 429). Upgrade the plan or wait for the quota to reset.'
          : 'The reel could not be fetched by Apify or the download API, and we could not list it from the source profile either (private and age-restricted accounts often return nothing).'
    throw new EnqueueUrlsError(`Could not fetch that reel. ${detail}`, 502, {
      resolveErrors,
      invalid,
      apifyDown,
    })
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
    truncated: parseReelUrlList(rawText, MAX_URLS + 1).parsed.length > MAX_URLS,
  }
}
