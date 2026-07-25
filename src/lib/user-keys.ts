import { createCipheriv, createDecipheriv, randomBytes, createHmac } from 'node:crypto'
import { rows, query, one } from './db'

// AES-256-GCM encryption using FANVUE_SESSION_SECRET as key material
function deriveKey(): Buffer {
  const secret = process.env.FANVUE_SESSION_SECRET
  if (!secret) throw new Error('FANVUE_SESSION_SECRET not set')
  return Buffer.from(createHmac('sha256', secret).update('xm_byok_v1').digest())
}

function encrypt(plaintext: string): string {
  const key = deriveKey()
  const iv  = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':')
}

function decrypt(enc: string): string {
  const [ivB64, tagB64, ctB64] = enc.split(':')
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('invalid encrypted value')
  const key    = deriveKey()
  const iv     = Buffer.from(ivB64, 'base64')
  const tag    = Buffer.from(tagB64, 'base64')
  const ct     = Buffer.from(ctB64, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

// Known BYOK key names
export type ByokKeyName =
  | 'RUNPOD_API_KEY'
  | 'RAPIDAPI_KEY'
  | 'RUNPOD_ENDPOINT_WAN_V2V'
  | 'RUNPOD_ENDPOINT_I2V'
  | 'RUNPOD_ENDPOINT_ANIMATE'
  | 'WAVESPEED_API_KEY'
  | 'GOOGLE_DRIVE_FOLDER_ID'

export const BYOK_KEY_DEFS: { name: ByokKeyName; label: string; placeholder: string; required: boolean }[] = [
  { name: 'RUNPOD_API_KEY',            label: 'RunPod API Key',               placeholder: 'rpa_...', required: true },
  { name: 'RAPIDAPI_KEY',              label: 'RapidAPI Key',                 placeholder: 'rapidapi key for Instagram + TikTok scraper', required: true },
  { name: 'RUNPOD_ENDPOINT_WAN_V2V',   label: 'RunPod Endpoint — WAN V2V',   placeholder: 'endpoint ID', required: true },
  { name: 'RUNPOD_ENDPOINT_I2V',       label: 'RunPod Endpoint — WAN I2V',   placeholder: 'endpoint ID', required: false },
  { name: 'RUNPOD_ENDPOINT_ANIMATE',   label: 'RunPod Endpoint — WAN Animate', placeholder: 'endpoint ID', required: false },
  { name: 'WAVESPEED_API_KEY',         label: 'WaveSpeed API Key (override)', placeholder: 'leave blank to use the platform key', required: false },
  { name: 'GOOGLE_DRIVE_FOLDER_ID',    label: 'Google Drive Folder ID',       placeholder: 'folder ID from the Drive URL', required: false },
]

/** Save or update a single BYOK key for a user. */
export async function setUserKey(userId: string, keyName: string, value: string): Promise<void> {
  if (!value.trim()) {
    // Delete if empty
    await query(`delete from user_api_keys where user_id = $1 and key_name = $2`, [userId, keyName])
    return
  }
  const enc = encrypt(value.trim())
  await query(
    `insert into user_api_keys (user_id, key_name, key_enc, updated_at)
     values ($1, $2, $3, now())
     on conflict (user_id, key_name) do update set key_enc = $3, updated_at = now()`,
    [userId, keyName, enc],
  )
}

/** Get all decrypted keys for a user as a record. */
export async function getUserKeys(userId: string): Promise<Partial<Record<ByokKeyName, string>>> {
  const r = await rows<{ key_name: string; key_enc: string }>(
    `select key_name, key_enc from user_api_keys where user_id = $1`,
    [userId],
  )
  const out: Partial<Record<ByokKeyName, string>> = {}
  for (const row of r) {
    try {
      out[row.key_name as ByokKeyName] = decrypt(row.key_enc)
    } catch {
      // skip corrupted entries
    }
  }
  return out
}

/** Get a single key — falls back to env var if user hasn't set one. */
export async function resolveKey(userId: string, keyName: ByokKeyName): Promise<string | null> {
  const r = await one<{ key_enc: string }>(
    `select key_enc from user_api_keys where user_id = $1 and key_name = $2`,
    [userId, keyName],
  )
  if (r) {
    try { return decrypt(r.key_enc) } catch { /* fall through */ }
  }
  // Fallbacks to platform env vars
  const envFallbacks: Partial<Record<ByokKeyName, string | undefined>> = {
    WAVESPEED_API_KEY: process.env.WAVESPEED_API_KEY,
    RAPIDAPI_KEY: process.env.RAPIDAPI_KEY,
  }
  return envFallbacks[keyName] ?? null
}

/** Check if a user has the required RunPod keys set. */
export async function hasRunPodKeys(userId: string): Promise<boolean> {
  const keys = await getUserKeys(userId)
  return !!(keys.RUNPOD_API_KEY && keys.RAPIDAPI_KEY && keys.RUNPOD_ENDPOINT_WAN_V2V)
}
