/** Shared AES-256-GCM helpers (same key material pattern as BYOK user keys). */
import { createCipheriv, createDecipheriv, randomBytes, createHmac } from 'node:crypto'

function deriveKey(purpose: string): Buffer {
  const secret = process.env.FANVUE_SESSION_SECRET
  if (!secret) throw new Error('FANVUE_SESSION_SECRET not set')
  return Buffer.from(createHmac('sha256', secret).update(purpose).digest())
}

export function encryptSecret(plaintext: string, purpose = 'xm_byok_v1'): string {
  const key = deriveKey(purpose)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':')
}

export function decryptSecret(enc: string, purpose = 'xm_byok_v1'): string {
  const [ivB64, tagB64, ctB64] = enc.split(':')
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('invalid encrypted value')
  const key = deriveKey(purpose)
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const ct = Buffer.from(ctB64, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

/** Dedicated purpose string for My Pod SSH / Comfy token secrets. */
export const MY_POD_SECRET_PURPOSE = 'xm_mypod_v1'
