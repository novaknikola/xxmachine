import { one } from '@/lib/db'
import { sendPhoto, sendText, sendVideo } from '@/lib/telegram'
import { sanitizeDriveKey } from '@/lib/drive-archive/paths'

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

/**
 * Newest Drive folder this run filed something into, as a link.
 *
 * The archive uploads asynchronously, so at notification time a folder may not
 * exist yet — a missing link is normal and simply omitted rather than reported
 * as a problem.
 */
async function driveFolderLink(userId: string, profile: string): Promise<string | null> {
  // character_key is stored sanitized (lowercased, non-alphanumerics collapsed),
  // so the raw profile handle has to be put through the same function or the
  // lookup silently finds nothing.
  const row = await one<{ folder_id: string }>(
    `SELECT folder_id FROM drive_folders
      WHERE user_id = $1 AND character_key = $2
      ORDER BY date_key DESC
      LIMIT 1`,
    [userId, sanitizeDriveKey(profile)],
  )
  return row?.folder_id ? `https://drive.google.com/drive/folders/${row.folder_id}` : null
}

export async function notifyReplicationDone(opts: {
  userId: string
  profile: string
  contentUrl: string
  contentType: string | null
  imageUrl?: string | null
  videoUrl?: string | null
  /** Offers a Repurpose button — the decision is worth making after seeing the clip. */
  itemId?: string | null
}): Promise<void> {
  const folderUrl = await driveFolderLink(opts.userId, opts.profile).catch(() => null)

  const lines = [
    `✅ <b>Replication ready</b>`,
    `Source: @${escapeHtml(opts.profile)}`,
    opts.contentType ? `Type: ${escapeHtml(opts.contentType)}` : '',
    `<a href="${escapeHtml(opts.contentUrl)}">Original post</a>`,
    folderUrl ? `<a href="${folderUrl}">📁 Drive folder</a>` : '',
  ].filter(Boolean)

  await notifyMonitorUser(opts.userId, lines.join('\n'), {
    imageUrl: opts.videoUrl ? undefined : opts.imageUrl ?? undefined,
    videoUrl: opts.videoUrl ?? undefined,
  })

  // Offered rather than automatic: variants cost money, and the point of seeing
  // the clip first is being able to decide it is not worth spreading.
  if (opts.itemId && opts.videoUrl) {
    const chatId = await resolveChatId(opts.userId).catch(() => null)
    if (chatId) {
      const { getRepurposeSettings } = await import('./telegram-repurpose')
      const s = await getRepurposeSettings(opts.userId)
      const sent = await sendText(chatId, 'Spread this one?') as { message_id?: number }
      if (sent?.message_id) {
        const { editMessageReplyMarkup } = await import('@/lib/telegram')
        await editMessageReplyMarkup(chatId, sent.message_id, {
          inline_keyboard: [[
            { text: `♻️ Repurpose ×${s.variantCount}`, callback_data: `rpgo:${opts.itemId}` },
            { text: '✖️ No', callback_data: `rpno:${opts.itemId}` },
          ]],
        })
      }
    }
  }
}

export async function notifyViralPost(
  userId: string,
  profile: string,
  contentUrl: string,
  viewsGained: number,
): Promise<void> {
  const lines = [
    `🚀 <b>Viral alert</b> — @${escapeHtml(profile)}`,
    `+${viewsGained.toLocaleString()} views in ~24h`,
    escapeHtml(contentUrl),
  ]
  await notifyMonitorUser(userId, lines.join('\n'))
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
