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
