import { one, query, rows } from '@/lib/db'
import { sanitizeDriveKey } from '@/lib/drive-archive/paths'

export interface ContentCharacter {
  id: string
  name: string
  /** Own reference photo, else the first face ref — the photo Wan 3.0 takes identity from. */
  reference_image_url: string | null
  /** Prompt for the Seedream + Z-Image still that goes to Wan with the reference photo. */
  wan_prompt: string | null
}

const SELECT = `SELECT id, name, COALESCE(reference_image_url, face_ref_urls[1]) AS reference_image_url, wan_prompt
                  FROM characters`

/** The Drive folder name the character's archive lives under, e.g. "Tiana Goth" → "tiana_goth". */
export function characterDriveKey(name: string): string {
  return sanitizeDriveKey(name)
}

export async function listCharacters(userId: string): Promise<ContentCharacter[]> {
  return await rows<ContentCharacter>(`${SELECT} WHERE user_id = $1 ORDER BY lower(name)`, [userId])
}

export async function getCharacter(userId: string, id: string): Promise<ContentCharacter | null> {
  return await one<ContentCharacter>(`${SELECT} WHERE user_id = $1 AND id = $2`, [userId, id])
}

export async function findCharacterByName(userId: string, name: string): Promise<ContentCharacter | null> {
  return await one<ContentCharacter>(
    `${SELECT} WHERE user_id = $1 AND lower(name) = lower($2) ORDER BY created_at LIMIT 1`,
    [userId, name.trim()],
  )
}

/** Sets the character's reference photo, creating the character if it does not exist yet. */
export async function setCharacterReference(
  userId: string,
  name: string,
  referenceImageUrl: string,
): Promise<ContentCharacter> {
  const existing = await findCharacterByName(userId, name)
  if (existing) {
    await query(`UPDATE characters SET reference_image_url = $2 WHERE id = $1`, [existing.id, referenceImageUrl])
    return { ...existing, reference_image_url: referenceImageUrl }
  }
  const created = await one<ContentCharacter>(
    `INSERT INTO characters (user_id, name, reference_image_url)
     VALUES ($1, $2, $3)
     RETURNING id, name, reference_image_url, wan_prompt`,
    [userId, name.trim(), referenceImageUrl],
  )
  return created!
}

/** Empty text clears the prompt. Null when the character does not exist. */
export async function setCharacterPrompt(
  userId: string,
  name: string,
  prompt: string,
): Promise<ContentCharacter | null> {
  const existing = await findCharacterByName(userId, name)
  if (!existing) return null
  const value = prompt.trim() || null
  await query(`UPDATE characters SET wan_prompt = $2 WHERE id = $1`, [existing.id, value])
  return { ...existing, wan_prompt: value }
}

/** Character prompt, then the batch's own addition — what the still is generated from. */
export function composeStillPrompt(characterPrompt: string | null | undefined, batchPrompt: string | null | undefined): string {
  return [characterPrompt, batchPrompt].map(p => p?.trim()).filter(Boolean).join('\n')
}
