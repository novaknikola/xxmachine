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

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

await pool.query(`
  CREATE TABLE IF NOT EXISTS fans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id TEXT NOT NULL,
    name TEXT NOT NULL,
    handle TEXT,
    avatar_url TEXT,
    total_spend_cents INTEGER NOT NULL DEFAULT 0,
    location TEXT,
    occupation TEXT,
    age INTEGER,
    notes TEXT NOT NULL DEFAULT '',
    tags TEXT[] NOT NULL DEFAULT '{}',
    ai_summary JSONB,
    ai_summary_at TIMESTAMPTZ,
    fanvue_uuid TEXT,
    payday JSONB NOT NULL DEFAULT '{"kind":"none"}',
    weekly_schedule JSONB NOT NULL DEFAULT '{}',
    important_dates JSONB NOT NULL DEFAULT '[]',
    manual_spend_entries JSONB NOT NULL DEFAULT '[]',
    status TEXT,
    lifetime_gross_cents INTEGER,
    max_single_payment_cents INTEGER,
    spending_sources JSONB,
    last_purchase_at TIMESTAMPTZ,
    subscription_created_at TIMESTAMPTZ,
    subscription_renews_at TIMESTAMPTZ,
    auto_renewal_enabled BOOLEAN,
    is_top_spender BOOLEAN,
    synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`)
console.log('✓ fans table ready')

await pool.query(`
  CREATE TABLE IF NOT EXISTS fan_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fan_id UUID NOT NULL REFERENCES fans(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    is_creator BOOLEAN NOT NULL DEFAULT false,
    chatter_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`)
console.log('✓ fan_messages table ready')

await pool.end()
