/**
 * WaveSpeed unit-cost estimate for Copy-Paste v2 (Seedance 2.0 only).
 *
 * Rate matches POST https://api.wavespeed.ai/api/v3/model/pricing (probed Jul 2026).
 * Not a live ledger — Grok vision tokens / HF Whisper ASR are outside WaveSpeed.
 */

const SEEDANCE_PER_SEC_USD = 0.24

export interface CostBreakdown {
  videoUsd: number
  totalUsd: number
  note: string
}

function seedanceSeconds(durationSec?: number | null): number {
  if (durationSec == null || !Number.isFinite(durationSec) || durationSec <= 0) return 5
  return Math.min(15, Math.max(4, Math.round(durationSec)))
}

export function estimateCopyPasteCost(durationSec?: number | null): CostBreakdown {
  const billedSec = seedanceSeconds(durationSec)
  const videoUsd = roundUsd(SEEDANCE_PER_SEC_USD * billedSec)

  return {
    videoUsd,
    totalUsd: videoUsd,
    note: `WaveSpeed Seedance 2.0 (720p): ≈$${SEEDANCE_PER_SEC_USD.toFixed(2)}/s × ${billedSec}s billed. Grok / HF Whisper not included.`,
  }
}

function roundUsd(n: number): number {
  return Math.round(n * 1000) / 1000
}

export function formatUsd(n: number): string {
  if (n <= 0) return '$0.00'
  if (n < 0.01) return '<$0.01'
  return `$${n.toFixed(2)}`
}

const SPEND_KEY = 'xxmachine.copyPaste.spend'

export interface SpendEntry {
  id: string
  at: string
  itemId?: string
  profile?: string
  videoUsd: number
  totalUsd: number
}

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown) {
  if (typeof window === 'undefined') return
  localStorage.setItem(key, JSON.stringify(value))
}

export function listSpend(): SpendEntry[] {
  return readJson<SpendEntry[]>(SPEND_KEY, [])
}

export function recordSpend(entry: Omit<SpendEntry, 'id' | 'at'> & { id?: string; at?: string }) {
  const rows = listSpend()
  rows.unshift({
    id: entry.id ?? crypto.randomUUID(),
    at: entry.at ?? new Date().toISOString(),
    itemId: entry.itemId,
    profile: entry.profile,
    videoUsd: entry.videoUsd,
    totalUsd: entry.totalUsd,
  })
  writeJson(SPEND_KEY, rows.slice(0, 500))
}

export function clearSpend() {
  writeJson(SPEND_KEY, [])
}

export function spendTodayUsd(): number {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  return listSpend()
    .filter(e => new Date(e.at) >= start)
    .reduce((sum, e) => sum + e.totalUsd, 0)
}
