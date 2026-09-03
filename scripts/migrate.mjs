// Apply all SQL files in src/db/migrations in order, skipping ones already applied.
// Usage: node scripts/migrate.mjs

import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { config as loadEnv } from 'dotenv'
import pkg from 'pg'

const { Pool } = pkg

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

loadEnv({ path: resolve(__dirname, '..', '.env.local') })

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('DATABASE_URL is not set. Add it to .env.local.')
  process.exit(1)
}

const pool = new Pool({
  connectionString,
  ssl: connectionString.includes('supabase.com') ? { rejectUnauthorized: false } : undefined,
})

async function ensureMigrationsTable() {
  await pool.query(`
    create table if not exists schema_migrations (
      name        text primary key,
      applied_at  timestamptz not null default now()
    );
  `)
}

async function applied() {
  const r = await pool.query('select name from schema_migrations order by name')
  return new Set(r.rows.map(row => row.name))
}

async function run() {
  await ensureMigrationsTable()
  const done = await applied()
  const dir = resolve(__dirname, '..', 'src', 'db', 'migrations')
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()

  let ran = 0
  for (const f of files) {
    if (done.has(f)) {
      console.log(`✓ ${f} (already applied)`)
      continue
    }
    const sql = readFileSync(join(dir, f), 'utf8')
    console.log(`→ applying ${f}…`)
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query(sql)
      await client.query('insert into schema_migrations (name) values ($1)', [f])
      await client.query('commit')
      console.log(`✓ ${f}`)
      ran++
    } catch (err) {
      await client.query('rollback')
      console.error(`✗ ${f}:`, err.message)
      process.exit(1)
    } finally {
      client.release()
    }
  }

  if (ran === 0) console.log('Nothing to do — schema is up to date.')
  else console.log(`Done. Applied ${ran} migration(s).`)

  // AES-GCM encrypt leftover plaintext IG secrets (tokens / passwords / TOTP).
  // SQL cannot do this; new writes go through src/lib/instagram/secrets.ts.
  try {
    const table = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'instagram_accounts'`,
    )
    if (table.rowCount && process.env.ENCRYPTION_KEY) {
      const { encryptInstagramSecrets } = await import('./encrypt-instagram-secrets.mjs')
      const stats = await encryptInstagramSecrets(pool)
      console.log(
        `✓ instagram secret encrypt: ${stats.updated} row(s) migrated, ${stats.alreadyEncryptedFields} field(s) already ciphertext`,
      )
    } else if (table.rowCount && !process.env.ENCRYPTION_KEY) {
      console.warn('! ENCRYPTION_KEY is not set — skipped Instagram secret encryption. New tokens will refuse to write plaintext.')
    }
  } catch (err) {
    console.error('✗ instagram secret encrypt:', err.message)
    process.exit(1)
  }

  await pool.end()
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
