// Run once: node scripts/migrate-analytics.mjs
import pg from 'pg'
import { readFileSync } from 'fs'
const { Pool } = pg

try {
  const env = readFileSync('.env.local', 'utf8')
  for (const line of env.split('\n')) {
    const [k, ...v] = line.split('=')
    if (k && v.length) process.env[k.trim()] = v.join('=').trim()
  }
} catch {}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('supabase.com') ? { rejectUnauthorized: false } : undefined,
})

async function run() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS social_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      platform TEXT NOT NULL CHECK (platform IN ('twitter', 'tiktok')),
      username TEXT NOT NULL,
      display_name TEXT,
      avatar_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(platform, username)
    )
  `)
  console.log('social_accounts OK')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_stats (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      platform TEXT NOT NULL CHECK (platform IN ('instagram', 'threads', 'twitter', 'tiktok')),
      account_id TEXT NOT NULL,
      account_name TEXT NOT NULL,
      followers BIGINT,
      following BIGINT,
      posts_count INTEGER,
      views_30d BIGINT,
      reach_30d BIGINT,
      impressions_30d BIGINT,
      likes_total BIGINT,
      raw JSONB,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  console.log('platform_stats OK')

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_platform_stats_lookup
      ON platform_stats(platform, account_id, fetched_at DESC)
  `)
  console.log('idx_platform_stats_lookup OK')

  await pool.end()
  console.log('Migration done.')
}

run().catch(err => { console.error(err); process.exit(1) })
