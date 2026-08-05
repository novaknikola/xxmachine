// Run once: node scripts/migrate-threads.js
const { resolve } = require('node:path')
const { Pool } = require('pg')

// Every other migration script loads this itself; deploy.sh does not export the
// env. Without it DATABASE_URL is undefined, pg silently falls back to
// localhost:5432, and the script fails ECONNREFUSED on every single deploy.
require('dotenv').config({ path: resolve(__dirname, '..', '.env.local') })

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('supabase.com') ? { rejectUnauthorized: false } : undefined,
})

async function run() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS threads_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      threads_username TEXT,
      threads_user_id TEXT,
      access_token TEXT,
      token_expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  console.log('threads_accounts OK')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS threads_queue (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID NOT NULL REFERENCES threads_accounts(id) ON DELETE CASCADE,
      content TEXT NOT NULL DEFAULT '',
      media_url TEXT,
      media_type TEXT NOT NULL DEFAULT 'TEXT',
      status TEXT NOT NULL DEFAULT 'pending',
      threads_media_id TEXT,
      error_message TEXT,
      scheduled_at TIMESTAMPTZ,
      published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  console.log('threads_queue OK')

  await pool.end()
  console.log('Migration done.')
}

run().catch(err => { console.error(err); process.exit(1) })
