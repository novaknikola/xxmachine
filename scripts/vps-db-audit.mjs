import pg from 'pg'
import { readFileSync } from 'node:fs'

const env = readFileSync('.env.local', 'utf8')
for (const line of env.split('\n')) {
  const t = line.trim()
  if (!t || t.startsWith('#')) continue
  const i = t.indexOf('=')
  if (i < 0) continue
  process.env[t.slice(0, i).trim()] ??= t.slice(i + 1).trim()
}

const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

const mig = await c.query('SELECT name FROM schema_migrations ORDER BY name')
console.log('=== APPLIED MIGRATIONS ===')
console.log(mig.rows.map(r => r.name).join('\n'))

const tables = await c.query(
  "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1",
)
console.log('\n=== TABLES ===')
console.log(tables.rows.map(r => r.tablename).join('\n'))

const users = await c.query('SELECT count(*)::int AS n FROM users')
console.log('\n=== users count ===', users.rows[0].n)

await c.end()
