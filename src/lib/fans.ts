import {
  Fan,
  PaydayRule,
  Weekday,
  WeekdayKey,
  WEEKDAY_KEYS,
  ManualSpendEntry,
  FanImportantDate,
  FanSpendSnapshot,
} from './types'

const WEEKDAY_LABELS: Record<WeekdayKey, string> = {
  sun: 'Sun',
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
}

const WEEKDAY_FULL: Record<WeekdayKey, string> = {
  sun: 'Sunday',
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
}

export function weekdayLabel(w: Weekday, full = false): string {
  const key = WEEKDAY_KEYS[w]
  return full ? WEEKDAY_FULL[key] : WEEKDAY_LABELS[key]
}

export function dateToYmd(d: Date): string {
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export function ymdToDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

export function todayYmd(): string {
  return dateToYmd(new Date())
}

function clampMonthDay(year: number, monthIndex: number, day: number): number {
  const last = new Date(year, monthIndex + 1, 0).getDate()
  return Math.min(Math.max(1, day), last)
}

/** True iff `date` matches the payday rule. */
export function isPaydayOn(rule: PaydayRule, date: Date): boolean {
  switch (rule.kind) {
    case 'none':
      return false
    case 'monthly':
      return date.getDate() === clampMonthDay(date.getFullYear(), date.getMonth(), rule.day)
    case 'weekly':
      return date.getDay() === rule.weekday
    case 'biweekly': {
      if (date.getDay() !== rule.weekday) return false
      const anchor = ymdToDate(rule.anchor)
      // normalize both to local midnight so DST transitions don't skew the day count
      const dateNorm = new Date(date.getFullYear(), date.getMonth(), date.getDate())
      const diffDays = Math.round((dateNorm.getTime() - anchor.getTime()) / 86400000)
      return diffDays % 14 === 0
    }
  }
}

/** Date object for the next payday strictly >= `from`, or null. */
export function nextPaydayFor(rule: PaydayRule, from: Date): Date | null {
  if (rule.kind === 'none') return null
  // Look up to 60 days ahead — any rule resolves within that window.
  for (let i = 0; i < 60; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i)
    if (isPaydayOn(rule, d)) return d
  }
  return null
}

export function formatPaydayRule(rule: PaydayRule): string {
  switch (rule.kind) {
    case 'none':
      return 'No payday set'
    case 'monthly':
      return `Monthly · day ${rule.day}`
    case 'weekly':
      return `Weekly · ${weekdayLabel(rule.weekday, true)}`
    case 'biweekly':
      return `Biweekly · ${weekdayLabel(rule.weekday, true)}`
  }
}

export type FanEventReason =
  | { kind: 'payday' }
  | { kind: 'weekly'; weekday: WeekdayKey; label: string }
  | { kind: 'important'; date: FanImportantDate }

export interface FanEvent {
  fan: Fan
  date: string // YYYY-MM-DD
  reasons: FanEventReason[]
}

/** All reasons (payday / weekly slot / important date) that this fan has on `date`. */
export function reasonsForDay(fan: Fan, date: Date): FanEventReason[] {
  const reasons: FanEventReason[] = []
  if (isPaydayOn(fan.payday, date)) {
    reasons.push({ kind: 'payday' })
  }
  const weekdayKey = WEEKDAY_KEYS[date.getDay() as Weekday]
  const weeklyLabel = fan.weeklySchedule[weekdayKey]
  if (weeklyLabel && weeklyLabel.trim()) {
    reasons.push({ kind: 'weekly', weekday: weekdayKey, label: weeklyLabel.trim() })
  }
  const ymd = dateToYmd(date)
  for (const dt of fan.importantDates) {
    if (dt.date === ymd) reasons.push({ kind: 'important', date: dt })
  }
  return reasons
}

/** Convenience: reasons for a YMD string. */
export function reasonsForYmd(fan: Fan, ymd: string): FanEventReason[] {
  return reasonsForDay(fan, ymdToDate(ymd))
}

/** Aggregate across fans: who has any reason on the given date? */
export function aggregateForDay(fans: Fan[], date: Date): FanEvent[] {
  const events: FanEvent[] = []
  const ymd = dateToYmd(date)
  for (const fan of fans) {
    const reasons = reasonsForDay(fan, date)
    if (reasons.length > 0) events.push({ fan, date: ymd, reasons })
  }
  return events
}

export function sumManualSpendCents(entries: ManualSpendEntry[]): number {
  return entries.reduce((acc, e) => acc + (e.amountCents | 0), 0)
}

export function formatCents(cents: number | undefined | null): string {
  if (cents == null) return '—'
  return `$${(cents / 100).toFixed(2)}`
}

/** Highest reason kind for visual priority (mint > cyan > lavender > neutral). */
export function dominantReasonKind(reasons: FanEventReason[]): FanEventReason['kind'] | null {
  if (reasons.some(r => r.kind === 'payday')) return 'payday'
  if (reasons.some(r => r.kind === 'important')) return 'important'
  if (reasons.some(r => r.kind === 'weekly')) return 'weekly'
  return null
}

/** Parse a Gemini-extracted payday string into a typed PaydayRule. Returns null when not parseable. */
export function paydayRuleFromSummary(text: string | null | undefined): PaydayRule | null {
  if (!text) return null
  const t = text.toLowerCase().trim()
  if (!t) return null

  // Weekly: "every friday", "weekly fri", "friday"
  const weekdayMap: Record<string, Weekday> = {
    sun: 0, sunday: 0,
    mon: 1, monday: 1,
    tue: 2, tues: 2, tuesday: 2,
    wed: 3, wednesday: 3,
    thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5,
    sat: 6, saturday: 6,
  }
  for (const [key, w] of Object.entries(weekdayMap)) {
    const re = new RegExp(`\\b${key}\\b`)
    if (re.test(t)) {
      if (/\b(bi[- ]?weekly|every other week|every 2 weeks|fortnight)\b/.test(t)) {
        return { kind: 'biweekly', weekday: w, anchor: todayYmd() }
      }
      return { kind: 'weekly', weekday: w }
    }
  }

  // Monthly: "1st of month", "15th", "monthly day 5"
  const ord = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/)
  if (ord && /\b(month|monthly|of (the )?month)\b/.test(t)) {
    const day = Math.max(1, Math.min(31, Number(ord[1])))
    return { kind: 'monthly', day }
  }
  // Just a number with "month" implied
  if (/\bmonth/.test(t) && ord) {
    return { kind: 'monthly', day: Math.max(1, Math.min(31, Number(ord[1]))) }
  }
  return null
}

export function emptyFan(): Fan {
  return {
    id: crypto.randomUUID(),
    displayName: '',
    payday: { kind: 'none' },
    weeklySchedule: {},
    importantDates: [],
    manualSpendEntries: [],
    notes: '',
    tags: [],
    createdAt: new Date().toISOString(),
  }
}

// ─────────────────────────────────────────────────────────────
// Fanvue hydration (Layer 2)
// ─────────────────────────────────────────────────────────────

export interface FanvueHydration {
  uuid: string
  handle?: string
  displayName: string
  status?: 'subscriber' | 'expired' | 'follower' | 'not_contactable'
  lifetimeGrossCents: number
  maxSinglePaymentCents?: number
  spendingSources?: Record<string, number>
  lastPurchaseAt?: string
  subscriptionCreatedAt?: string
  subscriptionRenewsAt?: string
  autoRenewalEnabled?: boolean
  isTopSpender?: boolean
}

/** Average per-day spend computed from lifetime + subscription start. Returns cents/day or null when not computable. */
export function averagePerDayCents(lifetimeCents: number | undefined, subscriptionCreatedAt: string | undefined): number | null {
  if (lifetimeCents == null || lifetimeCents <= 0 || !subscriptionCreatedAt) return null
  const start = new Date(subscriptionCreatedAt)
  if (Number.isNaN(start.getTime())) return null
  const days = Math.max(1, Math.round((Date.now() - start.getTime()) / 86400000))
  return Math.round(lifetimeCents / days)
}

/** Days since the fan first subscribed. Used for "subscribed for N days" labels. */
export function daysSinceSubscribed(subscriptionCreatedAt: string | undefined): number | null {
  if (!subscriptionCreatedAt) return null
  const start = new Date(subscriptionCreatedAt)
  if (Number.isNaN(start.getTime())) return null
  return Math.max(0, Math.round((Date.now() - start.getTime()) / 86400000))
}

/** Compute "spent in last 24h" using the two most-recent snapshots for a fan. Returns cents or null if insufficient history. */
export function deltaLast24hCents(snapshots: FanSpendSnapshot[], fanCurrentLifetime: number | undefined): number | null {
  if (fanCurrentLifetime == null) return null
  if (!snapshots.length) return null
  const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date))
  // Use UTC date so the boundary matches how snapshots are stored (server-side UTC)
  const now = new Date()
  const todayUtc = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`
  const prior = [...sorted].reverse().find(s => s.date < todayUtc)
  if (!prior) return null
  return Math.max(0, fanCurrentLifetime - prior.lifetimeGrossCents)
}

/** Lifetime spent in the last N days. Uses earliest snapshot within the window as baseline. */
export function deltaLastNDaysCents(
  snapshots: FanSpendSnapshot[],
  fanCurrentLifetime: number | undefined,
  days: number,
): number | null {
  if (fanCurrentLifetime == null) return null
  if (!snapshots.length) return null
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffYmd = dateToYmd(cutoff)
  const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date))
  const baseline = sorted.find(s => s.date >= cutoffYmd)
  if (!baseline) return null
  return Math.max(0, fanCurrentLifetime - baseline.lifetimeGrossCents)
}

/** Approximate monthly spend.
 *  Preferred: lifetime delta over last 30 days from snapshots.
 *  Fallback: lifetime / months_subscribed when no snapshot history exists. */
export function monthlySpendCents(
  fan: { lifetimeGrossCents?: number; subscriptionCreatedAt?: string },
  snapshots: FanSpendSnapshot[],
): number | null {
  const fromSnap = deltaLastNDaysCents(snapshots, fan.lifetimeGrossCents, 30)
  if (fromSnap != null) return fromSnap
  if (fan.lifetimeGrossCents == null || !fan.subscriptionCreatedAt) return null
  const start = new Date(fan.subscriptionCreatedAt)
  if (Number.isNaN(start.getTime())) return null
  const months = Math.max(1, (Date.now() - start.getTime()) / (30 * 86400000))
  return Math.round(fan.lifetimeGrossCents / months)
}

/** Days since last recorded purchase. Returns null if no purchase recorded. */
export function daysSinceLastPurchase(fan: { lastPurchaseAt?: string }): number | null {
  if (!fan.lastPurchaseAt) return null
  const t = new Date(fan.lastPurchaseAt)
  if (Number.isNaN(t.getTime())) return null
  return Math.max(0, Math.round((Date.now() - t.getTime()) / 86400000))
}

export type SubscriptionHealth = 'healthy' | 'expiring_soon' | 'auto_renew_off' | 'expired' | 'unknown'

/** Quick traffic-light state for retention risk. */
export function subscriptionHealth(fan: {
  status?: string
  subscriptionRenewsAt?: string
  autoRenewalEnabled?: boolean
}): SubscriptionHealth {
  if (fan.status === 'expired' || fan.status === 'follower' || fan.status === 'not_contactable') return 'expired'
  if (fan.autoRenewalEnabled === false) return 'auto_renew_off'
  if (fan.subscriptionRenewsAt) {
    const renews = new Date(fan.subscriptionRenewsAt)
    if (!Number.isNaN(renews.getTime())) {
      const days = Math.round((renews.getTime() - Date.now()) / 86400000)
      if (days >= 0 && days <= 3) return 'expiring_soon'
    }
  }
  if (fan.status === 'subscriber') return 'healthy'
  return 'unknown'
}

// ─────────────────────────────────────────────────────────────
// Spend brackets (multi-select filter)
// ─────────────────────────────────────────────────────────────

export interface SpendBracket {
  id: string
  label: string
  min: number // cents inclusive
  max: number // cents exclusive (Infinity for top bucket)
}

export const SPEND_BRACKETS: SpendBracket[] = [
  { id: 'lt100', label: 'Up to $100', min: 0, max: 10000 },
  { id: '100-500', label: '$100 – $500', min: 10000, max: 50000 },
  { id: '500-1k', label: '$500 – $1k', min: 50000, max: 100000 },
  { id: '1k+', label: '$1k+', min: 100000, max: Number.POSITIVE_INFINITY },
]

export function fanInBracket(lifetimeCents: number | undefined, bracket: SpendBracket): boolean {
  const v = lifetimeCents ?? 0
  return v >= bracket.min && v < bracket.max
}

// ─────────────────────────────────────────────────────────────
// Sort options
// ─────────────────────────────────────────────────────────────

export type FanSortKey =
  | 'lifetime_desc'
  | 'last_purchase_desc'
  | 'avg_per_day_desc'
  | 'days_subscribed_desc'
  | 'name_asc'

export const FAN_SORT_OPTIONS: Array<{ key: FanSortKey; label: string }> = [
  { key: 'lifetime_desc', label: 'Lifetime spend (high → low)' },
  { key: 'last_purchase_desc', label: 'Recent purchase (newest)' },
  { key: 'avg_per_day_desc', label: 'Avg per day (high → low)' },
  { key: 'days_subscribed_desc', label: 'Subscribed for (longest)' },
  { key: 'name_asc', label: 'Name (A → Z)' },
]

export function sortFans(fans: Fan[], key: FanSortKey): Fan[] {
  const copy = [...fans]
  switch (key) {
    case 'lifetime_desc':
      return copy.sort((a, b) => (b.lifetimeGrossCents ?? 0) - (a.lifetimeGrossCents ?? 0))
    case 'last_purchase_desc':
      return copy.sort((a, b) => {
        const at = a.lastPurchaseAt ? new Date(a.lastPurchaseAt).getTime() : 0
        const bt = b.lastPurchaseAt ? new Date(b.lastPurchaseAt).getTime() : 0
        return bt - at
      })
    case 'avg_per_day_desc':
      return copy.sort((a, b) => {
        const av = averagePerDayCents(a.lifetimeGrossCents, a.subscriptionCreatedAt) ?? 0
        const bv = averagePerDayCents(b.lifetimeGrossCents, b.subscriptionCreatedAt) ?? 0
        return bv - av
      })
    case 'days_subscribed_desc':
      return copy.sort((a, b) => (daysSinceSubscribed(b.subscriptionCreatedAt) ?? 0) - (daysSinceSubscribed(a.subscriptionCreatedAt) ?? 0))
    case 'name_asc':
      return copy.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''))
  }
}

/** Sum spending sources by key (subscription/tips/ppv/etc.). Returns the total and percentage per source. */
export function sourceBreakdown(sources: Record<string, number> | undefined): Array<{ key: string; cents: number; pct: number }> {
  if (!sources) return []
  const entries = Object.entries(sources).filter(([, v]) => typeof v === 'number' && v > 0)
  const total = entries.reduce((acc, [, v]) => acc + v, 0)
  if (total === 0) return []
  return entries
    .map(([key, cents]) => ({ key, cents, pct: cents / total }))
    .sort((a, b) => b.cents - a.cents)
}

const SOURCE_LABELS: Record<string, string> = {
  subscription: 'Subscription',
  tip: 'Tips',
  tips: 'Tips',
  ppv: 'PPV',
  message: 'Messages',
  messages: 'Messages',
  custom: 'Custom',
  post: 'Posts',
  posts: 'Posts',
}

export function sourceLabel(key: string): string {
  return SOURCE_LABELS[key] ?? key.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

/** Merge Fanvue hydrations into an existing fan list. Matches by uuid first, then handle. Creates new fans for unknowns. */
export function mergeFanvueHydrations(
  existing: Fan[],
  hydrations: FanvueHydration[],
): { merged: Fan[]; created: number; updated: number } {
  const fans = [...existing]
  let created = 0
  let updated = 0
  const syncedAt = new Date().toISOString()

  for (const h of hydrations) {
    let idx = fans.findIndex(f => f.fanvueUserUuid && f.fanvueUserUuid === h.uuid)
    if (idx < 0 && h.handle) {
      const lh = h.handle.toLowerCase()
      idx = fans.findIndex(f => f.fanvueHandle && f.fanvueHandle.toLowerCase() === lh)
    }

    if (idx >= 0) {
      fans[idx] = {
        ...fans[idx],
        fanvueUserUuid: h.uuid,
        fanvueHandle: fans[idx].fanvueHandle ?? h.handle,
        status: h.status,
        lifetimeGrossCents: h.lifetimeGrossCents,
        maxSinglePaymentCents: h.maxSinglePaymentCents,
        spendingSources: h.spendingSources,
        lastPurchaseAt: h.lastPurchaseAt ?? fans[idx].lastPurchaseAt,
        subscriptionCreatedAt: h.subscriptionCreatedAt ?? fans[idx].subscriptionCreatedAt,
        subscriptionRenewsAt: h.subscriptionRenewsAt,
        autoRenewalEnabled: h.autoRenewalEnabled,
        isTopSpender: h.isTopSpender,
        syncedAt,
      }
      updated++
    } else {
      const fresh: Fan = {
        ...emptyFan(),
        displayName: h.displayName || h.handle || 'Unknown',
        fanvueHandle: h.handle,
        fanvueUserUuid: h.uuid,
        status: h.status,
        lifetimeGrossCents: h.lifetimeGrossCents,
        maxSinglePaymentCents: h.maxSinglePaymentCents,
        spendingSources: h.spendingSources,
        lastPurchaseAt: h.lastPurchaseAt,
        subscriptionCreatedAt: h.subscriptionCreatedAt,
        subscriptionRenewsAt: h.subscriptionRenewsAt,
        autoRenewalEnabled: h.autoRenewalEnabled,
        isTopSpender: h.isTopSpender,
        syncedAt,
      }
      fans.unshift(fresh)
      created++
    }
  }

  return { merged: fans, created, updated }
}
