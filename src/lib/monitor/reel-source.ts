/**
 * Where a pasted reel's video comes from, provider by provider. Anonymous Apify
 * goes first (cheap, sees every public reel); only what it could not see goes
 * to the authenticated Apify actor (Intropix); the older anonymous RapidAPI and
 * profile-listing fallbacks follow where they can still help. Every step
 * answers with a classified result, so a failure says WHY — age-gated, not a
 * video, out of quota — instead of a blanket "could not fetch".
 *
 * Access only: permalink → media URL. Turning that URL into a checked copy in
 * our storage is reel-download.ts.
 */
import type { ApifyReel, IntropixPost } from '@/lib/instagram-scrape'
import { parseReelUrl } from './parse-reel-url'
import { isPlayableVideoUrl } from './video-url'

export type ReelSourceErrorType =
  | 'ACCESS_RESTRICTED'
  | 'NOT_VIDEO'
  | 'NOT_FOUND'
  /** One provider's own quota: Intropix's free capacity, a RapidAPI plan. */
  | 'QUOTA'
  /** The shared Apify account's monthly limit — every Apify actor stops at once, Intropix included. */
  | 'ACCOUNT_QUOTA'
  | 'PROVIDER_DOWN'
  | 'TIMEOUT'
  | 'INVALID'
  | 'UNKNOWN'

export type ReelProviderName = 'apify' | 'intropix' | 'rapidapi' | 'profile-list' | 'apify-retry'

export interface ReelMetadata {
  permalink?: string
  shortCode?: string
  thumbnailUrl?: string | null
  views?: number
  likes?: number
  comments?: number
  postedAt?: string | null
  durationSec?: number
  width?: number
  height?: number
}

export interface ReelSourceSuccess {
  ok: true
  provider: ReelProviderName
  videoUrl: string
  mediaType: 'video'
  metadata?: ReelMetadata
}

export interface ReelSourceFailure {
  ok: false
  provider: ReelProviderName
  errorType: ReelSourceErrorType
  /** Whether the same provider might answer differently later. */
  retryable: boolean
  detail?: string
}

export type ReelSourceResult = ReelSourceSuccess | ReelSourceFailure

function fail(provider: ReelProviderName, errorType: ReelSourceErrorType, retryable: boolean, detail?: string): ReelSourceFailure {
  return { ok: false, provider, errorType, retryable, ...(detail ? { detail: detail.slice(0, 300) } : {}) }
}

/** A provider call that threw: which kind of trouble it was. */
export function classifyProviderError(provider: ReelProviderName, err: unknown): ReelSourceFailure {
  const msg = err instanceof Error ? err.message : String(err)
  // Apify's own wording for a spent plan is "Monthly usage hard limit exceeded"
  // (type platform-feature-disabled). That is the ACCOUNT's limit, shared by the
  // anonymous actor and Intropix alike, so neither can stand in for the other.
  if (/monthly usage hard limit|platform-feature-disabled/i.test(msg)) return fail(provider, 'ACCOUNT_QUOTA', false, msg)
  // One provider's own quota: Intropix refuses a full free tier with
  // free_capacity_exhausted; RapidAPI answers 429.
  if (/free_capacity_exhausted|usage limit|\b402\b|\b429\b|exceeded the .*quota|out of requests|insufficient credit/i.test(msg)) {
    return fail(provider, 'QUOTA', false, msg)
  }
  if (/timed? ?out|TimeoutError|aborted due to timeout|ETIMEDOUT/i.test(msg)) return fail(provider, 'TIMEOUT', true, msg)
  if (/Apify run failed|failed to start|HTTP 5\d\d|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|undergoing an upgrade|service unavailable/i.test(msg)) {
    return fail(provider, 'PROVIDER_DOWN', true, msg)
  }
  return fail(provider, 'UNKNOWN', true, msg)
}

/** An item a provider delivered with an error instead of media. Null when it carries none. */
function classifyItemError(provider: ReelProviderName, error?: string, description?: string): ReelSourceFailure | null {
  const text = [error, description].filter(Boolean).join(': ').trim()
  if (!text) return null
  if (/free_capacity_exhausted|usage limit|quota/i.test(text)) return fail(provider, 'QUOTA', false, text)
  // `restricted_page` (a gated post) and "Restricted profile" (a gated account)
  // are Instagram refusing an anonymous viewer; private accounts the same.
  if (/restrict|\bage\b|age[-_ ]?(gate|limit|restrict)|login|private/i.test(text)) return fail(provider, 'ACCESS_RESTRICTED', false, text)
  if (/not.?found|no.?items|does not exist|deleted/i.test(text)) return fail(provider, 'NOT_FOUND', false, text)
  return fail(provider, 'UNKNOWN', true, text)
}

function apifyMetadata(item: ApifyReel): ReelMetadata {
  return {
    permalink: item.url,
    shortCode: item.shortCode,
    thumbnailUrl: item.displayUrl ?? item.images?.[0] ?? null,
    views: item.videoViewCount ?? item.videoPlayCount ?? 0,
    likes: item.likesCount ?? 0,
    comments: item.commentsCount ?? 0,
    postedAt: item.timestamp ?? null,
  }
}

/** One item from apify~instagram-scraper (posts or listing mode). */
export function classifyApifyItem(item: ApifyReel, provider: ReelProviderName = 'apify'): ReelSourceResult {
  if (item.videoUrl && isPlayableVideoUrl(item.videoUrl)) {
    return { ok: true, provider, videoUrl: item.videoUrl, mediaType: 'video', metadata: apifyMetadata(item) }
  }
  const byError = classifyItemError(provider, item.error, item.errorDescription)
  if (byError) return byError
  if (item.videoUrl) return fail(provider, 'INVALID', true, 'the video link is not a media file')
  if (item.type && item.type !== 'Video') return fail(provider, 'NOT_VIDEO', false, `Instagram post type ${item.type}`)
  return fail(provider, 'NOT_FOUND', true, 'item has no video')
}

/** One post from intropix~instagram-posts-reels-scraper. */
export function classifyIntropixPost(post: IntropixPost): ReelSourceResult {
  const byError = classifyItemError('intropix', post.error, post.errorDescription)
  if (byError) return byError
  const media = post.media?.[0]
  if (!media) return fail('intropix', 'UNKNOWN', true, 'post has no media')
  if (post.post_type !== 'reel' || media.media_type !== 'video') {
    return fail('intropix', 'NOT_VIDEO', false, `post_type ${post.post_type ?? '?'}, media ${media.media_type ?? '?'}`)
  }
  if (!media.media_url) return fail('intropix', 'UNKNOWN', true, 'video has no media_url')
  if (!isPlayableVideoUrl(media.media_url)) return fail('intropix', 'INVALID', true, 'media_url is not a media file')
  return {
    ok: true,
    provider: 'intropix',
    videoUrl: media.media_url,
    mediaType: 'video',
    metadata: {
      permalink: post.permalink,
      shortCode: post.shortcode,
      thumbnailUrl: media.cover_url ?? null,
      views: post.view_count ?? 0,
      likes: post.like_count ?? 0,
      comments: post.comment_count ?? 0,
      postedAt: post.taken_at ?? null,
      durationSec: media.video_duration,
      width: media.width,
      height: media.height,
    },
  }
}

export interface ReelRef {
  shortCode: string
  permalink: string
}

/** The providers the chain calls — real ones in production, fakes in tests. */
export interface ReelProviders {
  /** apify~instagram-scraper, posts mode; keyed by lowercased shortcode. Throws on a provider-level failure. */
  apifyAnonymous(permalinks: string[]): Promise<Map<string, ApifyReel>>
  /** intropix~instagram-posts-reels-scraper. Throws on a provider-level failure. */
  intropix(permalinks: string[]): Promise<IntropixPost[]>
  rapidApi(permalink: string, apiKey: string): Promise<{ videoUrl: string; thumbnail: string | null; likes: number | null; views: number | null }>
  /** `skipApify`: the shared Apify account is spent — list through RapidAPI only. */
  listProfile(username: string, limit: number, rapidApiKey: string | null, opts?: { skipApify?: boolean }): Promise<{ reels: ApifyReel[] }>
  /** Joins Instagram's separate audio track onto a listed reel when it has one. */
  ensureAudio(reel: ApifyReel): Promise<ApifyReel>
  sleep(ms: number): Promise<void>
}

export interface ChainContext {
  /** APIFY_API_KEY is set — both Apify actors run on it. */
  apifyEnabled: boolean
  rapidApiKey: string | null
  /** A real owner handle, the only thing the profile listing can use. */
  sourceUsername: string | null
  listLimit: number
  retryDelayMs: number
}

export interface ChainOutcome {
  /** Keyed by lowercased shortcode. */
  resolved: Map<string, ReelSourceSuccess>
  /** Every failed attempt per reel, in order. */
  attempts: Map<string, ReelSourceFailure[]>
}

/**
 * Runs the providers for reels the cache did not have. Anonymous Apify sees
 * every reel first; only what it could not see goes on to the authenticated
 * actor, one run per reel; the anonymous RapidAPI and listing fallbacks take
 * what is left. A known restriction or a photo is never retried through the
 * same anonymous path — that only spends money on the same answer — and once
 * the shared Apify account is over its limit no Apify actor is asked again.
 */
export async function runReelProviderChain(
  reels: ReelRef[],
  ctx: ChainContext,
  p: ReelProviders,
): Promise<ChainOutcome> {
  const key = (r: ReelRef) => r.shortCode.toLowerCase()
  const resolved = new Map<string, ReelSourceSuccess>()
  const attempts = new Map<string, ReelSourceFailure[]>(reels.map(r => [key(r), []]))
  const missing = () => reels.filter(r => !resolved.has(key(r)))
  const record = (r: ReelRef, res: ReelSourceResult) => {
    if (res.ok) resolved.set(key(r), res)
    else attempts.get(key(r))!.push(res)
  }
  const saw = (r: ReelRef, t: ReelSourceErrorType) => attempts.get(key(r))!.some(f => f.errorType === t)
  // A photo stays a photo whoever is asked.
  const settled = (r: ReelRef) => saw(r, 'NOT_VIDEO')
  // Once the shared Apify account is over its monthly limit no Apify actor can
  // start — Intropix, the listing run and the retry included — so none is asked.
  const apifyAccountSpent = () => [...attempts.values()].some(fs => fs.some(f => f.errorType === 'ACCOUNT_QUOTA'))

  // 1. Anonymous Apify, one run for the batch.
  let apifyFailure: ReelSourceFailure | null = null
  if (ctx.apifyEnabled && missing().length) {
    const batch = missing()
    try {
      const byCode = await p.apifyAnonymous(batch.map(r => r.permalink))
      for (const r of batch) {
        const item = byCode.get(key(r))
        record(r, item ? classifyApifyItem(item) : fail('apify', 'NOT_FOUND', true, 'no item for this reel'))
      }
    } catch (err) {
      apifyFailure = classifyProviderError('apify', err)
      for (const r of batch) record(r, apifyFailure)
    }
  }

  // 2. The authenticated actor — only for what anonymous Apify could not see,
  // one run per reel. A spent or broken provider is not asked again this pass,
  // and a spent Apify account is not asked at all.
  if (ctx.apifyEnabled && !apifyAccountSpent()) {
    let intropixDown: ReelSourceFailure | null = null
    for (const r of missing()) {
      if (settled(r)) continue
      if (intropixDown) { record(r, intropixDown); continue }
      try {
        const posts = await p.intropix([r.permalink])
        const post = posts.find(x => {
          const code = x.shortcode ?? (x.permalink ? parseReelUrl(x.permalink)?.shortCode : undefined)
          return code?.toLowerCase() === key(r)
        }) ?? (posts.length === 1 && !posts[0].shortcode ? posts[0] : undefined)
        const res = post ? classifyIntropixPost(post) : fail('intropix', 'NOT_FOUND', false, 'no post returned')
        record(r, res)
        if (!res.ok && res.errorType === 'QUOTA') intropixDown = res
      } catch (err) {
        const f = classifyProviderError('intropix', err)
        record(r, f)
        if (f.errorType === 'QUOTA' || f.errorType === 'ACCOUNT_QUOTA' || f.errorType === 'PROVIDER_DOWN') intropixDown = f
      }
    }
  }

  // 3. RapidAPI downloaders, per reel — anonymous too, kept for what is still
  // missing (they also cover an Apify outage).
  if (ctx.rapidApiKey) {
    let rapidQuota: ReelSourceFailure | null = null
    for (const r of missing()) {
      if (settled(r)) continue
      if (rapidQuota) { record(r, rapidQuota); continue }
      try {
        const x = await p.rapidApi(r.permalink, ctx.rapidApiKey)
        record(r, isPlayableVideoUrl(x.videoUrl)
          ? {
              ok: true,
              provider: 'rapidapi',
              videoUrl: x.videoUrl,
              mediaType: 'video',
              metadata: { thumbnailUrl: x.thumbnail, views: x.views ?? 0, likes: x.likes ?? 0 },
            }
          : fail('rapidapi', 'INVALID', true, 'the video link is not a media file'))
      } catch (err) {
        const f = classifyProviderError('rapidapi', err)
        record(r, f)
        if (f.errorType === 'QUOTA') rapidQuota = f
      }
    }
  }

  // 4. The owner's profile listing — anonymous, so useless for a reel Instagram
  // already gated (it hides exactly those); only for the rest.
  const listable = missing().filter(r => !settled(r) && !saw(r, 'ACCESS_RESTRICTED'))
  const skipApify = apifyAccountSpent()
  if (listable.length && ctx.sourceUsername && ((ctx.apifyEnabled && !skipApify) || ctx.rapidApiKey)) {
    try {
      const { reels: listed } = await p.listProfile(ctx.sourceUsername, ctx.listLimit, ctx.rapidApiKey, { skipApify })
      // A gated account answers the listing with one error item ("Restricted profile").
      const gate = listed.find(x => x.error)
      const gateFailure = gate ? classifyItemError('profile-list', gate.error, gate.errorDescription) : null
      const byCode = new Map(listed.filter(x => x.shortCode).map(x => [x.shortCode!.toLowerCase(), x]))
      for (const r of listable) {
        const match = byCode.get(key(r))
        if (match) {
          await p.ensureAudio(match)
          record(r, classifyApifyItem(match, 'profile-list'))
        } else {
          record(r, gateFailure ?? fail('profile-list', 'NOT_FOUND', true,
            `@${ctx.sourceUsername}'s listing (${listed.length} reels) does not include it`))
        }
      }
    } catch (err) {
      const f = classifyProviderError('profile-list', err)
      for (const r of listable) record(r, f)
    }
  }

  // 5. One delayed anonymous retry, only for reels Apify answered with nothing at
  // all — it sometimes comes back empty for a public post that fetches fine
  // seconds later. Never for a known restriction or a photo.
  const retry = missing().filter(r =>
    attempts.get(key(r))!.some(f => f.provider === 'apify' && f.errorType === 'NOT_FOUND')
    && !saw(r, 'ACCESS_RESTRICTED') && !settled(r))
  if (ctx.apifyEnabled && !apifyFailure && !apifyAccountSpent() && retry.length) {
    await p.sleep(ctx.retryDelayMs)
    try {
      const byCode = await p.apifyAnonymous(retry.map(r => r.permalink))
      for (const r of retry) {
        const item = byCode.get(key(r))
        record(r, item ? classifyApifyItem(item, 'apify-retry') : fail('apify-retry', 'NOT_FOUND', false, 'no item on retry'))
      }
    } catch (err) {
      const f = classifyProviderError('apify-retry', err)
      for (const r of retry) record(r, f)
    }
  }

  return { resolved, attempts }
}

/** The failure that explains a reel best, with the anonymous verdict kept beside it. */
export interface FinalReelFailure extends ReelSourceFailure {
  /** What anonymous Apify said, when a later provider's verdict is the one reported. */
  primary?: ReelSourceFailure
}

/**
 * A photo is a photo; otherwise the authenticated actor's verdict decides when
 * it ran (it is the one that can open gated reels), then a spent Apify account
 * (the reason it did not run), then a known restriction, then whatever came first.
 */
export function finalReelFailure(failures: ReelSourceFailure[]): FinalReelFailure {
  if (!failures.length) return fail('apify', 'UNKNOWN', true)
  const notVideo = failures.find(f => f.errorType === 'NOT_VIDEO')
  if (notVideo) return notVideo
  const primary = failures.find(f => f.provider === 'apify')
  const intropix = failures.find(f => f.provider === 'intropix')
  if (intropix) return { ...intropix, primary }
  const account = failures.find(f => f.errorType === 'ACCOUNT_QUOTA')
  if (account) return { ...account, primary }
  const restricted = failures.find(f => f.errorType === 'ACCESS_RESTRICTED')
  if (restricted) return { ...restricted, primary }
  return { ...(primary ?? failures[0]), primary }
}

/** What the user is told — never "could not be downloaded" when no video was ever found. */
export function describeReelFailure(f: FinalReelFailure): string {
  const gated = f.errorType === 'ACCESS_RESTRICTED' || f.primary?.errorType === 'ACCESS_RESTRICTED'
  switch (f.errorType) {
    case 'ACCESS_RESTRICTED':
      return 'Instagram Reel is restricted/age-gated and the primary scraper could not access it.'
        + (f.provider === 'intropix' ? ` The authenticated fallback could not access it either${f.detail ? ` (${f.detail})` : ''}.` : '')
    case 'QUOTA':
      return 'Instagram scraper provider quota is exhausted'
        + ` (${f.provider})${gated ? ' — the Reel is restricted/age-gated and needs that fallback' : ''}.`
    case 'ACCOUNT_QUOTA':
      return 'Apify account monthly usage limit exhausted — no Apify scraper can run until the limit resets or the plan is raised.'
        + (gated ? ' The Reel is restricted/age-gated and needs the authenticated scraper, which runs on that account.' : '')
    case 'NOT_VIDEO':
      return 'The Instagram URL does not point to a downloadable video Reel.'
    case 'NOT_FOUND':
      return 'The Instagram Reel was not found — it may be deleted, private, or the link is wrong.'
    case 'PROVIDER_DOWN':
    case 'TIMEOUT':
      return `The Instagram scraper is unavailable right now (${f.provider}: ${f.errorType === 'TIMEOUT' ? 'timed out' : 'down'})`
        + `${gated ? ' — the Reel is restricted/age-gated and needs that fallback' : ''}. Try again later.`
    case 'INVALID':
      return `The Instagram scraper (${f.provider}) returned something that is not a video file.`
    default:
      return `The reel could not be fetched, and no provider said why${f.detail ? ` (${f.detail})` : ''}.`
  }
}
