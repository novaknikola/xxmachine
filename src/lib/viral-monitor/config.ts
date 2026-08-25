// All knobs for the isolated viral monitor live here, env-driven so the
// threshold/window can change without a code deploy — see .env.example.

export const SHEET_ID = process.env.VIRAL_MONITOR_SHEET_ID ?? null
export const SHEET_RANGE = process.env.VIRAL_MONITOR_SHEET_RANGE ?? 'Sheet1!A2:A'
// Dedicated output tab in the same spreadsheet — mirrors viral_monitor_videos
// (views, followers, dates) so it's visible outside the DB. Created
// automatically on first write if it doesn't already exist.
export const REPORT_SHEET_NAME = process.env.VIRAL_MONITOR_REPORT_SHEET_NAME ?? 'Videos'
export const REELS_PER_PROFILE = Number(process.env.VIRAL_MONITOR_REELS_PER_PROFILE ?? 5)
export const VIEWS_THRESHOLD = Number(process.env.VIRAL_MONITOR_VIEWS_THRESHOLD ?? 100_000)
export const WINDOW_DAYS = Number(process.env.VIRAL_MONITOR_WINDOW_DAYS ?? 5)
// A video also qualifies when views >= followers * this multiplier — additive
// to VIEWS_THRESHOLD (OR), not a replacement. To make it ratio-only, set
// VIEWS_THRESHOLD absurdly high instead of changing code.
export const FOLLOWERS_MULTIPLIER = Number(process.env.VIRAL_MONITOR_FOLLOWERS_MULTIPLIER ?? 10)
export const TELEGRAM_CHAT_ID =
  process.env.VIRAL_MONITOR_TELEGRAM_CHAT_ID ??
  process.env.TELEGRAM_MONITOR_CHAT_ID ??
  process.env.TELEGRAM_ADMIN_GROUP_ID ??
  null

// Deliberately its own bot/token, not the shared TELEGRAM_BOT_TOKEN — same
// isolation reasoning as TELEGRAM_RECREATE_BOT_TOKEN (lib/telegram-recreate.ts):
// nothing here is shared code, so nothing here can regress the main bot.
export const TELEGRAM_BOT_TOKEN = process.env.VIRAL_MONITOR_TELEGRAM_BOT_TOKEN ?? null

export const SCAN_CONCURRENCY = 3
export const SCAN_RETRY_DELAY_MS = 3_000
