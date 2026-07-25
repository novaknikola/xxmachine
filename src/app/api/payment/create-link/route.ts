import { NextRequest, NextResponse } from 'next/server'
import { createHmac, randomBytes } from 'node:crypto'
import { requireUser } from '@/lib/session'
import { one } from '@/lib/db'

const BYBIT_API_KEY = process.env.BYBIT_API_KEY!
const BYBIT_API_SECRET = process.env.BYBIT_API_SECRET!
const BYBIT_BASE = 'https://api.bybit.com'

const PRICES: Record<string, number> = {
  starter: Number(process.env.PRICE_STARTER_USDT ?? 29),
  pro:     Number(process.env.PRICE_PRO_USDT ?? 69),
  agency:  Number(process.env.PRICE_AGENCY_USDT ?? 149),
}

function bybitSign(params: Record<string, string>, timestamp: string): string {
  const sorted = Object.keys(params)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&')
  const payload = `${timestamp}${BYBIT_API_KEY}5000${sorted}`
  return createHmac('sha256', BYBIT_API_SECRET).update(payload).digest('hex')
}

export async function POST(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  try {
    const body = await req.json().catch(() => ({})) as { plan?: string }
    const plan = (['starter', 'pro', 'agency'] as const).includes(body.plan as never)
      ? (body.plan as 'starter' | 'pro' | 'agency')
      : 'starter'
    const amount = PRICES[plan]

    const orderId = randomBytes(16).toString('hex')
    const timestamp = Date.now().toString()

    const params: Record<string, string> = {
      merchantId: process.env.BYBIT_MERCHANT_ID ?? '',
      orderId,
      currency: 'USDT',
      amount: amount.toFixed(2),
      productType: '2',
      productName: `XXmachine ${plan.charAt(0).toUpperCase() + plan.slice(1)} Plan`,
      orderMemo: `${auth.id}:${plan}`,
      returnUrl: `${process.env.NEXT_PUBLIC_BASE_URL}/subscribe?status=success`,
      failUrl: `${process.env.NEXT_PUBLIC_BASE_URL}/subscribe?status=failed`,
    }

    const sign = bybitSign(params, timestamp)

    const res = await fetch(`${BYBIT_BASE}/v3/private/pay/merchant/payment/link/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BAPI-API-KEY': BYBIT_API_KEY,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-SIGN': sign,
        'X-BAPI-RECV-WINDOW': '5000',
      },
      body: JSON.stringify(params),
    })

    const data = await res.json()

    if (data.retCode !== 0) {
      console.error('[payment/create-link] Bybit error:', data)
      throw new Error(data.retMsg ?? 'Bybit API error')
    }

    // Store the pending order on the user record
    await one(`UPDATE users SET bybit_order_id = $1 WHERE id = $2`, [orderId, auth.id])

    // Record event
    await one(
      `INSERT INTO subscription_events (user_id, event_type, plan, bybit_order_id, amount_usdt)
       VALUES ($1, 'payment_initiated', $2, $3, $4)`,
      [auth.id, plan, orderId, amount],
    )

    return NextResponse.json({ paymentLink: data.result?.paymentLink, orderId })
  } catch (err) {
    console.error('[payment/create-link]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
