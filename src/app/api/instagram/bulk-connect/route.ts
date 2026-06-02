export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

import { NextRequest } from 'next/server'
import { one } from '@/lib/db'
import { getIgClient, saveIgSession, loginIgClient } from '@/lib/ig-private-api'

function friendlyError(msg: string): string {
  if (msg.includes('tunneling socket') || msg.includes('socket hang up') || msg.includes('ECONNREFUSED'))
    return 'Proxy not accessible — try Browser Login'
  if (msg.includes('400') && (msg.includes('email') || msg.includes('help you get back')))
    return 'Instagram requires email verification — use Browser Login'
  if (msg.includes('400') && msg.includes('Bad Request'))
    return 'Login blocked by Instagram — use Browser Login'
  if (msg === 'CHECKPOINT')
    return 'Requires verification code — use Browser Login'
  return msg
}

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
        const acc = await one<{
          id: string
          name: string
          ig_username: string | null
          ig_password: string | null
          ig_totp_secret: string | null
        }>(`SELECT id, name, ig_username, ig_password, ig_totp_secret FROM instagram_accounts WHERE id=$1`, [accountId])

        if (!acc) { send({ type: 'error', accountId, message: 'Account not found' }); failed++; continue }
        if (!acc.ig_username || !acc.ig_password) {
          send({ type: 'error', accountId, name: acc.name, message: 'Missing credentials' })
          failed++; continue
        }

        send({ type: 'connecting', accountId, name: acc.name })

        try {
          const ig = await getIgClient(accountId)
          send({ type: 'progress', accountId, name: acc.name, step: 'login' })

          const loggedIn = await loginIgClient(ig, acc.ig_username, acc.ig_password, acc.ig_totp_secret)
          await saveIgSession(accountId, ig)
          await one(`UPDATE instagram_accounts SET ig_username=$1 WHERE id=$2`, [loggedIn.username, accountId])

          connected++
          send({ type: 'connected', accountId, name: acc.name, username: loggedIn.username })
        } catch (err: unknown) {
          failed++
          const msg = err instanceof Error ? err.message : String(err)
          send({ type: 'error', accountId, name: acc.name, message: friendlyError(msg) })
        }

        await new Promise(r => setTimeout(r, 2000))
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
