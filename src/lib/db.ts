import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'

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
      // The app is not just serving pages: the queue worker, cron tick and a
      // polling UI all compete for this pool at once, and 5 clients ran out
      // under a long Copy Prompts batch — routes then failed with "timeout
      // exceeded when trying to connect" and returned an empty 500 body.
      // DATABASE_URL points at Supabase's transaction-mode pooler (port 6543),
      // which multiplexes onto far fewer server-side connections, so a larger
      // client pool here is cheap.
      max: 20,
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

/** Borrow a client for transactions / advisory locks. Always releases. */
export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    return await fn(client)
  } finally {
    client.release()
  }
}
