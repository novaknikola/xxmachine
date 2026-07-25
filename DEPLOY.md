# Deploy xxmachine (Hostinger VPS)

Production: **https://xxmachine.com** · app dir **`/var/www/xxmachine`** · PM2 process **`xxmachine`**

SSH (key auth):

```powershell
ssh -i $env:USERPROFILE\.ssh\xxmachine_vps root@153.92.223.89
```

## First-time VPS setup (already done)

- Node v24 via nvm
- nginx → `127.0.0.1:3000` with Let's Encrypt
- PM2 running the app
- `.env.local` on server (never in git)
- SSH key: `~/.ssh/xxmachine_vps` on your PC

## Manual deploy

On the server:

```bash
bash /var/www/xxmachine/scripts/deploy.sh
```

What it does: backup → `git pull` → `npm ci` → `npm run build` → migrations → `pm2 reload`.

## Deploy from Cursor (after git push)

```powershell
git add .
git commit -m "your message"
git push origin main
ssh -i $env:USERPROFILE\.ssh\xxmachine_vps root@153.92.223.89 "bash /var/www/xxmachine/scripts/deploy.sh"
```

## GitHub Actions (optional)

Add repository secrets:

| Secret | Value |
|--------|--------|
| `VPS_HOST` | `153.92.223.89` |
| `VPS_USER` | `root` |
| `VPS_SSH_KEY` | contents of `~/.ssh/xxmachine_vps` (private key) |

Then every push to `main` runs deploy, or trigger manually under Actions → Deploy to VPS.

## Environment

Copy `.env.example` → `.env.local` on the server. Production already has 29 keys configured.

**Required for scheduler:** `CRON_SECRET` must be set or queue/cron endpoints refuse to run (fail-closed).

## Database migrations

Production DB is a **merge of two migration histories** (server-side edits + local repo). The `schema_migrations` table lists both naming schemes; tables include `generation_queue`, `calendar_days`, `user_permissions`, etc.

`npm run db:migrate` only applies **additive** SQL files that are not yet recorded. Before a major schema change, take a DB backup from your Postgres provider.

Audit on server:

```bash
cd /var/www/xxmachine && node scripts/vps-db-audit.mjs
```

## Repo sync status (2026-07-25)

| | Server (live) | Local (Cursor) |
|--|---------------|----------------|
| Git commit | `2fb5a8b` video reproduce fix | `02206a0` initial release |
| Migration files on disk | 17 (older naming 008–016) | 19 (queue/carousel path) |
| DB tables | 35 tables, hybrid schema | matches most local features |
| Users in DB | 3 | — |

**Do not** `git reset --hard` on the server without backup. Server had ~70 untracked files and ~20 modified tracked files outside git.

### Safe path to unify code

1. Commit & push **local** work to `main` on GitHub (or a `release` branch).
2. On server: `deploy.sh` (stashs local edits automatically).
3. Smoke-test: login, bulk generate, queue, Instagram tab.
4. Recover stashed server-only edits if needed: `git stash list` / `git stash show`.

## PM2

Prefer ecosystem file (direct `node server.mjs`, not `npm start`):

```bash
pm2 start /var/www/xxmachine/ecosystem.config.cjs --env production
pm2 save
pm2 startup   # once, for reboot persistence
```

Logs: `pm2 logs xxmachine --lines 100`

## nginx

Config: `/etc/nginx/sites-enabled/xxmachine` — proxies to port 3000, blocks `/api/debug/`.

`xpandxposure.com` is not configured yet.

## Security checklist

- [ ] Rotate root password (was shared in chat)
- [ ] SSH key auth only (`PasswordAuthentication no` in sshd_config)
- [ ] `.env.local` permissions `600`
- [ ] Deploy P0 auth fixes before opening SaaS signup broadly
