/**
 * Telegram helpers for the English-teaching-content bot. Own token/file,
 * same shape as lib/telegram-recreate.ts — kept separate so nothing here can
 * regress any other bot.
 */
const BOT_TOKEN = process.env.TELEGRAM_TEACH_BOT_TOKEN

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
  if (!data.ok) throw new Error(`Telegram(teach) ${method} failed: ${data.description}`)
  return data.result
}

export async function sendText(chatId: string | number, text: string) {
  return call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  })
}

/**
 * Fetch a photo/file the user sent to THIS bot. Telegram doesn't hand out
 * the file itself with the message — file_id has to be exchanged for a path
 * via getFile, and that download link expires in ~1h, so bytes are pulled
 * immediately and kept in memory for the single Grok call that follows.
 */
export async function downloadTelegramFile(fileId: string): Promise<{
  buffer: Buffer
  contentType: string
}> {
  const file = await call('getFile', { file_id: fileId }) as { file_path?: string }
  if (!file?.file_path) throw new Error('Telegram getFile returned no path')

  const res = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`)
  if (!res.ok) throw new Error(`Telegram file download failed (${res.status})`)

  const extension = file.file_path.split('.').pop()?.toLowerCase() ?? 'jpg'
  const mimeByExt: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') ?? mimeByExt[extension] ?? 'image/jpeg',
  }
}
