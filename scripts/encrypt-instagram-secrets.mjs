// Encrypt leftover plaintext ig_access_token / ig_password / ig_totp_secret.
// Invoked from scripts/migrate.mjs after SQL migrations. Never logs secret values.

import { createCipheriv, randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { config as loadEnv } from 'dotenv'
import pkg from 'pg'

const { Pool } = pkg

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

loadEnv({ path: resolve(__dirname, '..', '.env.local') })

const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const ENCRYPTED_RE = /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/i
const COLUMNS = ['ig_access_token', 'ig_password', 'ig_totp_secret']

function getKey() {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) throw new Error('ENCRYPTION_KEY env var is not set')
  const key = Buffer.from(raw, 'hex')
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes)')
  return key
}

function encrypt(plaintext) {
  const key = getKey()
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

function looksEncrypted(value) {
  return typeof value === 'string' && ENCRYPTED_RE.test(value)
}

export async function encryptInstagramSecrets(pool) {
  const result = await pool.query(
    `SELECT id, ig_access_token, ig_password, ig_totp_secret
       FROM instagram_accounts
      WHERE ig_access_token IS NOT NULL
         OR ig_password IS NOT NULL
         OR ig_totp_secret IS NOT NULL`,
  )

  let updated = 0
  let already = 0
  for (const row of result.rows) {
    const sets = []
    const values = []
    for (const col of COLUMNS) {
      const current = row[col]
      if (!current) continue
      if (looksEncrypted(current)) {
        already++
        continue
      }
      const encoded = encrypt(current)
      if (encoded === current || !looksEncrypted(encoded)) {
        throw new Error(`Refusing to write plaintext for ${col}`)
      }
      values.push(encoded)
      sets.push(`${col} = $${values.length}`)
    }
    if (!sets.length) continue
    values.push(row.id)
    await pool.query(
      `UPDATE instagram_accounts SET ${sets.join(', ')} WHERE id = $${values.length}`,
      values,
    )
    updated++
  }

  return { scanned: result.rows.length, updated, alreadyEncryptedFields: already }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isMain) {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Add it to .env.local.')
    process.exit(1)
  }
  if (!process.env.ENCRYPTION_KEY) {
    console.error('ENCRYPTION_KEY is not set — cannot encrypt Instagram secrets.')
    process.exit(1)
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('supabase.com') ? { rejectUnauthorized: false } : undefined,
  })
  encryptInstagramSecrets(pool)
    .then(stats => {
      console.log(
        `Instagram secrets: scanned ${stats.scanned} row(s), encrypted ${stats.updated}, already-ciphertext fields ${stats.alreadyEncryptedFields}`,
      )
    })
    .catch(err => {
      console.error(err)
      process.exit(1)
    })
    .finally(() => pool.end())
}
