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

## Deploy from your PC

**Never `git add .` in this repo.** Scratch dirs grow into the hundreds of MB
(`tmp-e2e` once hit 100 MB, `prompts/` 50 MB). They are in `.gitignore` now, but
new ones appear — check what you are staging first:

```powershell
git status                       # read this, every time
git add <the files you mean>
```

**Stage features whole.** A tracked file often points at an untracked one — a
modified `sidebar.tsx` linking to a brand new `src/app/(dashboard)/<route>/`.
Committing only the tracked half puts a dead link in production navigation.
`git status` lists modified and untracked separately, which is exactly how this
gets missed. New route → its page, its API route, its migration, and the nav
entry all go in one commit.

Then:

```powershell
npm run build                    # catches what tsc alone does not
git commit -m "your message"
git push origin main
ssh -i $env:USERPROFILE\.ssh\xxmachine_vps root@153.92.223.89 "bash /var/www/xxmachine/scripts/deploy.sh"
```

When several editor windows are open on this repo at once, the working tree
holds all of their work, not just yours. `git status` before committing tells
you whose changes you are about to ship.

## GitHub Actions — has never worked (checked 2026-08-03)

**All 84 runs of `Deploy to VPS` have failed — every one since the workflow was
added.** It does trigger on every push to `main`; `Set up job` passes and the
single `Deploy over SSH` step is what fails, so the workflow file is fine and
the problem is inside `appleboy/ssh-action`. Use the manual SSH line above; the
workflow has never once deployed anything.

Verified against the public API — the repo is public, so run history is readable
without a token:

```bash
curl -s "https://api.github.com/repos/novaknikola/xxmachine/actions/runs?per_page=5" \
  | grep -o '"\(run_number\|conclusion\)": *[^,]*'
```

Step logs need auth (the endpoint returns 403 unauthenticated), so the exact
error still has to be read in the browser under **Actions → Deploy to VPS**.
The likeliest cause is missing or malformed repository secrets — the step reads
all three and fails immediately on an empty or truncated key:

| Secret | Value |
|--------|--------|
| `VPS_HOST` | `153.92.223.89` |
| `VPS_USER` | `root` |
| `VPS_SSH_KEY` | contents of `~/.ssh/xxmachine_vps` (private key, whole file including header/footer lines) |

Check under **Settings → Secrets and variables → Actions**, and read the failure
under **Actions → Deploy to VPS**. Confirming this needs the GitHub web UI or
`gh` (not installed on this PC).

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

### Expected noise in the deploy log

`scripts/migrate-threads.js` throws `ECONNREFUSED 127.0.0.1:5432` on every
deploy — it opens its own connection to a *local* Postgres, which this VPS does
not run (the app uses a managed database via `DATABASE_URL`). `deploy.sh` marks
it `WARN` and continues, so the deploy still succeeds. Every other migration
runs normally. Treat that stack trace as known, not as a failed deploy; confirm
by checking the table you expected, e.g.:

```sql
select to_regclass('public.scraped_prompts');
select name from schema_migrations order by name desc limit 5;
```

## Repo sync status (2026-08-03)

| | Server (live) | Local |
|--|---------------|-------|
| Git commit | `36bb658` repurpose variant profiles | `36bb658` — in sync |
| Migration files on disk | 50 (through `043_scraped_prompts`) | 50 |
| DB tables | 35 tables, hybrid schema | matches most local features |
| Users in DB | 3 | — |

The two histories were unified on 2026-08-03: `main` was pushed and `deploy.sh`
pulled it, so server and local now sit on the same commit. Re-check this table
whenever you read it — it is a snapshot, not a live value.

**Do not** `git reset --hard` on the server without backup. `deploy.sh` stashes
server-side edits on every run, so anything the server had outside git is in
`git stash list`, not lost — but also not automatically restored.

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
