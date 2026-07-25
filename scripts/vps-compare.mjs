#!/usr/bin/env node
/**
 * Compare local repo with VPS app tree. Requires SSH key at ~/.ssh/xxmachine_vps
 * Usage: node scripts/vps-compare.mjs
 */
import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const VPS = 'root@153.92.223.89'
const KEY = join(homedir(), '.ssh', 'xxmachine_vps')
const REMOTE = '/var/www/xxmachine'
const ssh = existsSync(KEY)
  ? `ssh -i "${KEY}" -o StrictHostKeyChecking=accept-new ${VPS}`
  : `ssh -o StrictHostKeyChecking=accept-new ${VPS}`

function remote(cmd) {
  return execSync(`${ssh} ${JSON.stringify(cmd)}`, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
}

console.log('=== VPS git ===')
try {
  console.log(remote(`cd ${REMOTE} && git log -1 --oneline && git status -sb | head -5`))
} catch (e) {
  console.error('SSH failed:', e.message)
  process.exit(1)
}

console.log('\n=== Local git ===')
try {
  console.log(execSync('git log -1 --oneline && git status -sb | head -5', { encoding: 'utf8', cwd: process.cwd() }))
} catch { /* ignore */ }

console.log('\n=== Migration files on VPS (src/db/migrations) ===')
console.log(remote(`ls -1 ${REMOTE}/src/db/migrations/*.sql 2>/dev/null | wc -l && ls -1 ${REMOTE}/src/db/migrations/*.sql 2>/dev/null | tail -5`))

console.log('\n=== Key paths only on VPS (untracked sample) ===')
console.log(remote(`cd ${REMOTE} && git status -u --porcelain 2>/dev/null | grep '^??' | head -30`))

console.log('\n=== PM2 ===')
console.log(remote('pm2 jlist 2>/dev/null | head -c 500 || pm2 list'))
