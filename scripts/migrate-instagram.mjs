import { spawnSync } from 'child_process'

console.log('Instagram schema is managed by src/db/migrations/004_instagram_accounts.sql')
console.log('Running unified migration instead...')

const result = spawnSync('npm', ['run', 'db:migrate'], {
  stdio: 'inherit',
  shell: true,
})

process.exit(result.status ?? 0)