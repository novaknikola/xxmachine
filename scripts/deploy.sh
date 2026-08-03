#!/usr/bin/env bash
# Deploy xxmachine on Hostinger VPS. Run as root from anywhere:
#   /var/www/xxmachine/scripts/deploy.sh
set -euo pipefail

APP_DIR="/var/www/xxmachine"
BRANCH="${DEPLOY_BRANCH:-main}"
BACKUP_ROOT="/var/www/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${BACKUP_ROOT}/pre-deploy-${STAMP}"

log() { echo "[deploy ${STAMP}] $*"; }

log "Starting deploy (branch=${BRANCH})"

if [[ ! -d "${APP_DIR}/.git" ]]; then
  echo "ERROR: ${APP_DIR} is not a git repo" >&2
  exit 1
fi

# ── NVM (Node via nvm on this VPS) ─────────────────────────────
export NVM_DIR="${HOME}/.nvm"
# shellcheck disable=SC1091
[[ -s "${NVM_DIR}/nvm.sh" ]] && source "${NVM_DIR}/nvm.sh"

cd "${APP_DIR}"

# ── Prune old backups (keep last N) — unbounded pre-deploy-* dirs filled the
# disk to 100% once already (each is ~4GB); this runs before creating a new one.
BACKUP_RETENTION="${BACKUP_RETENTION:-5}"
mapfile -t old_backups < <(ls -1dt "${BACKUP_ROOT}"/pre-deploy-* 2>/dev/null | tail -n +$((BACKUP_RETENTION + 1)))
if [[ ${#old_backups[@]} -gt 0 ]]; then
  log "Pruning ${#old_backups[@]} old backup(s), keeping last ${BACKUP_RETENTION}"
  rm -rf "${old_backups[@]}"
fi

# ── Pre-deploy backup ──────────────────────────────────────────
mkdir -p "${BACKUP_DIR}"
cp -a .env.local "${BACKUP_DIR}/.env.local" 2>/dev/null || true
tar -czf "${BACKUP_DIR}/app-src.tgz" \
  --exclude=node_modules \
  --exclude=.next \
  --exclude='.next-before-*' \
  --exclude=.git \
  --exclude=chrome-profiles \
  .
log "Backup → ${BACKUP_DIR}"

# Stash uncommitted server edits so pull does not fail (recoverable via git stash list)
if ! git diff --quiet || ! git diff --cached --quiet || [[ -n "$(git status --porcelain)" ]]; then
  git stash push -u -m "pre-deploy-${STAMP}" || true
  log "Stashed local changes (git stash list to recover)"
fi

# ── Pull latest ────────────────────────────────────────────────
git fetch origin "${BRANCH}"
git checkout "${BRANCH}"
git pull --ff-only origin "${BRANCH}"
log "At commit $(git log -1 --oneline)"

# ── Install & build ────────────────────────────────────────────
# Keep the previous build's static assets so browsers that already have a page
# open can still fetch their chunks. `next build` writes a new build id and the
# old chunk files disappear, so an open tab asking for its own JS gets a 404 —
# which the app surfaces as "This page couldn't load". nginx logged 53 of those.
PREV_STATIC=""
if [[ -d .next/static ]]; then
  PREV_STATIC="$(mktemp -d)"
  cp -a .next/static/. "${PREV_STATIC}/"
fi

npm ci
npm run build

if [[ -n "${PREV_STATIC}" && -d "${PREV_STATIC}" ]]; then
  # -n: never overwrite an asset the new build just produced.
  cp -rn "${PREV_STATIC}/." .next/static/ 2>/dev/null || true
  rm -rf "${PREV_STATIC}"
  log "Merged previous static assets back in (old tabs keep working)"
fi

# ── Database migrations (additive only; skips applied) ─────────
npm run db:migrate
for extra in migrate-schedule migrate-fans migrate-instagram migrate-saas migrate-analytics migrate-threads migrate-tiers; do
  if [[ -f "scripts/${extra}.mjs" ]]; then
    log "Running scripts/${extra}.mjs"
    node "scripts/${extra}.mjs" || log "WARN: ${extra} failed (may already be applied)"
  fi
  if [[ -f "scripts/${extra}.js" ]]; then
    log "Running scripts/${extra}.js"
    node "scripts/${extra}.js" || log "WARN: ${extra} failed (may already be applied)"
  fi
done

# ── Restart app (direct node server.mjs, not npm start wrapper) ─
if pm2 describe xxmachine >/dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs --env production
else
  pm2 start ecosystem.config.cjs --env production
fi
pm2 save

log "Deploy complete. pm2 status:"
pm2 list
