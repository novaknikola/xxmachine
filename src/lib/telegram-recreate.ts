/**
 * Telegram helpers for the Kling 3.0 recreate bot (@contentreplicatorbot).
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

export async function sendVideo(
  chatId: string | number,
  videoUrl: string,
  caption: string,
  replyMarkup?: object,
) {
  return call('sendVideo', {
    chat_id: chatId,
    video: videoUrl,
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
  const safeExt = /^(jpe?g|png|webp|mp4|m4v|mov)$/.test(extension) ? extension : 'jpg'
  const fallbackType = /^(mp4|m4v|mov)$/.test(safeExt) ? 'video/mp4' : 'image/jpeg'
  return {
    buffer: await res.arrayBuffer(),
    contentType: res.headers.get('content-type') ?? fallbackType,
    extension: safeExt,
  }
}

export function variationChoiceKeyboard(jobId: string) {
  return {
    inline_keyboard: [[
      { text: 'Change anything?', callback_data: `kr:var:${jobId}` },
      { text: 'Skip', callback_data: `kr:skip:${jobId}` },
    ]],
  }
}

export function confirmRecreateKeyboard(urlCount: number) {
  const n = Math.max(1, urlCount)
  return {
    inline_keyboard: [[
      { text: `▶️ Recreate ${n} reel${n === 1 ? '' : 's'}`, callback_data: 'kr:go' },
      { text: '✖️ Cancel', callback_data: 'kr:cancel' },
    ]],
  }
}

export function settingsKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: 'Std', callback_data: 'kr:set:variant:std' },
        { text: 'Pro', callback_data: 'kr:set:variant:pro' },
        { text: '4K', callback_data: 'kr:set:variant:4k' },
      ],
      [
        { text: 'Dur auto', callback_data: 'kr:set:dur:auto' },
        { text: '3s', callback_data: 'kr:set:dur:3' },
        { text: '5s', callback_data: 'kr:set:dur:5' },
        { text: '10s', callback_data: 'kr:set:dur:10' },
        { text: '15s', callback_data: 'kr:set:dur:15' },
      ],
      [
        { text: 'Sound on', callback_data: 'kr:set:sound:on' },
        { text: 'Sound off', callback_data: 'kr:set:sound:off' },
      ],
      [
        { text: 'CFG 0.3', callback_data: 'kr:set:cfg:0.3' },
        { text: '0.5', callback_data: 'kr:set:cfg:0.5' },
        { text: '0.7', callback_data: 'kr:set:cfg:0.7' },
        { text: '1.0', callback_data: 'kr:set:cfg:1' },
      ],
      [
        { text: 'Shot customize', callback_data: 'kr:set:shot:customize' },
        { text: 'Intelligence', callback_data: 'kr:set:shot:intelligence' },
      ],
      [
        { text: '✍️ Negative prompt', callback_data: 'kr:set:neg' },
        { text: 'Clear neg', callback_data: 'kr:set:negclear' },
      ],
      [
        { text: '🧩 Element IDs', callback_data: 'kr:set:els' },
        { text: 'Clear elements', callback_data: 'kr:set:elsclear' },
      ],
    ],
  }
}
