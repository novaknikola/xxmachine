/**
 * Personal access tokens for clients that can't carry the dashboard's
 * httpOnly session cookie — currently just the browser extension. Only the
 * SHA-256 hash is ever stored; the raw token is shown once, at generation
 * time, same as a GitHub PAT.
 */
import { randomBytes, createHash } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { one, query } from './db'
import type { SessionUser } from './session'
import { isOwnerEmail } from './session'

const TOKEN_PREFIX = 'xmpat_'

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(24).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

interface TokenRow {
  user_id: string
  email: string
  display_name: string
  role: 'admin' | 'user'
  active: boolean
}

/** API guard for bearer-token clients (the extension). Mirrors requireUser's shape. */
export async function requireApiToken(req: NextRequest): Promise<SessionUser | NextResponse> {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return NextResponse.json({ error: 'missing_token' }, { status: 401 })

  const hash = hashToken(token)
  const row = await one<TokenRow>(
    `select u.id as user_id, u.email, u.display_name, u.role, u.active
       from personal_access_tokens t
       join users u on u.id = t.user_id
      where t.token_hash = $1`,
    [hash],
  )
  if (!row || !row.active) return NextResponse.json({ error: 'invalid_token' }, { status: 401 })

  // Fire and forget — a slow write here must not hold up the actual request.
  void query(`update personal_access_tokens set last_used_at = now() where token_hash = $1`, [hash])

  return {
    id: row.user_id,
    email: row.email,
    display_name: row.display_name,
    role: row.role,
    isOwner: isOwnerEmail(row.email),
  }
}
