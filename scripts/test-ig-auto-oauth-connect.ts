// One-account live test for the automated Instagram login + OAuth authorize
// flow. Run manually on the VPS (needs the real app's DB, so run from the
// deployed checkout, not locally):
//   DISPLAY=:99 npx tsx scripts/test-ig-auto-oauth-connect.ts <accountId>
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import { connectAccountViaOAuth } from '../src/lib/instagram/auto-oauth-connect'

async function main() {
  const accountId = process.argv[2]
  if (!accountId) {
    console.error('Usage: tsx scripts/test-ig-auto-oauth-connect.ts <accountId>')
    process.exit(1)
  }

  console.log('Connecting account', accountId, '...')
  try {
    const result = await connectAccountViaOAuth(accountId)
    console.log('✓ Done. Instagram username:', result.username)
    console.log('Check the instagram_accounts row for ig_access_token/ig_user_id to confirm the callback actually wrote the token.')
  } catch (err) {
    console.error('✗ Failed:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  } finally {
    console.log('Screenshots saved to /root/ig-oauth-debug/')
  }
}

main()
