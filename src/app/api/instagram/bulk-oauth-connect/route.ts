export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 900

import { NextRequest } from 'next/server'
import { connectAccountViaOAuth } from '@/lib/instagram/auto-oauth-connect'

/**
 * Bulk version of the single-account flow verified live this session
 * (Playwright login -> OAuth authorize -> our callback, now reachable
 * thanks to the proxy.ts allowlist fix). Same SSE event shape as
 * bulk-connect/bulk-browser-connect so the existing frontend handling
 * pattern applies unchanged. Sequential, not parallel — each run is a full
 * browser session and Instagram login, and running many at once would only
 * make the proxy/rate-limit picture worse.
 */
export async function POST(req: NextRequest) {
  const { accountIds } = await req.json() as { accountIds: string[] }
  if (!accountIds?.length) {
    return new Response(JSON.stringify({ error: 'accountIds required' }), { status: 400 })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      function send(data: object) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      }

      send({ type: 'start', total: accountIds.length })

      let connected = 0
      let failed = 0

      for (const accountId of accountIds) {
        send({ type: 'connecting', accountId })
        try {
          const result = await connectAccountViaOAuth(accountId)
          connected++
          send({ type: 'connected', accountId, username: result.username })
        } catch (err: unknown) {
          failed++
          const message = err instanceof Error ? err.message : String(err)
          send({ type: 'error', accountId, message })
        }

        // Pace between accounts — each one is a fresh Instagram login from a
        // (likely) fresh proxy IP; back-to-back attempts are exactly the
        // pattern that got flagged during this session's own testing.
        await new Promise(r => setTimeout(r, 4000))
      }

      send({ type: 'done', connected, failed, total: accountIds.length })
      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
