import crypto from 'crypto'
import path from 'path'
import fs from 'fs'

interface ServiceAccountKey {
  client_email: string
  private_key: string
}

function loadKey(): ServiceAccountKey {
  const keyPath = path.join(process.cwd(), 'secrets', 'google-service-account.json')
  return JSON.parse(fs.readFileSync(keyPath, 'utf8'))
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

let cachedToken: { token: string; expiresAt: number } | null = null

export async function getGoogleAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token

  const key = loadKey()
  const now = Math.floor(Date.now() / 1000)

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }))

  const signing = `${header}.${payload}`
  const sign = crypto.createSign('RSA-SHA256')
  sign.update(signing)
  const signature = base64url(sign.sign(key.private_key))
  const jwt = `${signing}.${signature}`

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })

  const data = await res.json()
  if (!res.ok) throw new Error(data.error_description ?? data.error ?? 'Google token failed')

  cachedToken = { token: data.access_token, expiresAt: now * 1000 + 3500 * 1000 }
  return data.access_token
}
