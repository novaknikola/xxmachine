/**
 * Telegram helpers for the pose-recreate bot (@contentreplicatorbot).
 * Deliberately a separate file/token from lib/telegram.ts (the Copy-Paste
 * bot) — same shape, but nothing here is shared code, so nothing here can
 * regress the existing bot.
 */
const BOT_TOKEN = process.env.TELEGRAM_RECREATE_BOT_TOKEN

function apiUrl(method: string) {
  return `https://api.telegram.org/bot${BOT_TOKEN}/${method}`
}

async function call(method: string, body: object) {
  const res = await fetch(apiUrl(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!data.ok) throw new Error(`Telegram(recreate) ${method} failed: ${data.description}`)
  return data.result
}

export async function sendText(chatId: string | number, text: string, replyMarkup?: object) {
  return call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  })
}

export async function sendPhoto(
  chatId: string | number,
  photoUrl: string,
  caption: string,
  replyMarkup?: object,
) {
  return call('sendPhoto', {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    parse_mode: 'HTML',
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  })
}

/**
 * One swipeable album instead of N separate messages — Telegram requires
 * 2-10 items; callers fall back to sendPhoto for a single image. Caption only
 * renders on the first item (Telegram's own rule, not ours).
 */
export async function sendMediaGroup(
  chatId: string | number,
  photoUrls: string[],
  caption: string,
) {
  return call('sendMediaGroup', {
    chat_id: chatId,
    media: photoUrls.map((url, i) => ({
      type: 'photo',
      media: url,
      ...(i === 0 ? { caption, parse_mode: 'HTML' } : {}),
    })),
  })
}

export async function editMessageReplyMarkup(
  chatId: string | number,
  messageId: number,
  replyMarkup: object,
) {
  return call('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup,
  })
}

export async function editMessageText(chatId: string | number, messageId: number, text: string) {
  return call('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  })
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  return call('answerCallbackQuery', { callback_query_id: callbackQueryId, text })
}

/**
 * Fetch a photo the user sent to THIS bot. Telegram doesn't hand out the file
 * itself with the message — file_id has to be exchanged for a path via
 * getFile, and that download link expires in ~1h, so the bytes are fetched
 * now and re-hosted. Mirrors lib/telegram.ts's downloadTelegramFile, kept as
 * its own copy here because it's keyed to BOT_TOKEN for this bot specifically.
 */
export async function downloadTelegramFile(fileId: string): Promise<{
  buffer: ArrayBuffer
  contentType: string
  extension: string
}> {
  const file = await call('getFile', { file_id: fileId }) as { file_path?: string }
  if (!file?.file_path) throw new Error('Telegram getFile returned no path')

  const res = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`)
  if (!res.ok) throw new Error(`Telegram file download failed (${res.status})`)

  const extension = file.file_path.split('.').pop()?.toLowerCase() ?? 'jpg'
  return {
    buffer: await res.arrayBuffer(),
    contentType: res.headers.get('content-type') ?? 'image/jpeg',
    extension: /^(jpe?g|png|webp)$/.test(extension) ? extension : 'jpg',
  }
}

/**
 * Short codes kept under Telegram's 64-byte callback_data limit. 'reels' is
 * deliberately not offered here yet — this pipeline only produces a still
 * image (Seedream Edit), and a Reel button that silently hands back a photo
 * would be misleading. content_format still accepts 'reels' in pose_library
 * so import can start now; the generation step catches up later.
 */
export const FORMAT_CODES = {
  p: 'posts', s: 'stories', c: 'carousels', fs: 'fanvue_sfw', fn: 'fanvue_nsfw',
} as const
export type FormatCode = keyof typeof FORMAT_CODES

export const FORMAT_LABELS: Record<FormatCode, string> = {
  p: '🖼️ Post', s: '📖 Story', c: '🎠 Carousel', fs: '🔥 Fanvue SFW', fn: '🔞 Fanvue NSFW',
}

/** Entry point: /recreate. 2-column grid, same visual language as BringSMS-style menus. */
export function recreateMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: FORMAT_LABELS.p, callback_data: 'rc:fmt:p' }, { text: FORMAT_LABELS.s, callback_data: 'rc:fmt:s' }],
      [{ text: FORMAT_LABELS.c, callback_data: 'rc:fmt:c' }],
      [{ text: FORMAT_LABELS.fs, callback_data: 'rc:fmt:fs' }, { text: FORMAT_LABELS.fn, callback_data: 'rc:fmt:fn' }],
    ],
  }
}

/**
 * Per-image cost — WaveSpeed's own Seedream Edit pricing ($0.045 base +
 * $0.003/extra image at 1k), same figure Copy-Paste v2's cost-estimate.ts
 * already uses (confirmed live against WaveSpeed's model page 2026-08-02).
 * Two images in (pose + reference) = one "extra" image beyond the base.
 */
export const PER_IMAGE_COST_USD = 0.048

export const COUNT_CHOICES = [1, 5, 10, 20] as const

/** Asked right after the reference photo lands — how many poses to draw at once. */
export function countKeyboard() {
  const btn = (n: number) => ({ text: `${n} ($${(n * PER_IMAGE_COST_USD).toFixed(2)})`, callback_data: `rc:cnt:${n}` })
  return {
    inline_keyboard: [
      [btn(COUNT_CHOICES[0]), btn(COUNT_CHOICES[1])],
      [btn(COUNT_CHOICES[2]), btn(COUNT_CHOICES[3])],
      [{ text: '✖️ Cancel', callback_data: 'rc:cancel' }],
    ],
  }
}

/** Asked once the count is picked — same Skip/Add text choice Copy-Paste offers per batch. */
export function promptChoiceKeyboard() {
  return {
    inline_keyboard: [[
      { text: '⏭ Skip', callback_data: 'rc:pskip' },
      { text: '✍️ Add prompt', callback_data: 'rc:padd' },
    ]],
  }
}
