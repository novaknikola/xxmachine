import { NextRequest, NextResponse } from 'next/server'
import { query, one } from '@/lib/db'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await req.json()

    const allowed = ['name', 'handle', 'total_spend_cents', 'location', 'occupation', 'age', 'notes', 'tags', 'payday', 'weekly_schedule', 'important_dates', 'manual_spend_entries', 'status', 'lifetime_gross_cents', 'max_single_payment_cents', 'spending_sources', 'last_purchase_at', 'subscription_created_at', 'subscription_renews_at', 'auto_renewal_enabled', 'is_top_spender', 'synced_at']

    // Map camelCase keys to snake_case columns
    const camelToSnake: Record<string, string> = {
      totalSpendCents: 'total_spend_cents',
      weeklySchedule: 'weekly_schedule',
      importantDates: 'important_dates',
      manualSpendEntries: 'manual_spend_entries',
      lifetimeGrossCents: 'lifetime_gross_cents',
      maxSinglePaymentCents: 'max_single_payment_cents',
      spendingSources: 'spending_sources',
      lastPurchaseAt: 'last_purchase_at',
      subscriptionCreatedAt: 'subscription_created_at',
      subscriptionRenewsAt: 'subscription_renews_at',
      autoRenewalEnabled: 'auto_renewal_enabled',
      isTopSpender: 'is_top_spender',
      syncedAt: 'synced_at',
    }

    const setClauses: string[] = []
    const values: unknown[] = []

    for (const [key, val] of Object.entries(body)) {
      const col = camelToSnake[key] ?? key
      if (!allowed.includes(col)) continue
      values.push(val)
      setClauses.push(`${col} = $${values.length}`)
    }

    if (!setClauses.length) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
    }

    values.push(id)
    const fan = await one(
      `UPDATE fans SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING id`,
      values,
    )
    if (!fan) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    await query('DELETE FROM fans WHERE id = $1', [id])
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
