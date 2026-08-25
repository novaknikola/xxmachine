import { TELEGRAM_CHAT_ID, TELEGRAM_BOT_TOKEN } from './config'
import { getSubscriberChatIds, removeSubscriber } from './subscribers'

const HEADER = 'Evo je viralna lista videa za danas:'
const TELEGRAM_MESSAGE_LIMIT = 4096

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

class TelegramSendError extends Error {
  constructor(message: string, public status: number) {
    super(message)
  }
}

/**
 * Own bot/token, deliberately not lib/telegram.ts's shared TELEGRAM_BOT_TOKEN —
 * same isolation reasoning as lib/telegram-recreate.ts's separate pose-recreate
 * bot: nothing here is shared code, so nothing here can regress the main bot
 * or any other workflow that depends on it.
 */
async function sendMessage(chatId: string | number, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  })
  const data = await res.json()
  if (!data.ok) throw new TelegramSendError(`Telegram(viral-monitor) sendMessage failed: ${data.description}`, res.status)
}

/** Splits a long URL list into messages that each stay under Telegram's cap. */
function buildChunks(urls: string[]): string[] {
  const chunks: string[] = []
  let lines: string[] = [HEADER, '']

  const flush = () => {
    if (lines.length > 2) chunks.push(lines.join('\n'))
  }

  for (const url of urls) {
    const line = escapeHtml(url)
    const candidate = [...lines, line].join('\n')
    if (candidate.length > TELEGRAM_MESSAGE_LIMIT && lines.length > 2) {
      flush()
      lines = [HEADER, '', line]
    } else {
      lines.push(line)
    }
  }
  flush()
  return chunks
}

async function sendChunksTo(chatId: string, chunks: string[]): Promise<boolean> {
  try {
    for (const chunk of chunks) {
      await sendMessage(chatId, chunk)
    }
    return true
  } catch (err) {
    if (err instanceof TelegramSendError && err.status === 403) {
      // Bot was blocked/kicked — self-clean instead of failing forever.
      await removeSubscriber(Number(chatId)).catch(() => {})
      console.warn(`[viral-monitor] chat ${chatId} blocked the bot — removed from subscribers`)
    } else {
      console.error(`[viral-monitor] Telegram send to ${chatId} failed:`, err instanceof Error ? err.message : err)
    }
    return false
  }
}

/**
 * Sends the daily viral-list report to every subscriber plus the static
 * VIRAL_MONITOR_TELEGRAM_CHAT_ID (kept for backward compatibility). Each
 * recipient is handled independently — one blocked/failed chat cannot stop
 * delivery to the rest. Returns true (→ caller marks these videos reported)
 * as soon as at least one recipient got the message; a batch is only left
 * unreported (retried tomorrow) when literally nobody could be reached.
 */
export async function sendViralReport(urls: string[]): Promise<boolean> {
  if (!urls.length) return true
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('[viral-monitor] no bot token configured — set VIRAL_MONITOR_TELEGRAM_BOT_TOKEN')
    return false
  }

  const subscriberIds = await getSubscriberChatIds().catch(err => {
    console.error('[viral-monitor] failed to load subscribers:', err instanceof Error ? err.message : err)
    return [] as string[]
  })
  const recipients = new Set(subscriberIds)
  if (TELEGRAM_CHAT_ID) recipients.add(String(TELEGRAM_CHAT_ID))

  if (!recipients.size) {
    console.error('[viral-monitor] no recipients configured — no subscribers and VIRAL_MONITOR_TELEGRAM_CHAT_ID unset')
    return false
  }

  const chunks = buildChunks(urls)
  let successCount = 0
  for (const chatId of recipients) {
    if (await sendChunksTo(chatId, chunks)) successCount++
  }

  return successCount > 0
}

/** Best-effort run-failure alert to the static chat only — swallow errors, a failed alert must not mask the original error. */
export async function sendErrorAlert(message: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return
  await sendMessage(TELEGRAM_CHAT_ID, `⚠️ Viral monitor run failed: ${escapeHtml(message.slice(0, 300))}`).catch(() => {})
}
