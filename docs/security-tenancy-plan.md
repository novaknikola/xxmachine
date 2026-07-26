# Security & multi-tenant plan (draft)

> Draft from 2026-07-26. Save for later full merge with a newer/broader plan.
> Companion snapshot: [`security-tenancy-current-state.md`](./security-tenancy-current-state.md).

## Goals

1. **Full API-key isolation (strict BYOK)** — each user adds their own keys to use paid services; no silent platform-key billing for normal users.
2. **Mandatory 2FA on signup** — no usable session until TOTP is verified; no password-only login path for incomplete accounts.
3. **Cloudflare protection** — edge WAF, bot/Turnstile, rate limits, origin lockdown.
4. **True per-user tenancy** where product data should be private (not a shared operator workspace).

---

## Phase 1 — Auth harden (do first)

- [ ] Require TOTP before any session is issued after signup.
- [ ] Block login when `totp_enabled=false` (force finish signup verify or re-enroll).
- [ ] Bind signup verify with a short-lived ticket cookie (same pattern as login 2FA).
- [ ] Issue recovery codes at signup; store hashed.
- [ ] Lock `POST /api/generations` behind `requireUser`; ignore client-supplied `userId`.
- [ ] Rate-limit signup / login / reset (app-level + later Cloudflare).
- [ ] Optional: invite-only or waitlist flag before open registration.

**Files (starting points):**  
`src/app/api/auth/signup/*`, `login/*`, `src/lib/two-factor-ticket.ts`, `src/app/signup/page.tsx`, `src/app/api/generations/route.ts`.

---

## Phase 2 — Strict BYOK wiring

- [ ] **One key store** — prefer `user_api_keys` + `resolveKey`; deprecate / migrate `user_settings.*_api_key` dead path.
- [ ] Wire `resolveKey(userId, …)` into every hot path:
  - WaveSpeed: generate, edit-image, video-generate, queue/process, LoRA train/status, monitor replicate, motion routes
  - XAI/Grok: `lib/grok.ts` callers
  - HF: generate / queue LoRA URL conversion
  - RapidAPI / RunPod: finish runtime consumption (not just Settings UI)
- [ ] **Remove env fallback for normal users** (or admin-only bootstrap). Clear 403/402-style error: “Add your WaveSpeed API key in Settings”.
- [ ] Settings UX: required keys checklist + **Test key** button (health check).
- [ ] Onboarding gate: block Generate / Dataset / Monitor AI until required keys present.
- [ ] Never send keys to the client; only presence / last-4 / status.

**Files (starting points):**  
`src/lib/user-keys.ts`, `src/lib/user-config.ts`, `src/lib/wavespeed.ts`, `src/lib/grok.ts`, `src/app/api/edit-image/route.ts`, `src/app/api/generate/route.ts`, `src/app/api/queue/process/[id]/route.ts`, `src/lib/monitor/replicate.ts`.

### Required keys (proposed)

| Key | Required for |
|-----|----------------|
| `WAVESPEED_API_KEY` | Image/video/edit/LoRA/monitor recreate |
| `XAI_API_KEY` (or Grok) | Classify / analyze / captions / AI queue jobs |
| `HF_TOKEN` | Private LoRA resolve (if used) |
| `RAPIDAPI_KEY` | IG/TikTok scrape |
| RunPod keys | V2V / I2V / Animate jobs |

Platform-only (keep env): OAuth app secrets, Supabase service role, session secret, Telegram admin bot (until multi-tenant notify exists).

---

## Phase 3 — Cloudflare

- [ ] DNS proxied through Cloudflare (orange cloud).
- [ ] WAF managed rules + custom rules for `/api/auth/*`.
- [ ] Bot Fight / Super Bot Fight; **Turnstile** on signup + login (+ reset).
- [ ] Rate limiting rules (auth endpoints, expensive generate endpoints).
- [ ] Origin firewall: allow only Cloudflare IPs (or Authenticated Origin Pull / tunnel).
- [ ] Separate stricter policy for admin routes / admin subdomain if introduced.
- [ ] Optional: Cloudflare Access (Zero Trust) in front of admin.

---

## Phase 4 — Data tenancy

Decide per table: **private** vs **explicit shared catalog**.

### Make private (`user_id` required)

- [ ] Prompt library
- [ ] Instagram accounts (or ownership join)
- [ ] Schedule / `scheduled_posts`
- [ ] Fans / creator CRM (unless product is intentionally shared ops)
- [ ] Characters — either per-user or “platform catalog + user overrides”

### Storage

- [ ] Always prefix `{userId}/…`.
- [ ] Prefer signed URLs over forever-public objects.
- [ ] Soft-delete + account export/delete path.

### Admin

- [ ] Keep `requireAdmin` for user management / analytics.
- [ ] Document which resources are global catalog vs tenant-private.

---

## Phase 5 — Product / ops hardening

- [ ] Audit log: key add/rotate, login, failed 2FA, admin actions.
- [ ] Session list + revoke-all; shorter TTL; new-login notification (email/Telegram).
- [ ] Usage meter per user (calls / estimated USD) even under BYOK — abuse signal.
- [ ] Plans: Free = BYOK only; optional later Pro = platform credits.
- [ ] Feature flags per user/plan.
- [ ] CI secret scanning; cron secret rotation checklist.
- [ ] Backup + restore drill for Postgres + storage.

---

## Target signup UX

1. Email + password  
2. Cloudflare Turnstile  
3. Mandatory TOTP QR + recovery codes  
4. “Add API keys” checklist (WaveSpeed / XAI / …)  
5. Dashboard  

No password-only session. No silent platform key.

---

## Suggested implementation order

1. Phase 1 — Auth + generations POST hole  
2. Phase 2 — Strict BYOK  
3. Phase 3 — Cloudflare  
4. Phase 4 — Tenant-scope tables that must be private  
5. Phase 5 — Audit, usage, ops  

---

## Out of scope (for this draft)

- Redesign of billing/subscribe UI (only note that subscription must gate APIs).
- Multi-region / org (team) tenancy — future; current model is single-user tenants.
- Replacing Supabase — keep; tighten path + access patterns.

---

## Merge notes

When combining with a newer plan:

- Keep **Phases 1–3** as the security backbone unless the new plan explicitly replaces them.
- Reconcile key names and Settings UX with whatever the new product onboarding defines.
- Re-run the audit in `security-tenancy-current-state.md` after each phase; update checkboxes here.
- Prefer one source of truth for BYOK (`user_api_keys`) — do not reintroduce dual stores.
