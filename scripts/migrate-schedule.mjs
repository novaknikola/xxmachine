import pg from 'pg'
import { readFileSync } from 'fs'

const { Pool } = pg

// Load .env.local manually
try {
  const env = readFileSync('.env.local', 'utf8')
  for (const line of env.split('\n')) {
    const [k, ...v] = line.split('=')
    if (k && v.length) process.env[k.trim()] = v.join('=').trim()
  }
} catch {}

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

await pool.query(`
  CREATE TABLE IF NOT EXISTS scheduled_posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    character_id TEXT NOT NULL,
    character_name TEXT NOT NULL,
    image_url TEXT NOT NULL,
    caption TEXT NOT NULL,
    platforms TEXT[] NOT NULL,
    scheduled_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_approval',
    telegram_message_id INTEGER,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    published_at TIMESTAMPTZ,
    error TEXT
  );
`)

console.log('✓ scheduled_posts table ready')
await pool.end()
