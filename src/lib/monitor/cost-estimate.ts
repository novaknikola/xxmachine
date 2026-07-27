/**
 * WaveSpeed unit-cost estimates for Copy-Paste preflight / spend log.
 *
 * Rates match POST https://api.wavespeed.ai/api/v3/model/pricing (probed Jul 2026)
 * and recent /billings/search deducts for Kling (pricing endpoint 500s for MC).
 * Not a live ledger — ASR (HF) / Grok tokens are outside WaveSpeed.
 */

export type ImageModelChoice = 'z_image' | 'seedream_edit'
export type VideoBackendChoice =
  | 'auto'
  | 'kling_mc'
  | 'seedance_i2v'
  | 'seedance_i2v_turbo'
  | 'ltx_i2v'
  | 'ltx_i2v_lora'
  | 'wan_i2v'
export type SoundMode = 'silent' | 'source' | 'fish' | 'seedance_native'

export function normalizeSoundMode(raw: unknown): SoundMode {
  if (raw === 'source' || raw === 'fish' || raw === 'seedance_native' || raw === 'silent') return raw
  return 'silent'
}

export interface CostBreakdown {
  imageUsd: number
  videoUsd: number
  audioUsd: number
  totalUsd: number
  note: string
}

/** bytedance/seedream-v5.0-pro/edit — base + $0.003 per extra input image. */
const SEEDREAM_BASE_USD: Record<'1k' | '2k', number> = {
  '1k': 0.045,
  '2k': 0.09,
}
const SEEDREAM_PER_EXTRA_IMAGE_USD = 0.003

/** wavespeed-ai/z-image/turbo-lora @ 756×1344 */
const Z_IMAGE_USD = 0.01

/** 720p per-second rates from /model/pricing */
const VIDEO_PER_SEC_USD: Record<Exclude<VideoBackendChoice, 'auto' | 'kling_mc'>, number> = {
  seedance_i2v: 0.24,
  seedance_i2v_turbo: 0.14,
  ltx_i2v: 0.03,
  ltx_i2v_lora: 0.04,
  wan_i2v: 0.1,
}

/**
 * kwaivgi/kling-v2.6-std/motion-control — pricing API errors;
 * billings cluster at ~$0.07 × source seconds (0.21 / 0.28 / 0.42 / 0.77).
 */
const KLING_PER_SEC_USD = 0.07

/** Duration clamps mirror video-backends.ts */
function seedanceSeconds(durationSec?: number | null): number {
  if (durationSec == null || !Number.isFinite(durationSec) || durationSec <= 0) return 5
  return Math.min(15, Math.max(4, Math.round(durationSec)))
}

function ltxSeconds(durationSec?: number | null): number {
  if (durationSec == null || !Number.isFinite(durationSec) || durationSec <= 0) return 5
  return Math.min(20, Math.max(5, Math.round(durationSec)))
}

function wanSeconds(durationSec?: number | null): number {
  if (durationSec == null || !Number.isFinite(durationSec) || durationSec <= 0) return 5
  return durationSec <= 7 ? 5 : 10
}

function klingSeconds(durationSec?: number | null): number {
  if (durationSec == null || !Number.isFinite(durationSec) || durationSec <= 0) return 8
  return Math.min(30, Math.max(3, Math.round(durationSec)))
}

function estimateSeedreamUsd(
  resolution: '1k' | '2k',
  imageCount: number,
): number {
  const n = Math.min(10, Math.max(1, Math.round(imageCount)))
  return SEEDREAM_BASE_USD[resolution] + SEEDREAM_PER_EXTRA_IMAGE_USD * (n - 1)
}

function estimateVideoUsd(
  backend: VideoBackendChoice,
  durationSec?: number | null,
): number {
  switch (backend) {
    case 'kling_mc':
      return KLING_PER_SEC_USD * klingSeconds(durationSec)
    case 'seedance_i2v':
      return VIDEO_PER_SEC_USD.seedance_i2v * seedanceSeconds(durationSec)
    case 'seedance_i2v_turbo':
      return VIDEO_PER_SEC_USD.seedance_i2v_turbo * seedanceSeconds(durationSec)
    case 'ltx_i2v':
      return VIDEO_PER_SEC_USD.ltx_i2v * ltxSeconds(durationSec)
    case 'ltx_i2v_lora':
      return VIDEO_PER_SEC_USD.ltx_i2v_lora * ltxSeconds(durationSec)
    case 'wan_i2v':
      return VIDEO_PER_SEC_USD.wan_i2v * wanSeconds(durationSec)
    case 'auto':
      // Auto resolves to Seedance for most techniques; Kling only for motion_transfer / multi_shot.
      return VIDEO_PER_SEC_USD.seedance_i2v * seedanceSeconds(durationSec)
    default:
      return VIDEO_PER_SEC_USD.seedance_i2v * seedanceSeconds(durationSec)
  }
}

const AUDIO_USD: Record<SoundMode, number> = {
  silent: 0,
  source: 0, // mux only — no WaveSpeed charge
  fish: 0.02, // external; not WaveSpeed
  seedance_native: 0, // generate_audio does not change Seedance unit_price
}

export function estimateReplicateCost(input: {
  imageModel: ImageModelChoice
  seedreamResolution?: '1k' | '2k'
  /** Face-ref count for Seedream (default 2 — typical character). */
  seedreamImageCount?: number
  videoBackend: VideoBackendChoice
  sound: SoundMode
  durationSec?: number | null
}): CostBreakdown {
  const resolution = input.seedreamResolution === '1k' ? '1k' : '2k'
  const imageUsd =
    input.imageModel === 'seedream_edit'
      ? estimateSeedreamUsd(resolution, input.seedreamImageCount ?? 2)
      : Z_IMAGE_USD

  const videoUsd = estimateVideoUsd(input.videoBackend, input.durationSec)
  const audioUsd = AUDIO_USD[input.sound]
  const totalUsd = imageUsd + videoUsd + audioUsd

  const billedSec =
    input.videoBackend === 'wan_i2v'
      ? wanSeconds(input.durationSec)
      : input.videoBackend === 'ltx_i2v' || input.videoBackend === 'ltx_i2v_lora'
        ? ltxSeconds(input.durationSec)
        : input.videoBackend === 'kling_mc'
          ? klingSeconds(input.durationSec)
          : seedanceSeconds(input.durationSec)

  const imageLabel =
    input.imageModel === 'seedream_edit'
      ? `Seedream ${resolution}`
      : 'Z-Image turbo-lora'

  return {
    imageUsd: roundUsd(imageUsd),
    videoUsd: roundUsd(videoUsd),
    audioUsd: roundUsd(audioUsd),
    totalUsd: roundUsd(totalUsd),
    note:
      `WaveSpeed rates (720p): ${imageLabel}≈$${imageUsd.toFixed(3)}, ` +
      `video≈$${videoUsd.toFixed(2)} for ${billedSec}s billed. ` +
      'HF Whisper / Grok not included.',
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
