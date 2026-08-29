import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE_NAME, unpackSessionCookie } from '@/lib/session-cookie'

// Pages accessible without being logged in
const PUBLIC_PAGES = new Set([
  '/',
  '/login',
  '/signup',
  '/forgot-password',
  '/privacy',
  '/terms',
])

// API prefixes that are public (no auth required)
// Cron and queue/process are secured by CRON_SECRET header, not session cookie
/**
 * Reachable without a session cookie. Each one authenticates itself — a shared
 * secret or a provider signature — so "public" here means "not behind the
 * dashboard login", not unauthenticated.
 */
const PUBLIC_API_PREFIXES = [
  '/api/auth/',
  '/api/payment/webhook',
  '/api/cron/',
  '/api/queue/process/',
  // Telegram posts here with ?secret=CRON_SECRET, which the route checks. It
  // was never on this list, so every update Telegram delivered was rejected at
  // the door with a 401 and the bot has never worked — including the
  // approve/reject buttons on scheduled posts.
  '/api/telegram/webhook',
  // Same class of bug, same fix — the pose-recreate bot's own webhook, secured
  // the same way (?secret=CRON_SECRET checked inside the route).
  '/api/telegram-recreate/webhook',
  // Same class of bug, same fix — @igreplicatorbot's own webhook (viral
  // monitor subscribe/unsubscribe), secured the same way.
  '/api/viral-monitor/telegram-webhook',
  // Instagram redirects the browser here to finish OAuth with a one-time
  // `code` — Instagram's own signature that this is a legitimate completion
  // for this app, same trust model as the webhooks above. That browser has
  // no reason to also be logged into the xxmachine dashboard (confirmed
  // live: an automated connect flow that never touched the dashboard got a
  // silent 401 here with zero server-side log output, since the request
  // never reached the route's own code at all).
  '/api/instagram/oauth/callback',
  // Same class of bug, same fix — Fanvue redirects the browser back here with a
  // one-time `code`, its own signature that this is a legitimate OAuth completion.
  '/api/fanvue/callback',
  // Same class of bug, same silent-401-with-no-server-log symptom, found
  // live 2026-08-14: cron/tick's own internal loopback calls to these three
  // routes carry no session cookie and no secret header, so every due
  // Instagram reel / scheduled post / token refresh was silently dropped at
  // the edge — the automated posting pipeline has likely never actually
  // fired since this allowlist was introduced. Each is UUID-gated (acts
  // only on a pre-existing, already-approved queue/post row it's given the
  // id for) or takes no user input at all, so exposing them doesn't let an
  // outsider inject or approve new content, only nudge something already
  // queued to run slightly early if they somehow guessed its id.
  '/api/publish/now',
  '/api/instagram/publish-reel',
  '/api/instagram/refresh-token',
]

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl

  // Let Next.js internals and static files through
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.match(/\.\w+$/)
  ) {
    return NextResponse.next()
  }

  // Signature check only — the session row is still verified per route by
  // `requireUser`. This stops forged or empty cookies at the edge.
  const hasSession = unpackSessionCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value) !== null

  // ── API routes ────────────────────────────────────────────
  if (pathname.startsWith('/api/')) {
    if (PUBLIC_API_PREFIXES.some(p => pathname.startsWith(p))) {
      return NextResponse.next()
    }
    if (!hasSession) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
    }
    return NextResponse.next()
  }

  // ── Public pages ──────────────────────────────────────────
  if (PUBLIC_PAGES.has(pathname)) {
    return NextResponse.next()
  }

  // ── Subscribe page: auth required, no subscription check ─
  if (pathname === '/subscribe') {
    if (!hasSession) {
      const dest = req.nextUrl.clone()
      dest.pathname = '/login'
      return NextResponse.redirect(dest)
    }
    return NextResponse.next()
  }

  // ── All other dashboard pages: require session ────────────
  if (!hasSession) {
    const dest = req.nextUrl.clone()
    dest.pathname = '/login'
    dest.searchParams.set('next', pathname)
    return NextResponse.redirect(dest)
  }

  return NextResponse.next()
}

export const config = {
  // Exclude routes that handle large multipart uploads directly (proxy would buffer them).
  // Auth for these routes is handled inside the route handlers themselves.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/queue/upload-input|api/edit-image|api/grok/analyze-poses).*)'],
}
