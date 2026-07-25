import { one } from '@/lib/db'
import { decryptOrNull } from '@/lib/crypto'

interface UserSettingsRow {
  wavespeed_api_key: string | null
  hf_token: string | null
  apify_api_key: string | null
  ig_app_id: string | null
  ig_app_secret: string | null
  threads_app_id: string | null
  threads_app_secret: string | null
}

type ApiKeyName = keyof UserSettingsRow

/**
 * Returns the user's API key for a given service, falling back to the global
 * env var if the user hasn't set their own.
 */
export async function getUserApiKey(
  userId: string,
  keyName: ApiKeyName,
  envFallback?: string,
): Promise<string> {
  const row = await one<UserSettingsRow>(
    `SELECT wavespeed_api_key, hf_token, apify_api_key,
            ig_app_id, ig_app_secret, threads_app_id, threads_app_secret
     FROM user_settings WHERE user_id = $1`,
    [userId],
  )

  const encrypted = row?.[keyName] ?? null
  const userKey = decryptOrNull(encrypted)
  if (userKey) return userKey

  // Fallback to global env var
  const envMap: Record<ApiKeyName, string | undefined> = {
    wavespeed_api_key: process.env.WAVESPEED_API_KEY,
    hf_token: process.env.HF_TOKEN,
    apify_api_key: process.env.APIFY_API_KEY,
    ig_app_id: process.env.INSTAGRAM_APP_ID,
    ig_app_secret: process.env.INSTAGRAM_APP_SECRET,
    threads_app_id: process.env.THREADS_APP_ID,
    threads_app_secret: process.env.THREADS_APP_SECRET,
  }

  const fallback = envFallback ?? envMap[keyName]
  if (!fallback) throw new Error(`No API key configured for: ${keyName}`)
  return fallback
}
