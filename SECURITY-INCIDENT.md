# Security incident — config-file dropper (Ethereum C2)

Status: **source cleaned, root cause (infected dev machine) NOT yet fixed, VPS NOT yet checked.**

## What it is

Obfuscated JavaScript appended to `postcss.config.mjs` after hundreds of tabs, so it is
off-screen in an editor. Starts with `global.i = 'A8-7105'; ... global['r']=require`,
resolves its command server from Ethereum transactions and uses `child_process.spawn`.
It runs every time the config is loaded — **`npm run dev`, `npm run build`, and therefore
every deploy (`deploy.sh` runs `npm run build`)**. `import { createRequire }` at the top of
the file is its scaffolding, not app code.

## Timeline (from git history)

| Commit | Date | Event |
|---|---|---|
| `10bbe79` | 2026-09-08 | First injection, inside an unrelated commit ("Fix stale Drive folder link…") |
| `68667de` | 2026-09-10 | Re-injected (mutated) |
| `88c5027` | 2026-09-13 | Removed |
| `2173ece` | 2026-09-17 | Re-injected inside "Never reuse an existing folder…" |
| `b6bd58d` | 2026-09-19 | Removed again (`createRequire` left behind) |

Every injecting commit is authored `novaknikola`, time zone +0700, and bundled with real
work. That means **the machine those commits were made on rewrites the file on disk** and it
was then staged with the rest. No npm `postinstall`, git hook or workflow in this repo does it.

## Done in this repo

- `postcss.config.mjs` restored to the plain config (no `createRequire`).
- `scripts/check-code-integrity.mjs` — dependency-free signature scan.
  Runs as `predev`, `prebuild`, and in `deploy.sh` right after `git pull`, before `npm ci`,
  so an infected tree can no longer build or deploy; the previous build stays live.
- All remote branch tips were scanned: no full payload; all still carry the `createRequire` shim.

## Still to do (cannot be done from the Mac — no VPS key there)

1. **Dev PC (the +0700 machine)** — treat as compromised: check editor extensions
   (VS Code/Cursor), `.vscode/tasks.json` in every repo (look for `runOn: folderOpen`),
   globally installed npm packages, scheduled tasks/startup items. Scan every repo on it
   for `global.i =`. Until cleaned, do not commit from it.
2. **VPS** — was built during both infected windows, so the payload ran as root:
   check `ps aux`, `crontab -l`, `/etc/cron*`, `~/.bashrc`, `/root/.ssh/authorized_keys`,
   `pm2 list`, unexpected files in `/tmp` and `/var/tmp`, outbound connections (`ss -tp`).
3. **Rotate every secret the VPS or PC could read**: all 29 keys in `.env.local`
   (DB URL, API keys, Google/Instagram tokens, `CRON_SECRET`, `ENCRYPTION_KEY` + re-encrypt),
   the VPS root password/SSH keys, `/root/.ssh/runpod_ed25519`, GitHub tokens on the PC.
4. **Stale branches** still carry the shim; delete the merged `cursor/*`, `fix/*`,
   `feature/*` branches or merge `main` into them.
5. **GitHub Actions** `Deploy to VPS` fires on every push to `main`. It has always failed,
   but fixing its secrets turns every push into a deploy — decide before touching it.
