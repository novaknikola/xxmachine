# Multi-tenant & security — current state (snapshot)

> Snapshot from 2026-07-26. Intended to merge later with a fuller security/product plan.
> Source conversation: BYOK isolation, mandatory 2FA, Cloudflare, tenancy audit.

## Verdict

**Partial isolation.** Content Engine rows are mostly `user_id`-scoped. Core AI spend still uses **platform env keys**. Several CRM/content tables are shared across all authenticated users.

---

## Auth / 2FA

| Piece | Path | Behavior |
|--------|------|----------|
| Session | `src/lib/session.ts`, `session-cookie.ts` | Signed cookie → `sessions` row; ~30-day TTL; `requireUser` / `requireAdmin` |
| Edge gate | `src/proxy.ts` | Cookie signature check; full session verified per route |
| Signup | `api/auth/signup`, `signup/verify`, `src/app/signup/page.tsx` | Open signup; TOTP secret generated; `totp_enabled=false` until QR verify; first user → `admin` |
| Login | `api/auth/login`, `login/verify`, `src/app/login/page.tsx` | Password → if `totp_enabled`, `xm_2fa` ticket → verify; **if `totp_enabled=false`, session without 2FA** |
| Client | `src/contexts/auth-context.tsx` | `/api/auth/me`, login, verify2fa, logout |
| Password reset | `api/auth/reset-password` | Requires active user + TOTP |
| Subscription | payment webhook / cron | Stored on user; **not enforced in `proxy.ts`** (only `/subscribe` special-cased) |

### Auth gaps

- Open signup (no invite / waitlist).
- Incomplete signups stay `totp_enabled=false` and can log in without 2FA.
- Signup verify not bound by the same ticket-cookie pattern as login.
- Subscription not gated at the edge for API routes.

---

## Already isolated per user

| Resource | Evidence |
|----------|----------|
| `generation_queue` | `queue/list`, `queue/[id]`, `queue/submit` — `WHERE user_id = $1` |
| `discovery_items` / `tracked_profiles` / `pipeline_jobs` | `runpod/*`, `monitor/items`, `monitor/scan`, `process-item.ts` |
| `ig_downloader_*` | `instagram/bulk-reels/*` |
| `comfyui_templates` | `comfyui-templates/route.ts` |
| `user_api_keys` (BYOK store) | `lib/user-keys.ts`, `api/settings/keys` |
| `user_settings` | `api/settings` |
| `loras` (own rows) | Insert/delete by `user_id`; list also includes `OR is_public = true` |
| `generations` GET/DELETE | Scoped to `auth.id` |
| Queue input uploads | Storage path `inputs/{user.id}/{uuid}` |

**BYOK used at runtime today:** mainly `resolveKey(..., 'RAPIDAPI_KEY')` (monitor scan, runpod scan, IG bulk-reels). RunPod keys are collected in UI (`BYOK_KEY_DEFS`) but not fully consumed by job execution elsewhere.

---

## Still shared / platform-key dependent

### Platform env keys (not per-user)

| Key | Used by |
|-----|---------|
| `WAVESPEED_API_KEY` | `generate`, `video-generate`, `edit-image`, `loras/train`, `loras/[id]/status`, `queue/process`, `lib/monitor/replicate.ts`, motion generate-image/video |
| `XAI_API_KEY` | `lib/grok.ts` (classify, analyze, captions, fan summary, queue AI jobs) |
| `HF_TOKEN` | `generate`, queue process |
| `APIFY_API_KEY` | stats/twitter (env) |
| Fanvue / IG / Threads app secrets | OAuth app credentials (platform) |
| `SUPABASE_*` | Shared service-role storage |
| Telegram bot / admin group | Shared notify |

### Dual key stores (confusion / dead path)

1. **`user_api_keys`** via `resolveKey` — WaveSpeed optional override exists, but most WaveSpeed paths ignore it and use env.
2. **`user_settings.wavespeed_api_key`** (and HF/Apify/…) via Settings UI — `getUserApiKey` in `lib/user-config.ts` is **never called** into generate/queue/monitor hot paths.

UI copy currently: WaveSpeed BYOK = “leave blank to use the platform key” (`user-keys.ts`).

### Shared DB tables (auth may be required, no `user_id` filter)

| Area | Path |
|------|------|
| Characters (all see all; mutate = admin) | `api/characters` |
| Instagram accounts | `api/instagram/accounts` — weak/no user scope |
| Fans / creators | `api/fans`, Fanvue routes |
| Schedule | `api/schedule/list` — all `scheduled_posts` |
| Prompt library | `api/prompt-library` — no user scope |

### Storage

- Bucket `generations` with **service key** (`lib/supabase-storage.ts`).
- Some paths include user id; queue/monitor often `queue/{jobId}/…`.
- Public URLs → anyone with the URL can read.

### Admin bypass

- `requireAdmin` for users/permissions/analytics.
- Admins skip module permissions in dashboard layout/sidebar.
- Characters CRUD = admin; GET = any authenticated user (shared catalog).

---

## Weak / high-risk routes

| Issue | Path |
|-------|------|
| POST save accepts client `userId`, **no `requireUser`** | `api/generations` POST |
| Platform WaveSpeed, no user key | `api/generate`, `api/video-generate`, `api/edit-image` |
| Shared characters / IG / fans / schedule / prompts | see above |
| LoRA PATCH allows `is_public` rows | `api/loras` PATCH |
| Worker uses job `user_id` for ownership but **platform** WaveSpeed/XAI/HF | `api/queue/process/[id]` (CRON secret) |

---

## Highest-risk gaps for true BYOK SaaS

1. WaveSpeed / XAI / HF still platform-billed on almost all generation paths.
2. Dual key stores; Settings keys largely unwired.
3. Cross-tenant data (characters, IG accounts, fans, schedule, prompts).
4. `generations` POST unauthenticated + spoofable `userId`.
5. Shared Supabase public bucket + service role (path convention only).
6. Open signup, incomplete-2FA login, weak subscription enforcement.
7. RunPod BYOK incomplete; RapidAPI has env fallback via `resolveKey`.
