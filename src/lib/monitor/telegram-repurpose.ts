/**
 * Per-user repurpose options the bot remembers, plus the keyboards that edit
 * them. Kept out of the webhook route so the route stays a thin dispatcher.
 */
import { one, query } from '@/lib/db'
import type { VideoEffectOpts } from '@/lib/video-ffmpeg'
import { DEFAULT_REPURPOSE_EFFECTS } from '@/lib/repurpose/enqueue-from-drive'

export type EndFrameMode = 'auto' | 'always' | 'off'

export interface TelegramRepurposeSettings {
  variantCount: number
  effects: VideoEffectOpts
  outputDriveFolderId: string | null
  endFrameMode: EndFrameMode
}

const DEFAULTS: TelegramRepurposeSettings = {
  variantCount: 5,
  effects: DEFAULT_REPURPOSE_EFFECTS,
  outputDriveFolderId: null,
  endFrameMode: 'auto',
}

export const END_FRAME_MODES: EndFrameMode[] = ['auto', 'always', 'off']

/** Counts offered as buttons — the row has to fit a phone screen. */
export const COUNT_CHOICES = [3, 5, 10, 20, 50] as const

/** Effects the buttons can toggle, in the order they are shown. */
export const EFFECT_KEYS: Array<keyof VideoEffectOpts> = [
  'brightness', 'contrast', 'saturation', 'hue', 'speed', 'flipH', 'crop', 'fade',
]

const EFFECT_LABEL: Record<string, string> = {
  brightness: 'Brightness', contrast: 'Contrast', saturation: 'Saturation',
  hue: 'Hue', speed: 'Speed', flipH: 'Flip', crop: 'Crop', fade: 'Fade',
}

export async function getRepurposeSettings(userId: string): Promise<TelegramRepurposeSettings> {
  const row = await one<{
    variant_count: number
    effects: VideoEffectOpts
    output_drive_folder_id: string | null
    end_frame_mode: EndFrameMode
  }>(
    `SELECT variant_count, effects, output_drive_folder_id, end_frame_mode
       FROM telegram_repurpose_settings WHERE user_id = $1`,
    [userId],
  )
  if (!row) return DEFAULTS
  return {
    variantCount: row.variant_count,
    // Merge over the defaults so a effect added later is not undefined on a row
    // written before it existed.
    effects: { ...DEFAULT_REPURPOSE_EFFECTS, ...(row.effects ?? {}) },
    outputDriveFolderId: row.output_drive_folder_id,
    endFrameMode: row.end_frame_mode ?? 'auto',
  }
}

export async function setVariantCount(userId: string, count: number): Promise<void> {
  await query(
    `INSERT INTO telegram_repurpose_settings (user_id, variant_count)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET variant_count = $2, updated_at = now()`,
    [userId, Math.min(100, Math.max(1, Math.round(count)))],
  )
}

export async function toggleEffect(userId: string, key: keyof VideoEffectOpts): Promise<void> {
  const current = await getRepurposeSettings(userId)
  const next = { ...current.effects, [key]: !current.effects[key] }
  await query(
    `INSERT INTO telegram_repurpose_settings (user_id, effects)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET effects = $2::jsonb, updated_at = now()`,
    [userId, JSON.stringify(next)],
  )
}

export async function setOutputFolder(userId: string, folderId: string | null): Promise<void> {
  await query(
    `INSERT INTO telegram_repurpose_settings (user_id, output_drive_folder_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET output_drive_folder_id = $2, updated_at = now()`,
    [userId, folderId],
  )
}

export async function setEndFrameMode(userId: string, mode: EndFrameMode): Promise<void> {
  await query(
    `INSERT INTO telegram_repurpose_settings (user_id, end_frame_mode)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET end_frame_mode = $2, updated_at = now()`,
    [userId, mode],
  )
}

const END_FRAME_LABEL: Record<EndFrameMode, string> = {
  auto: 'Auto — only when the clip has no internal cut',
  always: 'Always — pin a second keyframe on every clip',
  off: 'Off — animate from the start keyframe only',
}

export function endFrameSummary(mode: EndFrameMode): string {
  return [
    '🎬 <b>End frame mode</b>',
    `Current: <b>${mode}</b>`,
    '',
    ...END_FRAME_MODES.map(m => `${m === mode ? '•' : '◦'} <b>${m}</b> — ${END_FRAME_LABEL[m]}`),
  ].join('\n')
}

export function endFrameKeyboard(mode: EndFrameMode) {
  return {
    inline_keyboard: [
      END_FRAME_MODES.map(m => ({
        text: m === mode ? `• ${m} •` : m,
        callback_data: `mefset:${m}`,
      })),
    ],
  }
}

export function settingsSummary(s: TelegramRepurposeSettings): string {
  const on = EFFECT_KEYS.filter(k => s.effects[k]).map(k => EFFECT_LABEL[k])
  return [
    '⚙️ <b>Repurpose settings</b>',
    `Variants per video: <b>${s.variantCount}</b>`,
    `Effects: ${on.length ? on.join(', ') : '<i>none</i>'}`,
    s.outputDriveFolderId
      ? `Output folder: <code>${s.outputDriveFolderId}</code>`
      : 'Output: dated archive folders',
  ].join('\n')
}

/** Two rows of effect toggles, a row of counts, then the folder control. */
export function settingsKeyboard(s: TelegramRepurposeSettings) {
  const effectButtons = EFFECT_KEYS.map(k => ({
    text: `${s.effects[k] ? '✅' : '⬜️'} ${EFFECT_LABEL[k]}`,
    callback_data: `rsfx:${k}`,
  }))
  return {
    inline_keyboard: [
      COUNT_CHOICES.map(n => ({
        text: n === s.variantCount ? `• ${n} •` : String(n),
        callback_data: `rscount:${n}`,
      })),
      effectButtons.slice(0, 4),
      effectButtons.slice(4),
      [{
        text: s.outputDriveFolderId ? '📁 Clear output folder' : '📁 Set output folder',
        callback_data: 'rsfolder',
      }],
    ],
  }
}
