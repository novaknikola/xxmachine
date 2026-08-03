const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN

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
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description}`)
  return data.result
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

export async function sendText(chatId: string | number, text: string) {
  return call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
  })
}

export async function sendVideo(
  chatId: string | number,
  videoUrl: string,
  caption: string,
) {
  return call('sendVideo', {
    chat_id: chatId,
    video: videoUrl,
    caption,
    parse_mode: 'HTML',
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

export async function editMessageCaption(
  chatId: string | number,
  messageId: number,
  caption: string,
) {
  return call('editMessageCaption', {
    chat_id: chatId,
    message_id: messageId,
    caption,
    parse_mode: 'HTML',
  })
}

export async function answerCallbackQuery(callbackQueryId: string, text: string) {
  return call('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
  })
}

export function approvalKeyboard(postId: string) {
  return {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `approve:${postId}` },
      { text: '❌ Reject', callback_data: `reject:${postId}` },
    ]],
  }
}

/**
 * Download a photo the user sent to the bot.
 *
 * Telegram does not hand out the file with the message — it gives a file_id
 * that has to be exchanged for a path via getFile, and the download link is
 * only valid for about an hour. So the bytes are fetched now and re-hosted;
 * storing the Telegram URL would give a reference that expires mid-job.
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

/** Approve / cancel buttons for an assembled Copy-Paste batch. */
export function batchKeyboard(batchId: string) {
  return {
    inline_keyboard: [[
      { text: '▶️ Replicate', callback_data: `cpstart:${batchId}` },
      { text: '✖️ Cancel', callback_data: `cpcancel:${batchId}` },
    ]],
  }
}

/** Edit a plain text message (sendPhoto captions use editMessageCaption). */
export async function editMessageText(
  chatId: string | number,
  messageId: number,
  text: string,
) {
  return call('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  })
}
