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
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/video-reproduce|api/queue/upload-input|api/edit-image|api/grok/analyze-poses).*)'],
}
