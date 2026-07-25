import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12  // 96-bit IV recommended for GCM
const TAG_LEN = 16

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) throw new Error('ENCRYPTION_KEY env var is not set')
  const key = Buffer.from(raw, 'hex')
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes)')
  return key
}

/** Encrypts a plaintext string. Returns `iv:authTag:ciphertext` as hex. */
export function encrypt(plaintext: string): string {
  const key = getKey()
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

/** Decrypts a value produced by `encrypt()`. Returns the original plaintext. */
export function decrypt(encoded: string): string {
  const key = getKey()
  const parts = encoded.split(':')
  if (parts.length !== 3) throw new Error('Invalid encrypted value format')
  const [ivHex, tagHex, dataHex] = parts
  const iv = Buffer.from(ivHex, 'hex')
  const tag = Buffer.from(tagHex, 'hex')
  const data = Buffer.from(dataHex, 'hex')
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(data) + decipher.final('utf8')
}

/** Encrypt only if value is non-empty, otherwise return null. */
export function encryptOrNull(value: string | null | undefined): string | null {
  if (!value) return null
  return encrypt(value)
}

/** Decrypt only if value is non-null, otherwise return null. */
export function decryptOrNull(encoded: string | null | undefined): string | null {
  if (!encoded) return null
  try {
    return decrypt(encoded)
  } catch {
    return null
  }
}
