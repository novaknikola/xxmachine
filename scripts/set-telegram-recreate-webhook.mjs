#!/usr/bin/env node
/**
 * Register Telegram webhook for the pose-recreate bot (@contentreplicatorbot).
 * Usage: node scripts/set-telegram-recreate-webhook.mjs
 * Requires: TELEGRAM_RECREATE_BOT_TOKEN, CRON_SECRET, NEXT_PUBLIC_BASE_URL in .env.local
 */
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(process.cwd(), '.env.local') })

const token = process.env.TELEGRAM_RECREATE_BOT_TOKEN
const secret = process.env.CRON_SECRET
const base = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://xxmachine.com'

if (!token || !secret) {
  console.error('Set TELEGRAM_RECREATE_BOT_TOKEN and CRON_SECRET in .env.local')
  process.exit(1)
}

const webhookUrl = `${base.replace(/\/$/, '')}/api/telegram-recreate/webhook?secret=${encodeURIComponent(secret)}`

const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message', 'callback_query'] }),
})
const data = await res.json()
console.log(JSON.stringify(data, null, 2))

if (!data.ok) process.exit(1)

const info = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`).then(r => r.json())
console.log('Webhook info:', JSON.stringify(info.result, null, 2))
