// Run once: node scripts/migrate-saas.mjs
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
  // 1. Extend users table
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS telegram TEXT,
      ADD COLUMN IF NOT EXISTS totp_secret TEXT,
      ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'inactive',
      ADD COLUMN IF NOT EXISTS subscription_plan TEXT,
      ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS bybit_order_id TEXT
  `)
  console.log('users columns OK')

  // Subscription status constraint (add only if not exists)
  await pool.query(`
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_subscription_status_check
  `)
  await pool.query(`
    ALTER TABLE users ADD CONSTRAINT users_subscription_status_check
      CHECK (subscription_status IN ('inactive', 'trial', 'active', 'expired', 'cancelled'))
  `)
  console.log('users subscription_status constraint OK')

  // Subscription plan constraint
  await pool.query(`
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_subscription_plan_check
  `)
  await pool.query(`
    ALTER TABLE users ADD CONSTRAINT users_subscription_plan_check
      CHECK (subscription_plan IS NULL OR subscription_plan IN ('monthly', 'yearly'))
  `)
  console.log('users subscription_plan constraint OK')

  // Update role constraint to include 'user'
  await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`)
  await pool.query(`
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN ('admin', 'chatter', 'user'))
  `)
  console.log('users role constraint updated OK')

  // 2. Per-user API settings (encrypted at app level)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      wavespeed_api_key TEXT,
      hf_token TEXT,
      apify_api_key TEXT,
      ig_app_id TEXT,
      ig_app_secret TEXT,
      threads_app_id TEXT,
      threads_app_secret TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  console.log('user_settings OK')

  // 3. LoRAs — add user scope
  await pool.query(`
    ALTER TABLE loras
      ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE
  `)
  console.log('loras user_id + is_public OK')

  // 4. Subscription events audit trail
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscription_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      plan TEXT,
      bybit_order_id TEXT,
      amount_usdt NUMERIC(12,2),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  console.log('subscription_events OK')

  // 5. platform_stats — add account_status for suspension detection
  await pool.query(`
    ALTER TABLE platform_stats
      ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'active'
  `)
  await pool.query(`
    ALTER TABLE platform_stats DROP CONSTRAINT IF EXISTS platform_stats_account_status_check
  `)
  await pool.query(`
    ALTER TABLE platform_stats ADD CONSTRAINT platform_stats_account_status_check
      CHECK (account_status IN ('active', 'suspended', 'not_found', 'private', 'error'))
  `)
  console.log('platform_stats account_status OK')

  await pool.end()
  console.log('\nMigration done.')
}

run().catch(err => { console.error(err); process.exit(1) })
