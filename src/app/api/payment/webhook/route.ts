import { NextRequest, NextResponse } from 'next/server'
import { createHmac } from 'node:crypto'
import { one } from '@/lib/db'

const BYBIT_API_SECRET = process.env.BYBIT_API_SECRET!

function verifyBybitWebhook(req: NextRequest, rawBody: string): boolean {
  const timestamp = req.headers.get('x-bapi-timestamp') ?? ''
  const apiKey = req.headers.get('x-bapi-api-key') ?? ''
  const recvWindow = req.headers.get('x-bapi-recv-window') ?? '5000'
  const signature = req.headers.get('x-bapi-sign') ?? ''

  const payload = `${timestamp}${apiKey}${recvWindow}${rawBody}`
  const expected = createHmac('sha256', BYBIT_API_SECRET).update(payload).digest('hex')
  return expected === signature
}

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text()

    if (!verifyBybitWebhook(req, rawBody)) {
      console.warn('[payment/webhook] Invalid Bybit signature')
      return NextResponse.json({ error: 'invalid_signature' }, { status: 401 })
    }

    const event = JSON.parse(rawBody) as {
      merchantId?: string
      orderId?: string
      orderStatus?: string   // 'SUCCESS' | 'FAILED' | 'EXPIRED'
      orderMemo?: string     // format: "userId:plan"
      amount?: string
      currency?: string
    }

    const { orderId, orderStatus, orderMemo, amount } = event

    if (!orderId || !orderStatus || !orderMemo) {
      return NextResponse.json({ ok: true }) // unknown format, acknowledge anyway
    }

    const [userId, plan] = (orderMemo ?? '').split(':')
    if (!userId) return NextResponse.json({ ok: true })

    const amountUsdt = amount ? parseFloat(amount) : null

    if (orderStatus === 'SUCCESS') {
      const expiresAt = plan === 'yearly'
        ? new Date(Date.now() + 365 * 24 * 3600 * 1000)
        : new Date(Date.now() + 30 * 24 * 3600 * 1000)

      await one(
        `UPDATE users
         SET subscription_status = 'active',
             subscription_plan = $1,
             subscription_expires_at = $2,
             bybit_order_id = $3
         WHERE id = $4`,
        [plan, expiresAt.toISOString(), orderId, userId],
      )

      await one(
        `INSERT INTO subscription_events (user_id, event_type, plan, bybit_order_id, amount_usdt)
         VALUES ($1, 'payment_confirmed', $2, $3, $4)`,
        [userId, plan, orderId, amountUsdt],
      )

      console.log(`[payment/webhook] Subscription activated for user ${userId}, plan ${plan}`)
    } else if (orderStatus === 'FAILED' || orderStatus === 'EXPIRED') {
      await one(
        `INSERT INTO subscription_events (user_id, event_type, plan, bybit_order_id, amount_usdt)
         VALUES ($1, 'payment_failed', $2, $3, $4)`,
        [userId, plan ?? null, orderId, amountUsdt],
      )
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[payment/webhook]', err)
    return NextResponse.json({ error: 'webhook_error' }, { status: 500 })
  }
}
