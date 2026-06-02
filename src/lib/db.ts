import { Pool, type QueryResult, type QueryResultRow } from 'pg'

declare global {
  // eslint-disable-next-line no-var
  var __xmDbPool: Pool | undefined
}

function getPool(): Pool {
  if (!global.__xmDbPool) {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set in env')
    }
    global.__xmDbPool = new Pool({
      connectionString,
      ssl: connectionString.includes('supabase.com') ? { rejectUnauthorized: false } : undefined,
      max: 5,
      idleTimeoutMillis: 60_000,
      connectionTimeoutMillis: 20_000,
    })
  }
  return global.__xmDbPool
}

/** Run a parameterised query. Returns the typed rows. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: ReadonlyArray<unknown>,
): Promise<QueryResult<T>> {
  const pool = getPool()
  return pool.query<T>(text, params as unknown[] | undefined)
}

/** Convenience: returns just the rows array. */
export async function rows<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: ReadonlyArray<unknown>,
): Promise<T[]> {
  const r = await query<T>(text, params)
  return r.rows
}

/** Convenience: first row or null. */
export async function one<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: ReadonlyArray<unknown>,
): Promise<T | null> {
  const r = await query<T>(text, params)
  return r.rows[0] ?? null
}
