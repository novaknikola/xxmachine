import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { rows, query, one } from '@/lib/db'
import { resolveKey } from '@/lib/user-keys'
import { calculateViralityScore, calculateVelocity } from '@/lib/virality'

const INSTAGRAM_HOST = 'instagram-scraper-stable-api.p.rapidapi.com'
const TIKTOK_HOST    = 'tiktok-scraper7.p.rapidapi.com'

export async function POST(req: NextRequest) {
  const user = await requireUser(req)
  if (user instanceof NextResponse) return user

  const { profile_id } = await req.json()

  const rapidApiKey = await resolveKey(user.id, 'RAPIDAPI_KEY')
  if (!rapidApiKey) return NextResponse.json({ error: 'RAPIDAPI_KEY not set in Content Engine settings' }, { status: 400 })

  // Get profile
  const profile = await one<{
    id: string; platform: string; username: string
    min_score: number; max_age_days: number
  }>(
    `select * from tracked_profiles where id = $1 and user_id = $2`,
    [profile_id, user.id],
  )
  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })

  let added = 0
  try {
    if (profile.platform === 'Instagram') {
      added = await scanInstagram(user.id, profile, rapidApiKey)
    } else if (profile.platform === 'TikTok') {
      added = await scanTikTok(user.id, profile, rapidApiKey)
    }

    await query(
      `update tracked_profiles set last_scanned_at = now(), reels_found = $3 where id = $1 and user_id = $2`,
      [profile_id, user.id, added],
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  return NextResponse.json({ ok: true, added })
}

async function scanInstagram(
  userId: string,
  profile: { id: string; username: string; min_score: number; max_age_days: number },
  apiKey: string,
): Promise<number> {
  const followers = await fetchIgFollowers(profile.username, apiKey)

  const res = await fetch(`https://${INSTAGRAM_HOST}/get_ig_user_reels.php`, {
    method: 'POST',
    headers: {
      'x-rapidapi-key':  apiKey,
      'x-rapidapi-host': INSTAGRAM_HOST,
      'Content-Type':    'application/x-www-form-urlencoded',
    },
    body: `username_or_url=${encodeURIComponent(profile.username)}&amount=12`,
  })
  const data = await res.json()
  const items: unknown[] = data?.result?.reels ?? data?.result?.items ?? data?.reels ?? data?.items ?? []

  let added = 0
  for (const item of items) {
    const meta = extractIgMeta(item as Record<string, unknown>, profile.username)
    if (!meta) continue

    const ageDays = (Date.now() - meta.postedAt.getTime()) / 86_400_000
    if (ageDays > profile.max_age_days) continue

    const score = calculateViralityScore({ ...meta, followers, postedAt: meta.postedAt })
    if (score < profile.min_score) continue

    const inserted = await upsertDiscovery(userId, 'Instagram', profile.username, meta, followers, score)
    if (inserted) added++
    if (meta.audioId) await upsertAudio(userId, meta.audioId, meta.audioName, 'Instagram')
  }
  return added
}

async function scanTikTok(
  userId: string,
  profile: { id: string; username: string; min_score: number; max_age_days: number },
  apiKey: string,
): Promise<number> {
  const infoRes = await fetch(
    `https://${TIKTOK_HOST}/user/info?uniqueId=${encodeURIComponent(profile.username)}`,
    { headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': TIKTOK_HOST } },
  )
  const infoData = await infoRes.json()
  const followers = infoData?.userInfo?.stats?.followerCount ?? infoData?.data?.stats?.followerCount ?? 1

  const postsRes = await fetch(
    `https://${TIKTOK_HOST}/user/posts?uniqueId=${encodeURIComponent(profile.username)}&count=12&cursor=0`,
    { headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': TIKTOK_HOST } },
  )
  const postsData = await postsRes.json()
  const items: unknown[] = postsData?.data?.videos ?? postsData?.itemList ?? postsData?.data?.itemList ?? []

  let added = 0
  for (const item of items) {
    const meta = extractTikTokMeta(item as Record<string, unknown>, profile.username)
    if (!meta) continue

    const ageDays = (Date.now() - meta.postedAt.getTime()) / 86_400_000
    if (ageDays > profile.max_age_days) continue

    const score = calculateViralityScore({ ...meta, followers, postedAt: meta.postedAt })
    if (score < profile.min_score) continue

    const inserted = await upsertDiscovery(userId, 'TikTok', profile.username, meta, followers, score)
    if (inserted) added++
    if (meta.audioId) await upsertAudio(userId, meta.audioId, meta.audioName, 'TikTok')
  }
  return added
}

async function fetchIgFollowers(username: string, apiKey: string): Promise<number> {
  try {
    const res = await fetch(`https://${INSTAGRAM_HOST}/get_ig_user_info.php`, {
      method: 'POST',
      headers: {
        'x-rapidapi-key':  apiKey,
        'x-rapidapi-host': INSTAGRAM_HOST,
        'Content-Type':    'application/x-www-form-urlencoded',
      },
      body: `username_or_url=${encodeURIComponent(username)}`,
    })
    const data = await res.json()
    return data?.result?.follower_count ?? data?.follower_count ?? 1
  } catch { return 1 }
}

function extractIgMeta(item: Record<string, unknown>, username: string) {
  try {
    const contentId = String(item.id ?? item.pk ?? item.shortcode ?? '')
    if (!contentId) return null
    const shortcode = String(item.shortcode ?? item.code ?? contentId)
    const url       = `https://www.instagram.com/reel/${shortcode}/`
    const views     = Number(item.view_count ?? item.play_count ?? item.video_view_count ?? 0)
    const likes     = Number(item.like_count ?? 0)
    const comments  = Number(item.comment_count ?? 0)
    const takenAt   = Number(item.taken_at ?? Math.floor(Date.now() / 1000))
    const postedAt  = new Date(takenAt * 1000)
    const audio     = (item.music_info ?? (item.clips_metadata as Record<string, unknown>)?.music_info ?? {}) as Record<string, unknown>
    const audioId   = String(audio.music_canonical_id ?? audio.id ?? '')
    const audioName = String(audio.song_name ?? audio.title ?? '').slice(0, 100)
    return { contentId, url, views, likes, comments, postedAt, audioId, audioName }
  } catch { return null }
}

function extractTikTokMeta(item: Record<string, unknown>, username: string) {
  try {
    const contentId = String(item.id ?? item.createTime ?? '')
    if (!contentId) return null
    const url       = `https://www.tiktok.com/@${username}/video/${contentId}`
    const stats     = (item.stats ?? item.statistics ?? {}) as Record<string, unknown>
    const views     = Number(stats.playCount ?? stats.views ?? item.playCount ?? 0)
    const likes     = Number(stats.diggCount ?? stats.likes ?? item.diggCount ?? 0)
    const comments  = Number(stats.commentCount ?? stats.comments ?? item.commentCount ?? 0)
    const postedAt  = item.createTime ? new Date(Number(item.createTime) * 1000) : new Date()
    const music     = (item.music ?? item.musicInfo ?? {}) as Record<string, unknown>
    const audioId   = String(music.id ?? music.musicId ?? '')
    const audioName = String(music.title ?? music.musicName ?? '').slice(0, 100)
    return { contentId, url, views, likes, comments, postedAt, audioId, audioName }
  } catch { return null }
}

async function upsertDiscovery(
  userId: string,
  platform: string,
  profile: string,
  meta: { contentId: string; url: string; views: number; likes: number; comments: number; postedAt: Date; audioId: string; audioName: string },
  followers: number,
  score: number,
): Promise<boolean> {
  const velocity = calculateVelocity(meta.views, meta.postedAt)
  const r = await one<{ id: string }>(
    `insert into discovery_items
       (user_id, platform, profile, content_url, content_id,
        views, likes, comments, followers, score, velocity,
        audio_name, audio_id, posted_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     on conflict (user_id, content_id) do nothing
     returning id`,
    [userId, platform, profile, meta.url, meta.contentId,
     meta.views, meta.likes, meta.comments, followers, score, velocity,
     meta.audioName || null, meta.audioId || null, meta.postedAt],
  )
  return !!r
}

async function upsertAudio(userId: string, audioId: string, audioName: string, platform: string) {
  await query(
    `insert into trending_audios (user_id, audio_id, audio_name, platform)
     values ($1,$2,$3,$4)
     on conflict (user_id, audio_id) do update
       set count_48h = trending_audios.count_48h + 1,
           last_seen_at = now(),
           status = case
             when trending_audios.count_48h + 1 >= 5 then 'TRENDING'
             when trending_audios.count_48h + 1 >= 3 then 'RISING'
             else 'RISING'
           end`,
    [userId, audioId, audioName || null, platform],
  )
}
