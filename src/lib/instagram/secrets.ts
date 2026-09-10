import { encrypt, decrypt } from '@/lib/crypto'

/** AES-GCM payload from `encrypt()`: `iv(12B hex):tag(16B hex):ciphertext hex`. */
const ENCRYPTED_RE = /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/i

export const IG_SECRET_COLUMNS = ['ig_access_token', 'ig_password', 'ig_totp_secret'] as const
export type IgSecretColumn = (typeof IG_SECRET_COLUMNS)[number]

export function looksEncrypted(value: string | null | undefined): boolean {
  if (!value) return false
  return ENCRYPTED_RE.test(value)
}

/** Encrypt a secret. Never returns the input plaintext. */
export function encryptIgSecret(plaintext: string): string {
  const encoded = encrypt(plaintext)
  if (encoded === plaintext) {
    throw new Error('encryptIgSecret refused to store plaintext')
  }
  if (!looksEncrypted(encoded)) {
    throw new Error('encryptIgSecret produced a value that is not in the expected ciphertext format')
  }
  return encoded
}

export function encryptIgSecretOrNull(value: string | null | undefined): string | null {
  if (!value) return null
  return encryptIgSecret(value)
}

/**
 * Decrypt a stored secret. Legacy plaintext (pre-migration) is returned as-is
 * so readers keep working until the encrypt migration / next write re-saves it.
 */
export function decryptIgSecret(stored: string): string {
  if (looksEncrypted(stored)) return decrypt(stored)
  return stored
}

export function decryptIgSecretOrNull(stored: string | null | undefined): string | null {
  if (!stored) return null
  try {
    return decryptIgSecret(stored)
  } catch {
    return null
  }
}
