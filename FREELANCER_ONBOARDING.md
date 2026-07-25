# XXmachine — Freelancer Onboarding & Setup Guide

**Project:** XXmachine  
**Platform:** Content creation & fan engagement platform for AI-generated creator personas  
**Stack:** Next.js 16.2 · React 19 · TypeScript 5 · PostgreSQL (Supabase) · Tailwind CSS 4  
**Prepared by:** Project owner  
**Date:** 2026-06-03

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [GitHub Repository Access](#2-github-repository-access)
3. [Environment Variables](#3-environment-variables)
4. [Database Access](#4-database-access)
5. [Hostinger VPS Access](#5-hostinger-vps-access)
6. [Local Development Setup](#6-local-development-setup)
7. [User Roles & Permissions](#7-user-roles--permissions)
8. [Social Platform Credentials](#8-social-platform-credentials)
9. [Messaging Platform (Telegram)](#9-messaging-platform-telegram)
10. [Creator Platform (Fanvue)](#10-creator-platform-fanvue)
11. [Scheduling Workflow](#11-scheduling-workflow)
12. [Domain, SSL & Production Deployment](#12-domain-ssl--production-deployment)
13. [Architecture Overview](#13-architecture-overview)

---

## 1. Project Overview

XXmachine is an internal back-office platform for managing **AI-generated creator personas** (called *characters*). It handles:

- **Bulk AI image generation** — text-to-image with custom LoRA models per character, batch processing, dataset export for LoRA training, image editing (WAN edit)
- **Social media management** — Instagram (private API + browser automation), Threads (OAuth), scheduled posting with approval workflow
- **Fan management** — Fanvue fan list sync, spending analytics, payday tracking, AI-powered fan summaries (Gemini), scheduled PPV messages
- **Content calendar** — day-by-day content planning with topics, keywords, and prompt generation
- **Viral reels tracker** — scrape trending Instagram reels, analyze covers with Gemini, auto-generate matching images and videos (Kling)
- **Motion/video generation** — Kling AI integration for video creation from images
- **Admin panel** — user management, system status, debug tools

### Characters (Personas)
There are currently **3 active characters**: Tiana, Diana, Miyanna — each has their own:
- LoRA model URL + scale
- Instagram account (private API credentials + TOTP secret)
- Fanvue account (OAuth token)
- Google Drive folder for content storage
- Telegram channel for content distribution
- Base prompt style and story/backstory

---

## 2. GitHub Repository Access

> **[PLACEHOLDER — fill in before sending]**

- **Repository URL:** `https://github.com/[YOUR_GITHUB_USERNAME]/xmachine` *(private repo)*
- **Access:** The owner will send you a GitHub collaborator invite to your GitHub account. Accept the invite before cloning.
- **Branch:** `main` is the primary branch. Work on feature branches (`feature/your-feature-name`) and open PRs to `main`.

**Clone:**
```bash
git clone https://github.com/[OWNER]/xmachine.git
cd xmachine
npm install
```

---

## 3. Environment Variables

The app requires a `.env.local` file in the project root. The server reads it manually on startup — do **not** rename it.

Copy the template below and fill in the values provided separately (see the shared secrets document or password manager entry):

```env
# ── Database ─────────────────────────────────────────────────────
DATABASE_URL=postgresql://postgres:[PASSWORD]@[HOST]:5432/postgres

# ── App ──────────────────────────────────────────────────────────
NEXT_PUBLIC_BASE_URL=https://xmachine.local:3000
CRON_SECRET=[RANDOM_STRING]            # must match what server.mjs sends to /api/cron/tick

# ── Image generation (Replicate / custom AI provider) ─────────────
# [PLACEHOLDER — confirm which provider: Replicate, RunPod, or other]
REPLICATE_API_TOKEN=
AI_GENERATION_ENDPOINT=
AI_GENERATION_API_KEY=

# ── LoRA training ─────────────────────────────────────────────────
# [PLACEHOLDER — confirm provider]
LORA_TRAIN_API_KEY=
LORA_TRAIN_ENDPOINT=

# ── Video generation (Kling AI) ───────────────────────────────────
KLING_API_KEY=
KLING_API_SECRET=

# ── Google / Drive ────────────────────────────────────────────────
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://xmachine.local:3000/api/google/callback

# ── Instagram (Graph API — legacy/optional) ───────────────────────
INSTAGRAM_APP_ID=
INSTAGRAM_APP_SECRET=

# ── Threads (Meta) ───────────────────────────────────────────────
THREADS_APP_ID=
THREADS_APP_SECRET=
THREADS_REDIRECT_URI=https://xmachine.local:3000/api/threads/oauth/callback

# ── Telegram Bot ─────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=
TELEGRAM_ADMIN_GROUP_ID=    # group where scheduled post previews are sent for approval

# ── Session signing ──────────────────────────────────────────────
FANVUE_SESSION_SECRET=[RANDOM_SECRET_MIN_32_CHARS]  # used to sign xm_sid session cookies

# ── Fanvue ───────────────────────────────────────────────────────
FANVUE_API_BASE=https://api.fanvue.com   # [PLACEHOLDER — confirm exact base URL]
FANVUE_CLIENT_ID=
FANVUE_CLIENT_SECRET=
FANVUE_REDIRECT_URI=https://xmachine.local:3000/api/fanvue/callback

# ── AI / LLM (for fan summaries, caption generation, calendar) ───
GEMINI_API_KEY=             # Google Gemini — used for fan AI summaries, reel cover analysis
GROK_API_KEY=               # xAI Grok — used for pose analysis

# ── Proxy (browser automation) ───────────────────────────────────
# Per-character proxies are stored in DB. Global fallback if any:
# PROXY_URL=http://user:pass@host:port
```

> **IMPORTANT:** The `.env.local` file is **gitignored** and must never be committed. The owner will share the actual values via a secure channel (password manager / encrypted message).

---

## 4. Database Access

**Provider:** Supabase (PostgreSQL)

| Detail | Value |
|--------|-------|
| Host | `[PLACEHOLDER — Supabase project host]` |
| Port | `5432` |
| Database | `postgres` |
| User | `postgres` |
| Password | `[PLACEHOLDER — share via secure channel]` |
| SSL | Required (auto-detected if host contains `supabase.com`) |

### Schema Overview

Migrations live in `src/db/migrations/` and are run with:
```bash
npm run db:migrate              # core schema
npm run db:migrate-schedule     # scheduled posts table
npm run db:migrate-fans         # fans + fan spend snapshots
npm run db:migrate-instagram    # instagram queue + characters extension
```

**Tables:**

| Table | Purpose |
|-------|---------|
| `users` | Admin and chatter accounts |
| `sessions` | Session tokens (cookie-based auth) |
| `characters` | Creator personas (Instagram, Fanvue, Google Drive credentials) |
| `instagram_queue` | Posts queued for Instagram publication |
| `viral_reels` | Tracked trending reels + generated content |
| `generations` | AI image generation history |
| `prompt_library` | Saved reusable prompts |
| `schema_migrations` | Applied migration tracking |
| *(fans, scheduled_posts, calendar_days — see migration scripts)* | |

### Database Dump

> **[PLACEHOLDER]** — Owner to provide a sanitized dump (no real fan PII, no credentials) via:
> ```bash
> pg_dump $DATABASE_URL --no-owner --no-acl -f xmachine_dump.sql
> ```
> Share the dump file via Google Drive or secure file transfer.

---

## 5. Hostinger VPS Access

> **[PLACEHOLDER — fill in before sending]**

| Detail | Value |
|--------|-------|
| VPS IP | `[IP ADDRESS]` |
| SSH User | `[USERNAME]` (probably `root` or `ubuntu`) |
| SSH Port | `22` |
| SSH Auth | SSH key (owner will add your public key) |
| OS | `[Ubuntu 22.04 / Debian — confirm]` |
| App location | `/var/www/xmachine` or `~/xmachine` — confirm with owner |
| Node version | `[PLACEHOLDER — check with: node -v on server]` |
| Process manager | `[PLACEHOLDER — PM2 / systemd service — confirm]` |

**Deployment flow (current):**
```bash
# On VPS (estimated — confirm with owner):
cd /var/www/xmachine
git pull origin main
npm install
npm run build
pm2 restart xmachine    # or: systemctl restart xmachine
```

> **Note:** The app runs a custom HTTPS server (`server.mjs`), not the standard `next start`. Ensure the process manager points to `node server.mjs` not `next start`.

---

## 6. Local Development Setup

### Prerequisites

- Node.js 20+ (check `.nvmrc` if present, otherwise use LTS)
- PostgreSQL client (optional, for direct DB access)
- [mkcert](https://github.com/FiloSottile/mkcert) — for local HTTPS (required for Instagram private API and some OAuth flows)

### Steps

```bash
# 1. Clone and install
git clone https://github.com/[OWNER]/xmachine.git
cd xmachine
npm install

# 2. Set up local HTTPS (required)
mkcert -install
mkcert xmachine.local
# This generates: xmachine.local-key.pem + xmachine.local.pem
# Place both files in the project root

# 3. Add xmachine.local to /etc/hosts (or C:\Windows\System32\drivers\etc\hosts on Windows)
# 127.0.0.1  xmachine.local

# 4. Create .env.local (see Section 3)
cp .env.local.example .env.local   # if example exists, otherwise create manually

# 5. Run database migrations
npm run db:migrate
npm run db:migrate-schedule
npm run db:migrate-fans
npm run db:migrate-instagram

# 6. Start dev server
npm run dev
# App available at: https://xmachine.local:3000
```

### Playwright / Browser Automation

Some Instagram features use Playwright with stealth. Install browsers:
```bash
npx playwright install chromium
```

### First Login

On fresh DB, navigate to `/auth/signup` to create the first admin account (bootstrap mode is available if no users exist — see `/api/auth/bootstrap-status`).

---

## 7. User Roles & Permissions

The system has **2 roles**:

| Role | Access |
|------|--------|
| `admin` | Full access — user management, all characters, all features, admin panel, debug tools |
| `chatter` | Restricted — fan management, messaging, content scheduling (no admin panel, no character settings, no user management) |

**Auth implementation:**
- Session-based (cookie name: `xm_sid`, HMAC-SHA256 signed)
- Sessions stored in DB (`sessions` table), expire after **30 days**
- Passwords hashed with bcryptjs
- TOTP (2FA) supported for Instagram accounts (per character, not per user)

**Test accounts:**
> **[PLACEHOLDER]** — Owner to provide:
> - Admin test account: `admin@xmachine.local` / `[password]`
> - Chatter test account: `chatter@xmachine.local` / `[password]`

---

## 8. Social Platform Credentials

### Instagram

The platform uses **Instagram Private API** (not the official Graph API) for most operations, plus **Playwright browser automation** for actions not supported by the private API.

Per-character Instagram credentials are stored in the `characters` table:

| Field | Description |
|-------|-------------|
| `ig_username` | Instagram username |
| `ig_password` | Instagram password |
| `ig_totp_secret` | TOTP secret for 2FA (OTPLib format) |
| `ig_session` | Cached session JSON (auto-refreshed) |
| `proxy_url` | Per-character proxy (recommended to avoid IP bans) |

**Test account for development:**
> **[PLACEHOLDER]** — Owner to provide a throwaway Instagram account for dev/testing (do NOT use production accounts during development — Instagram may flag unusual activity).

### Threads

OAuth-based via Meta's Threads API. Credentials per character:
- `THREADS_APP_ID` + `THREADS_APP_SECRET` in `.env.local`
- OAuth flow: `/api/threads/oauth` → `/api/threads/oauth/callback`
- Tokens stored in DB, auto-refreshed via `/api/threads/refresh-token`

**Test account:**
> **[PLACEHOLDER]** — Owner to provide a test Threads account or confirm using the same Instagram test account (Threads and Instagram share Meta login).

---

## 9. Messaging Platform (Telegram)

The platform uses a Telegram bot for:
1. **Scheduled post previews** — when a post is scheduled, a preview with image + caption is sent to the admin Telegram group for approval/rejection before publishing
2. **Content distribution** — approved posts are also sent to character-specific Telegram channels

**Bot credentials (from `.env.local`):**
- `TELEGRAM_BOT_TOKEN` — BotFather token
- `TELEGRAM_ADMIN_GROUP_ID` — the group chat ID where approval messages are sent

**Webhook:**
- Endpoint: `/api/telegram/webhook`
- **[PLACEHOLDER]** — Confirm whether webhook is registered or if polling is used. On production, webhook URL must be set: `https://[DOMAIN]/api/telegram/webhook`

**Test channels:**
> **[PLACEHOLDER]** — Owner to provide:
> - Test bot token (or share prod bot in dev mode)
> - Test admin group ID for approvals
> - Test channel IDs for at least one character

---

## 10. Creator Platform (Fanvue)

Fanvue is the primary creator/fan monetization platform. The app integrates via:
- **Fanvue OAuth** — per-character auth: `/api/fanvue/auth` → `/api/fanvue/callback`
- **Fan sync** — `/api/fanvue/sync` pulls fan list, spend data, subscription status
- **Chat messages** — `/api/fanvue/chat-messages` fetches conversation history per fan
- **Send message** — `/api/fanvue/send-message` sends manual messages
- **Schedule message** — `/api/fanvue/schedule-message` uses Fanvue's mass-message feature with a single-fan custom list ("mass-of-one" trick) for scheduled PPV/messages

**Credentials:**
- `FANVUE_CLIENT_ID` + `FANVUE_CLIENT_SECRET` in `.env.local`
- Per-character OAuth tokens stored in DB

**Test account:**
> **[PLACEHOLDER]** — Owner to provide a Fanvue test creator account (sandbox environment if available, otherwise a real account — confirm usage limits to avoid accidental messages to real fans during testing).

> **⚠️ WARNING:** The send-message API endpoints interact with real fans. During development, ensure you're using a test account or have safeguards to prevent accidental messaging.

---

## 11. Scheduling Workflow

### How it works

1. A **chatter or admin** creates a scheduled post via `/schedule` page (image URLs + caption + platforms + datetime)
2. Post is saved to DB with status `pending_approval`
3. A **Telegram preview** (image + caption) is sent to the admin group
4. Admin **approves** (reply with `/approve`) or **rejects** (reply with `/reject`) via Telegram
5. Status changes to `approved` or `rejected`
6. The background **cron job** (runs every minute via `node-cron` in `server.mjs`) calls `/api/cron/tick`
7. The cron tick finds approved posts whose `scheduled_at` has passed → publishes to selected platforms (Telegram channel, Fanvue)
8. Status updated to `published` or `failed`

### Platforms supported for scheduling

| Platform | Notes |
|----------|-------|
| Telegram | Posts to character's `telegramChannelId` |
| Fanvue | Posts as a standard feed post via Fanvue API |
| Instagram | Separate queue (`instagram_queue` table), separate flow |

### Sample Scheduling Spreadsheet

> **[PLACEHOLDER]** — Owner to share the Google Sheets template used for planning content batches before they're entered into the platform. Attach the link or export as CSV.

The expected CSV format for bulk Instagram import is handled by `/api/instagram/import-csv`. Accepted columns (all lowercase headers):

| Column | Aliases accepted | Required |
|--------|-----------------|----------|
| `name` | `account_name` | No (falls back to ig_username) |
| `ig_username` | `username`, `instagram_username` | **Yes** |
| `ig_password` | `password`, `instagram_password` | No (kept if already in DB) |
| `ig_totp_secret` | `totp_secret` | No |
| `proxy_url` | `proxy` | No |
| `drive_folder_id` | `google_drive_folder_id` | No |

Proxy format accepted: `ip:port:user:pass` **or** `http://user:pass@host:port` **or** `host:port`

If a row with the same `ig_username` or `name` already exists in the DB, it is **updated** (empty fields are ignored — existing values kept). New rows are **inserted**.

---

## 12. Domain, SSL & Production Deployment

### Domain

> **[PLACEHOLDER]**
> - **Production domain:** `xxmachine.com`
> - **DNS:** Managed via `[Hostinger / Cloudflare — confirm]`
> - **DNS A record** points to Hostinger VPS IP

### SSL (Production)

Production SSL is handled by:
> **[PLACEHOLDER — confirm one of:]**
> - **Let's Encrypt / Certbot** — certs at `/etc/letsencrypt/live/[domain]/`
> - **Cloudflare proxy** — SSL terminated at Cloudflare edge (app runs HTTP internally)
> - **mkcert** — only valid for local dev, do not use in production

The app's `server.mjs` auto-detects cert files (`xmachine.local.pem` / `localhost.pem`) in the project root and switches between HTTPS and HTTP accordingly. For production with Cloudflare proxy, you can run HTTP internally and let Cloudflare handle SSL.

### SSL (Local Development)

Uses [mkcert](https://github.com/FiloSottile/mkcert) self-signed certs. See Section 6 for setup. The dev hostname is `xmachine.local` — add it to your hosts file.

### Production Process Manager

> **[PLACEHOLDER — confirm]**
> 
> Recommended: **PM2**
> ```bash
> # Initial setup on VPS:
> npm install -g pm2
> cd /var/www/xmachine
> npm run build
> pm2 start "node server.mjs" --name xmachine --env production
> pm2 save
> pm2 startup   # auto-start on reboot
> ```
>
> Or if using **systemd** — owner to share the `.service` file.

### Environment on VPS

- Set `NODE_ENV=production` (the start script does this: `"start": "NODE_ENV=production node server.mjs"`)
- Port: default `3000`, configurable via `PORT` env var
- Reverse proxy (nginx recommended) should forward `443 → 3000`

> **[PLACEHOLDER]** — Owner to share nginx config if it exists.

---

## 13. Architecture Overview

```
xmachine/
├── src/
│   ├── app/
│   │   ├── (dashboard)/        # All protected pages (bulk, fans, socials, schedule, calendar, reels, motion, history, admin)
│   │   ├── api/                # ~72 API route handlers
│   │   │   ├── auth/           # Login, logout, signup, session
│   │   │   ├── characters/     # Character CRUD
│   │   │   ├── generate/       # AI image generation
│   │   │   ├── wan-edit/       # Image editing (WAN model)
│   │   │   ├── loras/          # LoRA model management + training
│   │   │   ├── fans/           # Fan CRUD + messages + AI summary
│   │   │   ├── fanvue/         # Fanvue OAuth + sync + messaging
│   │   │   ├── schedule/       # Scheduled posts CRUD
│   │   │   ├── instagram/      # Instagram connect + queue + publish
│   │   │   ├── threads/        # Threads OAuth + publish
│   │   │   ├── telegram/       # Telegram webhook
│   │   │   ├── motion/         # Viral reels + Kling video generation
│   │   │   ├── calendar/       # Calendar day generation
│   │   │   ├── google/         # Google Drive OAuth + file listing
│   │   │   ├── cron/tick       # Background job trigger (called every minute by server.mjs)
│   │   │   └── ai/             # AI utilities (fan summary, caption gen)
│   │   └── auth/               # Login/signup pages
│   ├── components/             # Shared React components
│   ├── contexts/               # AuthContext (current user state)
│   ├── db/migrations/          # SQL migration files
│   └── lib/
│       ├── db.ts               # PostgreSQL connection pool
│       ├── types.ts            # All TypeScript types
│       ├── store.ts            # LocalStorage state (characters, user prefs)
│       ├── fans.ts             # Fan analytics (payday calc, spend tracking)
│       └── fanvue.ts           # Fanvue API client
├── scripts/                    # DB migration runner scripts
├── server.mjs                  # Custom HTTPS server + cron scheduler
├── next.config.ts
└── .env.local                  # ← NOT committed, share separately
```

### Key Architectural Notes

1. **Custom server** — The app does NOT use `next start`. It uses `server.mjs` which starts the Next.js app AND runs the cron scheduler in the same process. Always use `npm run dev` (dev) or `npm run start` (prod).

2. **No ORM** — Raw SQL via the `pg` library. Queries are in the API route handlers. The `src/lib/db.ts` exports `query()`, `rows()`, `one()` helpers.

3. **Session auth** — Cookie-based sessions stored in PostgreSQL. No JWT, no NextAuth. Check `src/app/api/auth/` for implementation.

4. **Browser automation** — Playwright + stealth plugin is used for Instagram actions that can't be done via private API. Some routes open a real browser window on the server (hence why the VPS needs a display or xvfb).

5. **No state management library** — React Context for auth, localStorage (`store.ts`) for characters and UI state. No Redux/Zustand.

6. **Tailwind CSS v4** — Uses the new v4 API (not v3). PostCSS config is at `@tailwindcss/postcss`. Class syntax is the same but config file format differs.

---

## Checklist for Freelancer

Before starting work, confirm you have:

- [ ] GitHub repo access + cloned locally
- [ ] `.env.local` file with all values filled in
- [ ] Database connected (`npm run db:migrate` completes without errors)
- [ ] mkcert installed + `xmachine.local` cert generated
- [ ] `xmachine.local` added to hosts file
- [ ] `npm run dev` runs and app loads at `https://xmachine.local:3000`
- [ ] Can log in with the provided test admin account
- [ ] Playwright browsers installed (`npx playwright install chromium`)
- [ ] VPS SSH access working (if working on deployment tasks)
- [ ] Telegram test bot token + admin group configured
- [ ] Fanvue test account connected to at least one character
- [ ] Instagram test account connected to at least one character

---

*Questions? Contact the project owner. Do not commit `.env.local`, credentials, or API keys to git.*
