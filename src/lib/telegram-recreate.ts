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

/** Short codes kept under Telegram's 64-byte callback_data limit alongside a UUID. */
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

export function characterPickerKeyboard(
  fmt: FormatCode,
  characters: { id: string; name: string }[],
) {
  return {
    inline_keyboard: [
      ...characters.map(c => [{ text: `👤 ${c.name}`, callback_data: `rc:char:${fmt}:${c.id}` }]),
      [{ text: '✖️ Cancel', callback_data: 'rc:cancel' }],
    ],
  }
}

export function confirmKeyboard(fmt: FormatCode, characterId: string) {
  return {
    inline_keyboard: [[
      { text: '▶️ Generate', callback_data: `rc:go:${fmt}:${characterId}` },
      { text: '✖️ Cancel', callback_data: 'rc:cancel' },
    ]],
  }
}
