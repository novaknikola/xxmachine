/**
 * Rough Wavespeed unit estimates for Copy-Paste preflight UI.
 * Not billing truth — labeled as estimates until a real ledger lands.
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

export interface CostBreakdown {
  imageUsd: number
  videoUsd: number
  audioUsd: number
  totalUsd: number
  note: string
}

const IMAGE_USD: Record<ImageModelChoice, number> = {
  z_image: 0.025,
  seedream_edit: 0.04,
}

/** Per ~5–8s clip at 720p; Auto uses mid of Seedance/Kling. */
const VIDEO_USD: Record<VideoBackendChoice, number> = {
  auto: 0.28,
  kling_mc: 0.45,
  seedance_i2v: 0.22,
  seedance_i2v_turbo: 0.14,
  ltx_i2v: 0.1,
  ltx_i2v_lora: 0.12,
  wan_i2v: 0.16,
}

const AUDIO_USD: Record<SoundMode, number> = {
  silent: 0,
  source: 0,
  fish: 0.02,
  seedance_native: 0,
}

export function estimateReplicateCost(input: {
  imageModel: ImageModelChoice
  seedreamResolution?: '1k' | '2k'
  videoBackend: VideoBackendChoice
  sound: SoundMode
  durationSec?: number | null
}): CostBreakdown {
  let imageUsd = IMAGE_USD[input.imageModel]
  if (input.imageModel === 'seedream_edit' && input.seedreamResolution === '2k') {
    imageUsd *= 1.6
  }

  let videoUsd = VIDEO_USD[input.videoBackend]
  const dur = input.durationSec
  if (dur != null && dur > 0) {
    // Scale softly around a 7s reference clip.
    videoUsd *= Math.min(2.2, Math.max(0.7, dur / 7))
  }

  const audioUsd = AUDIO_USD[input.sound]
  const totalUsd = imageUsd + videoUsd + audioUsd

  return {
    imageUsd,
    videoUsd,
    audioUsd,
    totalUsd,
    note: 'Estimate from typical Wavespeed rates — actual bill may differ.',
  }
}

export function formatUsd(n: number): string {
  if (n <= 0) return '$0.00'
  if (n < 0.01) return '<$0.01'
  return `$${n.toFixed(2)}`
}
