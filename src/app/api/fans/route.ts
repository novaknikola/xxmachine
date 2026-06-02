import { NextRequest, NextResponse } from 'next/server'
import { rows, one } from '@/lib/db'

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const creatorId = searchParams.get('creatorId')

    const fans = await rows(
      `SELECT
        id,
        creator_id         AS "creatorId",
        name               AS "displayName",
        handle             AS "fanvueHandle",
        avatar_url         AS "avatarUrl",
        fanvue_uuid        AS "fanvueUserUuid",
        total_spend_cents  AS "totalSpendCents",
        location,
        occupation,
        age,
        notes,
        tags,
        ai_summary         AS "aiSummary",
        ai_summary_at      AS "aiSummaryAt",
        payday,
        weekly_schedule    AS "weeklySchedule",
        important_dates    AS "importantDates",
        manual_spend_entries AS "manualSpendEntries",
        status,
        lifetime_gross_cents     AS "lifetimeGrossCents",
        max_single_payment_cents AS "maxSinglePaymentCents",
        spending_sources         AS "spendingSources",
        last_purchase_at         AS "lastPurchaseAt",
        subscription_created_at  AS "subscriptionCreatedAt",
        subscription_renews_at   AS "subscriptionRenewsAt",
        auto_renewal_enabled     AS "autoRenewalEnabled",
        is_top_spender           AS "isTopSpender",
        synced_at                AS "syncedAt",
        created_at               AS "createdAt"
       FROM fans
       ${creatorId ? 'WHERE creator_id = $1' : ''}
       ORDER BY name ASC`,
      creatorId ? [creatorId] : [],
    )
    return NextResponse.json(fans)
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { creatorId, name, handle, totalSpendCents, location, occupation, age, notes, tags } =
      await req.json()

    if (!creatorId || !name) {
      return NextResponse.json({ error: 'creatorId and name are required' }, { status: 400 })
    }

    const fan = await one(
      `INSERT INTO fans (creator_id, name, handle, total_spend_cents, location, occupation, age, notes, tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, creator_id AS "creatorId", name, handle, avatar_url AS "avatarUrl",
         total_spend_cents AS "totalSpendCents", location, occupation, age, notes, tags,
         payday, weekly_schedule AS "weeklySchedule", important_dates AS "importantDates",
         manual_spend_entries AS "manualSpendEntries", created_at AS "createdAt"`,
      [
        creatorId, name, handle ?? null,
        totalSpendCents ?? 0,
        location ?? null, occupation ?? null, age ?? null,
        notes ?? '', tags ?? [],
      ],
    )
    return NextResponse.json(fan, { status: 201 })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
