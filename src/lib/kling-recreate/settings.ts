import { one, query } from '@/lib/db'
import type { KlingShotType, KlingVariant } from './kling-client'
import { DEFAULT_KLING_SETTINGS, type KlingUserSettings } from './types'

function asVariant(v: unknown): KlingVariant {
  return v === 'std' || v === '4k' || v === 'pro' ? v : DEFAULT_KLING_SETTINGS.variant
}

function asShotType(v: unknown): KlingShotType {
  return v === 'intelligence' ? 'intelligence' : 'customize'
}

export function normalizeSettings(raw: Partial<KlingUserSettings> | Record<string, unknown> | null | undefined): KlingUserSettings {
  const r = raw ?? {}
  const durationMode = r.duration_mode === 'fixed' ? 'fixed' : 'auto'
  const durationSec = Number(r.duration_sec)
  const cfg = Number(r.cfg_scale)
  const elements = Array.isArray(r.element_list)
    ? (r.element_list as unknown[]).map(x => String(x).trim()).filter(Boolean).slice(0, 3)
    : []
  return {
    variant: asVariant(r.variant),
    duration_mode: durationMode,
    duration_sec: durationMode === 'fixed' && Number.isFinite(durationSec)
      ? Math.min(15, Math.max(3, Math.round(durationSec)))
      : null,
    sound: r.sound !== false,
    cfg_scale: Number.isFinite(cfg) ? Math.min(1, Math.max(0, cfg)) : 0.5,
    shot_type: asShotType(r.shot_type),
    negative_prompt: typeof r.negative_prompt === 'string' && r.negative_prompt.trim()
      ? r.negative_prompt.trim()
      : null,
    element_list: elements,
  }
}

export async function getKlingSettings(userId: string): Promise<KlingUserSettings> {
  const row = await one<Record<string, unknown>>(
    `SELECT variant, duration_mode, duration_sec, sound, cfg_scale, shot_type, negative_prompt, element_list
       FROM kling_recreate_settings WHERE user_id = $1`,
    [userId],
  )
  return normalizeSettings(row)
}

export async function saveKlingSettings(userId: string, patch: Partial<KlingUserSettings>): Promise<KlingUserSettings> {
  const current = await getKlingSettings(userId)
  const next = normalizeSettings({ ...current, ...patch })
  await query(
    `INSERT INTO kling_recreate_settings
       (user_id, variant, duration_mode, duration_sec, sound, cfg_scale, shot_type, negative_prompt, element_list, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (user_id) DO UPDATE SET
       variant = EXCLUDED.variant,
       duration_mode = EXCLUDED.duration_mode,
       duration_sec = EXCLUDED.duration_sec,
       sound = EXCLUDED.sound,
       cfg_scale = EXCLUDED.cfg_scale,
       shot_type = EXCLUDED.shot_type,
       negative_prompt = EXCLUDED.negative_prompt,
       element_list = EXCLUDED.element_list,
       updated_at = now()`,
    [
      userId,
      next.variant,
      next.duration_mode,
      next.duration_sec,
      next.sound,
      next.cfg_scale,
      next.shot_type,
      next.negative_prompt,
      next.element_list,
    ],
  )
  return next
}

export function formatSettingsHtml(s: KlingUserSettings): string {
  const duration = s.duration_mode === 'auto'
    ? 'auto (from source, clamped 3–15s)'
    : `${s.duration_sec}s`
  const elements = s.element_list.length ? s.element_list.join(', ') : 'none'
  return [
    `<b>Kling 3.0 settings</b>`,
    `Variant: <code>${s.variant}</code>`,
    `Duration: ${duration}`,
    `Sound: ${s.sound ? 'on' : 'off'}`,
    `CFG: ${s.cfg_scale}`,
    `Shot type: ${s.shot_type}`,
    `Negative prompt: ${s.negative_prompt ? escapeHtml(s.negative_prompt) : '<i>none</i>'}`,
    `Elements: ${escapeHtml(elements)}`,
  ].join('\n')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
