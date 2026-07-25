import { one } from '@/lib/db'
import { sendPhoto, sendText, sendVideo } from '@/lib/telegram'

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function resolveChatId(userId: string): Promise<number | string | null> {
  const user = await one<{ telegram_chat_id: string | number | null }>(
    `SELECT telegram_chat_id FROM users WHERE id = $1`,
    [userId],
  )
  if (user?.telegram_chat_id) return user.telegram_chat_id

  const fallback = process.env.TELEGRAM_MONITOR_CHAT_ID ?? process.env.TELEGRAM_ADMIN_GROUP_ID
  return fallback ?? null
}

export async function notifyMonitorUser(
  userId: string,
  text: string,
  opts?: { imageUrl?: string; videoUrl?: string },
): Promise<boolean> {
  if (!process.env.TELEGRAM_BOT_TOKEN) return false

  const chatId = await resolveChatId(userId)
  if (!chatId) {
    console.warn('[monitor/notify] No telegram_chat_id for user', userId)
    return false
  }

  try {
    if (opts?.videoUrl) {
      await sendVideo(chatId, opts.videoUrl, text)
    } else if (opts?.imageUrl) {
      await sendPhoto(chatId, opts.imageUrl, text)
    } else {
      await sendText(chatId, text)
    }
    return true
  } catch (err) {
    console.error('[monitor/notify]', err)
    return false
  }
}

export async function notifyNewPosts(
  userId: string,
  profile: string,
  count: number,
): Promise<void> {
  if (count <= 0) return
  await notifyMonitorUser(
    userId,
    `🔔 <b>@${escapeHtml(profile)}</b> — ${count} new post${count > 1 ? 's' : ''} detected.\nCheck Discovery or Copy-Paste → Replicate.`,
  )
}

export async function notifyReplicationDone(opts: {
  userId: string
  profile: string
  contentUrl: string
  contentType: string | null
  imageUrl?: string | null
  videoUrl?: string | null
}): Promise<void> {
  const lines = [
    `✅ <b>Replication ready</b>`,
    `Source: @${escapeHtml(opts.profile)}`,
    opts.contentType ? `Type: ${escapeHtml(opts.contentType)}` : '',
    `<a href="${escapeHtml(opts.contentUrl)}">Original post</a>`,
  ].filter(Boolean)

  await notifyMonitorUser(opts.userId, lines.join('\n'), {
    imageUrl: opts.videoUrl ? undefined : opts.imageUrl ?? undefined,
    videoUrl: opts.videoUrl ?? undefined,
  })
}

export async function notifyReplicationFailed(
  userId: string,
  profile: string,
  error: string,
): Promise<void> {
  await notifyMonitorUser(
    userId,
    `❌ Replication failed for @${escapeHtml(profile)}\n${escapeHtml(error.slice(0, 300))}`,
  )
}
