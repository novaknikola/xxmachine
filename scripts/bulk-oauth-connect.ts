// Bulk version of test-ig-auto-oauth-connect.ts — loops the same
// connectAccountViaOAuth flow over multiple account IDs sequentially, same
// pacing as the bulk-oauth-connect API route. Run manually on the VPS:
//   DISPLAY=:99 npx tsx scripts/bulk-oauth-connect.ts <accountId1> <accountId2> ...
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import { connectAccountViaOAuth } from '../src/lib/instagram/auto-oauth-connect'

async function main() {
  const accountIds = process.argv.slice(2)
  if (!accountIds.length) {
    console.error('Usage: tsx scripts/bulk-oauth-connect.ts <accountId1> <accountId2> ...')
    process.exit(1)
  }

  const results: Record<string, string> = {}

  for (const accountId of accountIds) {
    console.log(`Connecting ${accountId}...`)
    try {
      const result = await connectAccountViaOAuth(accountId)
      results[accountId] = `ok: ${result.username}`
      console.log(`  ✓ ${accountId} -> ${result.username}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      results[accountId] = message
      console.log(`  ✗ ${accountId}: ${message}`)
    }
    await new Promise(r => setTimeout(r, 4000))
  }

  console.log('\n=== Summary ===')
  console.log(JSON.stringify(results, null, 2))
  const failed = Object.values(results).filter(v => !v.startsWith('ok:')).length
  if (failed > 0) process.exitCode = 1
}

main()
