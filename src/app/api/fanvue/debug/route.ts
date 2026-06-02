import { NextRequest, NextResponse } from 'next/server'

const API_BASE = 'https://api.fanvue.com'
const API_VERSION = '2025-06-26'
const CLIENT_ID = process.env.FANVUE_CLIENT_ID!

interface ProbeResult {
  url: string
  status: number
  ok: boolean
  bodyPreview: unknown
  contentType: string | null
}

async function probe(url: string, accessToken: string): Promise<ProbeResult> {
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Fanvue-API-Version': API_VERSION,
      },
    })
    const contentType = res.headers.get('content-type')
    let bodyPreview: unknown
    if (contentType?.includes('application/json')) {
      bodyPreview = await res.json().catch(() => null)
    } else {
      const txt = await res.text().catch(() => '')
      bodyPreview = txt.slice(0, 500)
    }
    return { url, status: res.status, ok: res.ok, bodyPreview, contentType }
  } catch (err) {
    return {
      url,
      status: 0,
      ok: false,
      bodyPreview: { error: err instanceof Error ? err.message : 'fetch failed' },
      contentType: null,
    }
  }
}

export async function GET(req: NextRequest) {
  const accessToken = req.cookies.get('fv_access_token')?.value
  if (!accessToken) {
    return NextResponse.json(
      { error: 'not_authenticated', authUrl: '/api/fanvue/auth' },
      { status: 401 },
    )
  }

  // 1. App subscription status (this tells us if the app is "active" or in sandbox)
  const appStatus = await probe(`${API_BASE}/apps/${CLIENT_ID}/subscription-status`, accessToken)

  // 2. Who am I?
  const me = await probe(`${API_BASE}/users/me`, accessToken)

  // 3. First page of subscribers (only 3 to keep payload small)
  const subscribersUrl = `${API_BASE}/subscribers?page=1&size=3`
  const subscribers = await probe(subscribersUrl, accessToken)

  // 3. Insights for the first subscriber if any
  let firstInsight: ProbeResult | null = null
  let firstUuid: string | undefined
  if (
    subscribers.ok
    && subscribers.bodyPreview
    && typeof subscribers.bodyPreview === 'object'
    && Array.isArray((subscribers.bodyPreview as { data?: unknown[] }).data)
  ) {
    const first = (subscribers.bodyPreview as { data: Array<{ uuid?: string }> }).data[0]
    firstUuid = first?.uuid
    if (firstUuid) {
      firstInsight = await probe(`${API_BASE}/insights/fans/${firstUuid}`, accessToken)
    }
  }

  return NextResponse.json({
    apiVersion: API_VERSION,
    clientId: CLIENT_ID,
    accessTokenLength: accessToken.length,
    accessTokenPrefix: accessToken.slice(0, 10) + '…',
    appStatus,
    me,
    subscribers,
    firstUuid,
    firstInsight,
  })
}
