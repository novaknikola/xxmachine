#!/usr/bin/env node
// Fails (exit 1) if the obfuscated Ethereum-C2 dropper that was injected into
// postcss.config.mjs is present anywhere in source. Must stay dependency-free
// and must run BEFORE anything loads a config file (dev, build, deploy).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'tmp-e2e', 'prompts', 'chrome-profiles'])
const CODE_EXT = /\.(mjs|cjs|js|jsx|ts|tsx|json)$/

const SIGNATURES = [
  { name: 'global.i marker', re: /global\s*\.\s*i\s*=\s*['"][A-Z0-9]+-\d+['"]/ },
  { name: "global['r']=require", re: /global\s*\[\s*['"][rm]['"]\s*\]\s*=\s*(require|module)/ },
  { name: 'obfuscator identifiers', re: /(_0x[0-9a-f]{4,6}\b[\s\S]{0,40}){6,}/ },
  { name: 'code hidden after whitespace run', re: /[;})\]]['"]?[ \t]{60,}\S/ },
]

// Files an attacker used as hosts; the ESM require shim is how the payload gets `require`.
const CONFIG_FILES = ['postcss.config.mjs', 'tailwind.config.ts', 'next.config.ts', 'eslint.config.mjs']
const CONFIG_ONLY = [{ name: 'createRequire in build config', re: /createRequire/ }]

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) yield* walk(full)
    else if (CODE_EXT.test(name) || name === 'tasks.json') yield full
  }
}

const hits = []
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file)
  if (rel === 'package-lock.json' || rel.startsWith('scripts/check-code-integrity')) continue
  const text = readFileSync(file, 'utf8')
  const checks = CONFIG_FILES.includes(rel) ? [...SIGNATURES, ...CONFIG_ONLY] : SIGNATURES
  for (const { name, re } of checks) if (re.test(text)) hits.push(`${rel}: ${name}`)
}

if (hits.length) {
  console.error('\n[integrity] BLOCKED — known malware signatures found:\n  ' + hits.join('\n  '))
  console.error('\nDo not run, build or deploy this tree. See SECURITY-INCIDENT.md.\n')
  process.exit(1)
}
console.log('[integrity] ok')
