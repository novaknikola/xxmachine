/**
 * WaveSpeed unit-cost estimate for Copy-Paste v2 (Seedream v5 Pro Edit keyframe + Seedance 2.0 video).
 *
 * Seedance rate matches POST https://api.wavespeed.ai/api/v3/model/pricing (probed Jul 2026).
 * Seedream rate matches https://wavespeed.ai/models/bytedance/seedream-v5.0-pro/edit
 * (probed Aug 2026): $0.045/run at 1k + $0.003 per image beyond the first — we always
 * send exactly 2 (source frame + reference photo), so it's a flat $0.048/keyframe.
 * Not a live ledger — Grok vision tokens / HF Whisper ASR are outside WaveSpeed.
 */

const SEEDANCE_PER_SEC_USD = 0.24
const SEEDREAM_BASE_USD = 0.045
const SEEDREAM_EXTRA_IMAGE_USD = 0.003
/** Start keyframe: source frame + reference photo. */
const SEEDREAM_KEYFRAME_USD = SEEDREAM_BASE_USD + SEEDREAM_EXTRA_IMAGE_USD
/** End keyframe also carries the start keyframe as a third match reference. */
const SEEDREAM_END_KEYFRAME_USD = SEEDREAM_BASE_USD + 2 * SEEDREAM_EXTRA_IMAGE_USD

export interface CostBreakdown {
  keyframeUsd: number
  videoUsd: number
  totalUsd: number
  note: string
}

function seedanceSeconds(durationSec?: number | null): number {
  if (durationSec == null || !Number.isFinite(durationSec) || durationSec <= 0) return 5
  return Math.min(15, Math.max(4, Math.round(durationSec)))
}

export function estimateCopyPasteCost(
  durationSec?: number | null,
  opts?: { endFrame?: boolean },
): CostBreakdown {
  const billedSec = seedanceSeconds(durationSec)
  const keyframeUsd = roundUsd(
    SEEDREAM_KEYFRAME_USD + (opts?.endFrame ? SEEDREAM_END_KEYFRAME_USD : 0),
  )
  const videoUsd = roundUsd(SEEDANCE_PER_SEC_USD * billedSec)

  return {
    keyframeUsd,
    videoUsd,
    totalUsd: roundUsd(keyframeUsd + videoUsd),
    note: `Seedream v5 Pro Edit ${opts?.endFrame ? 'start + end keyframes' : 'keyframe'}: $${keyframeUsd.toFixed(3)}. WaveSpeed Seedance 2.0 (720p): ≈$${SEEDANCE_PER_SEC_USD.toFixed(2)}/s × ${billedSec}s billed. Grok / HF Whisper not included.`,
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
  keyframeUsd: number
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
    keyframeUsd: entry.keyframeUsd,
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

export function spendWeekUsd(): number {
  const start = Date.now() - 7 * 24 * 60 * 60 * 1000
  return listSpend()
    .filter(e => new Date(e.at).getTime() >= start)
    .reduce((sum, e) => sum + e.totalUsd, 0)
}
