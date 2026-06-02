import { NextRequest, NextResponse } from 'next/server'
import type { FanvueHydration } from '@/lib/fans'
import {
  FANVUE_API_BASE,
  getFanvueAccessToken,
  applyCookies,
  fanvueFetch,
} from '@/lib/fanvue-server'

interface FanvueSubscriber {
  uuid?: string
  id?: string
  handle?: string
  displayName?: string
  nickname?: string
  avatarUrl?: string
  isTopSpender?: boolean
  registeredAt?: string
}

interface FanvueInsightsResponse {
  status?: 'subscriber' | 'expired' | 'follower' | 'not_contactable'
  spending?: {
    lastPurchaseAt?: string | null
    total?: { gross?: number }
    maxSinglePayment?: { gross?: number }
    sources?: Record<string, { gross?: number }>
  }
  subscription?: {
    createdAt?: string | null
    renewsAt?: string | null
    autoRenewalEnabled?: boolean
  }
}

function flattenSources(
  sources: Record<string, { gross?: number }> | undefined,
): Record<string, number> | undefined {
  if (!sources || typeof sources !== 'object') return undefined
  const out: Record<string, number> = {}
  for (const [key, val] of Object.entries(sources)) {
    if (val && typeof val.gross === 'number') out[key] = val.gross
  }
  return Object.keys(out).length ? out : undefined
}

// GET — quick connection status check (does NOT touch the API)
export async function GET(req: NextRequest) {
  const access = req.cookies.get('fv_access_token')?.value
  const refresh = req.cookies.get('fv_refresh_token')?.value
  const expiresAt = Number(req.cookies.get('fv_expires_at')?.value ?? 0)
  const connected = !!(access && Date.now() < expiresAt) || !!refresh
  return NextResponse.json({ connected })
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// POST — perform sync
export async function POST(req: NextRequest) {
  const { accessToken, cookieDeltas } = await getFanvueAccessToken(req)
  if (!accessToken) {
    return NextResponse.json(
      { error: 'not_authenticated', authUrl: '/api/fanvue/auth' },
      { status: 401 },
    )
  }

  // 1. Pull all subscribers, paginated, with rate-limit awareness
  const subscribers: FanvueSubscriber[] = []
  let page = 1
  const PAGE_SIZE = 50
  while (page <= 50) {
    const u = new URL(`${FANVUE_API_BASE}/subscribers`)
    u.searchParams.set('page', String(page))
    u.searchParams.set('size', String(PAGE_SIZE))
    const r = await fanvueFetch(u.toString(), accessToken)
    if (r.status === 429) {
      const res = NextResponse.json({
        error: 'rate_limited',
        detail: 'Fanvue rate limit hit while listing subscribers. Try again in a minute.',
      }, { status: 429 })
      applyCookies(res, cookieDeltas)
      return res
    }
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      const res = NextResponse.json(
        { error: 'subscribers_failed', status: r.status, detail: body.slice(0, 300) },
        { status: 502 },
      )
      applyCookies(res, cookieDeltas)
      return res
    }
    const data = await r.json() as {
      data?: FanvueSubscriber[]
      pagination?: { hasMore?: boolean; page?: number; size?: number }
    }
    const items = data.data ?? []
    subscribers.push(...items)
    if (!data.pagination?.hasMore || items.length === 0) break
    page++
    await sleep(150) // gentle pacing between subscriber pages
  }

  // 2. Hydrate each subscriber with insights — small concurrent batches with delays
  const hydrations: FanvueHydration[] = []
  const BATCH = 3
  const BATCH_DELAY_MS = 250
  let rateLimited = false
  for (let i = 0; i < subscribers.length; i += BATCH) {
    if (rateLimited) break
    const slice = subscribers.slice(i, i + BATCH)
    const results = await Promise.all(
      slice.map(async (sub): Promise<FanvueHydration | null> => {
        const uuid = sub.uuid ?? sub.id
        if (!uuid) return null
        try {
          const r = await fanvueFetch(`${FANVUE_API_BASE}/insights/fans/${uuid}`, accessToken)
          if (r.status === 429) {
            rateLimited = true
            return {
              uuid,
              handle: sub.handle,
              displayName: sub.displayName ?? sub.nickname ?? sub.handle ?? 'Unknown',
              lifetimeGrossCents: 0,
              isTopSpender: sub.isTopSpender,
            }
          }
          if (!r.ok) {
            return {
              uuid,
              handle: sub.handle,
              displayName: sub.displayName ?? sub.nickname ?? sub.handle ?? 'Unknown',
              lifetimeGrossCents: 0,
              isTopSpender: sub.isTopSpender,
            }
          }
          const ins = await r.json() as FanvueInsightsResponse
          return {
            uuid,
            handle: sub.handle,
            displayName: sub.displayName ?? sub.nickname ?? sub.handle ?? 'Unknown',
            status: ins.status,
            lifetimeGrossCents: ins.spending?.total?.gross ?? 0,
            maxSinglePaymentCents: ins.spending?.maxSinglePayment?.gross,
            spendingSources: flattenSources(ins.spending?.sources),
            lastPurchaseAt: ins.spending?.lastPurchaseAt ?? undefined,
            subscriptionCreatedAt: ins.subscription?.createdAt ?? undefined,
            subscriptionRenewsAt: ins.subscription?.renewsAt ?? undefined,
            autoRenewalEnabled: ins.subscription?.autoRenewalEnabled,
            isTopSpender: sub.isTopSpender,
          }
        } catch {
          return null
        }
      }),
    )
    for (const r of results) if (r) hydrations.push(r)
    if (i + BATCH < subscribers.length) await sleep(BATCH_DELAY_MS)
  }

  const res = NextResponse.json({
    ok: true,
    count: hydrations.length,
    total: subscribers.length,
    partial: rateLimited,
    hydrations,
    syncedAt: new Date().toISOString(),
  })
  applyCookies(res, cookieDeltas)
  return res
}

// DELETE — disconnect (clear cookies)
export async function DELETE() {
  const res = NextResponse.json({ ok: true })
  for (const name of ['fv_access_token', 'fv_refresh_token', 'fv_expires_at', 'fv_connected']) {
    res.cookies.delete(name)
  }
  return res
}
