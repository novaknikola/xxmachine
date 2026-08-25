import { NextRequest, NextResponse } from 'next/server'
import { addSubscriber, removeSubscriber } from '@/lib/viral-monitor/subscribers'

const CRON_SECRET = process.env.CRON_SECRET

/**
 * Webhook for @igreplicatorbot (VIRAL_MONITOR_TELEGRAM_BOT_TOKEN). This bot
 * has exactly two commands and no other behavior, by design — it exists only
 * to let people opt into the daily viral report, nothing else.
 */
async function sendReply(chatId: number, text: string): Promise<void> {
  const token = process.env.VIRAL_MONITOR_TELEGRAM_BOT_TOKEN
  if (!token) return
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  }).catch(() => {})
}

export async function POST(req: NextRequest) {
  // Verify webhook secret — fail closed so an unset secret cannot open the webhook.
  // Same pattern/secret as /api/telegram/webhook.
  if (!CRON_SECRET) {
    console.error('[viral-monitor/webhook] CRON_SECRET is not set — refusing to run')
    return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 503 })
  }
  if (req.nextUrl.searchParams.get('secret') !== CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const message = body.message
    const chatId = message?.chat?.id as number | undefined
    const text = (message?.text as string | undefined)?.trim()

    if (chatId && text === '/start') {
      await addSubscriber(chatId)
      await sendReply(chatId, 'Prijavljen si — dobijaćeš dnevnu listu viralnih videa ovde. Pošalji /stop da se odjaviš.')
    } else if (chatId && text === '/stop') {
      await removeSubscriber(chatId)
      await sendReply(chatId, 'Odjavljen si — nećeš više dobijati dnevni izveštaj.')
    } else if (chatId) {
      await sendReply(chatId, 'Pošalji /start da primaš dnevnu listu viralnih videa, ili /stop da se odjaviš.')
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[viral-monitor/webhook]', err)
    // Always ack with 200: a non-2xx makes Telegram retry the same update
    // repeatedly instead of resolving it.
    return NextResponse.json({ ok: false, error: String(err) })
  }
}
