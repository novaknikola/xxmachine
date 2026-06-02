import pg from 'pg'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = resolve(__dirname, '../.env.local')

try {
  const env = readFileSync(envPath, 'utf8')
  for (const line of env.split('\n')) {
    const [k, ...v] = line.split('=')
    if (k && v.length) process.env[k.trim()] = v.join('=').trim()
  }
} catch {}

const { Pool } = pg
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

async function run() {
  console.log('Running Instagram + Google Drive migration...')

  await pool.query(`
    ALTER TABLE characters
      ADD COLUMN IF NOT EXISTS instagram_user_id TEXT,
      ADD COLUMN IF NOT EXISTS instagram_username TEXT,
      ADD COLUMN IF NOT EXISTS instagram_access_token TEXT,
      ADD COLUMN IF NOT EXISTS instagram_token_expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS google_access_token TEXT,
      ADD COLUMN IF NOT EXISTS google_refresh_token TEXT,
      ADD COLUMN IF NOT EXISTS google_drive_folder_id TEXT,
      ADD COLUMN IF NOT EXISTS proxy_url TEXT,
      ADD COLUMN IF NOT EXISTS ig_username TEXT,
      ADD COLUMN IF NOT EXISTS ig_password TEXT,
      ADD COLUMN IF NOT EXISTS ig_totp_secret TEXT,
      ADD COLUMN IF NOT EXISTS ig_oauth_state TEXT,
      ADD COLUMN IF NOT EXISTS ig_session JSONB,
      ADD COLUMN IF NOT EXISTS browser_fingerprint JSONB;
  `)
  console.log('✓ characters table updated')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS instagram_queue (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      character_id UUID REFERENCES characters(id) ON DELETE CASCADE,
      drive_file_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      caption TEXT DEFAULT '',
      scheduled_at TIMESTAMPTZ,
      published_at TIMESTAMPTZ,
      instagram_media_id TEXT,
      error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `)
  console.log('✓ instagram_queue table created')

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_instagram_queue_character_status
      ON instagram_queue(character_id, status, scheduled_at);
  `)
  console.log('✓ index created')

  await pool.end()
  console.log('Migration complete.')
}

run().catch(err => { console.error(err); process.exit(1) })
