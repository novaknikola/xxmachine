import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .env.local
try {
  const env = readFileSync(resolve(__dirname, '../.env.local'), 'utf8')
  for (const line of env.split('\n')) {
    const [k, ...v] = line.split('=')
    if (k && v.length && !k.startsWith('#')) {
      process.env[k.trim()] = v.join('=').trim()
    }
  }
} catch {}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

async function run() {
  const client = await pool.connect()
  try {
    // Drop old subscription_plan CHECK, add new one with tier names
    await client.query(`
      ALTER TABLE users
        DROP CONSTRAINT IF EXISTS users_subscription_plan_check;
    `)
    await client.query(`
      ALTER TABLE users
        ADD CONSTRAINT users_subscription_plan_check
        CHECK (subscription_plan IN ('starter', 'pro', 'agency'));
    `)

    // Update role constraint: remove 'chatter'
    await client.query(`
      ALTER TABLE users
        DROP CONSTRAINT IF EXISTS users_role_check;
    `)
    await client.query(`
      ALTER TABLE users
        ADD CONSTRAINT users_role_check
        CHECK (role IN ('admin', 'user'));
    `)

    // Migrate existing chatters to user role
    await client.query(`UPDATE users SET role = 'user' WHERE role = 'chatter'`)

    // Migrate old monthly/yearly plan values
    await client.query(`UPDATE users SET subscription_plan = 'starter' WHERE subscription_plan = 'monthly'`)
    await client.query(`UPDATE users SET subscription_plan = NULL WHERE subscription_plan = 'yearly'`)

    console.log('✅ Migration complete: tiers + role cleanup')
  } finally {
    client.release()
    await pool.end()
  }
}

run().catch(err => { console.error(err); process.exit(1) })
