import { NextRequest, NextResponse } from 'next/server'
import { sendText, downloadTelegramFile } from '@/lib/telegram-teach'
import { generateLessonContent, parseTeacherRequest } from '@/lib/teach-content'
import { ensureChildFolder, createGoogleDocInFolder } from '@/lib/google-drive'

/**
 * Webhook for the English-teaching-content bot: teacher sends a textbook
 * page photo (or a topic, for Grade 9) + which grade it's for, this
 * analyses it with Grok and drops a ready-to-use Google Doc into Drive.
 * Deliberately standalone (own bot token, no DB, no user linking) — single
 * teacher, single Drive root folder shared with the service account.
 */
const CRON_SECRET = process.env.CRON_SECRET
const ROOT_FOLDER_ID = process.env.TEACH_DRIVE_ROOT_FOLDER_ID
const ALLOWED_CHAT_IDS = (process.env.TELEGRAM_TEACH_ALLOWED_CHAT_IDS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

interface TgPhotoSize { file_id: string; width: number; height: number }
interface TgMessage {
  chat?: { id: number }
  text?: string
  caption?: string
  media_group_id?: string
  photo?: TgPhotoSize[]
  document?: { file_id: string; mime_type?: string }
}

interface PendingGroup {
  chatId: number
  images: { buffer: Buffer; contentType: string }[]
  text: string
  timer: ReturnType<typeof setTimeout>
}

// Telegram sends each photo in an album as a separate update sharing one
// media_group_id — buffer them briefly and process together, same idea as
// telegram-recreate's chat-keyed pending state but in-memory since this is
// one always-on PM2 process, not serverless.
const pendingGroups = new Map<string, PendingGroup>()
const GROUP_DEBOUNCE_MS = 1500

async function processRequest(chatId: number, text: string, images: { buffer: Buffer; contentType: string }[]) {
  if (!ROOT_FOLDER_ID) {
    await sendText(chatId, '⚠️ Bot nije podešen do kraja — nedostaje TEACH_DRIVE_ROOT_FOLDER_ID.')
    return
  }

  const parsed = parseTeacherRequest(text, images.length > 0)
  if (!parsed) {
    await sendText(
      chatId,
      "Za koji razred je ovo? Napiši npr. <b>Grade 7</b> uz sliku, ili za deveti razred <b>Grade 9 - tema</b> (npr. \"Grade 9 - Environment\").",
    )
    return
  }

  const modeLabel = parsed.mode === 'grade-9' ? `Grade 9 Speaking` : `Grade ${parsed.gradeLabel}`
  await sendText(chatId, `⏳ Analiziram i pravim materijale za <b>${escapeHtml(modeLabel)}</b>...`)

  try {
    const lessonText = await generateLessonContent({ mode: parsed.mode, text: parsed.text, images })

    const now = new Date()
    const dateStr = now.toISOString().slice(0, 10)
    const timeStr = now.toTimeString().slice(0, 5).replace(':', '-')
    const dayFolderId = await ensureChildFolder(ROOT_FOLDER_ID, dateStr)

    const topicPart = parsed.mode === 'grade-9' && parsed.text ? ` - ${parsed.text}` : ''
    const title = `${modeLabel}${topicPart} (${timeStr})`.slice(0, 150)

    const doc = await createGoogleDocInFolder(dayFolderId, title, lessonText)
    await sendText(chatId, `✅ Gotovo! <b>${escapeHtml(modeLabel)}</b>\n📁 <a href="${doc.link}">Otvori u Google Drive</a>`)
  } catch (err) {
    console.error('[telegram-teach/webhook] generation failed:', err)
    await sendText(chatId, `❌ Nešto nije uspelo: ${escapeHtml(err instanceof Error ? err.message : 'unknown error')}`)
  }
}

function scheduleGroup(groupId: string, chatId: number, text: string, image?: { buffer: Buffer; contentType: string }) {
  const existing = pendingGroups.get(groupId)
  if (existing) {
    if (image) existing.images.push(image)
    if (text) existing.text = text
    clearTimeout(existing.timer)
    existing.timer = setTimeout(() => flushGroup(groupId), GROUP_DEBOUNCE_MS)
    return
  }
  const entry: PendingGroup = {
    chatId,
    images: image ? [image] : [],
    text,
    timer: setTimeout(() => flushGroup(groupId), GROUP_DEBOUNCE_MS),
  }
  pendingGroups.set(groupId, entry)
}

function flushGroup(groupId: string) {
  const entry = pendingGroups.get(groupId)
  if (!entry) return
  pendingGroups.delete(groupId)
  processRequest(entry.chatId, entry.text, entry.images).catch(err =>
    console.error('[telegram-teach/webhook] flushGroup failed:', err),
  )
}

export async function POST(req: NextRequest) {
  if (!CRON_SECRET) {
    console.error('[telegram-teach/webhook] CRON_SECRET is not set — refusing to run')
    return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 503 })
  }
  if (req.nextUrl.searchParams.get('secret') !== CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const message = body.message as TgMessage | undefined
    const chatId = message?.chat?.id
    if (!message || !chatId) return NextResponse.json({ ok: true })

    const text = (message.text ?? message.caption ?? '').trim()

    if (ALLOWED_CHAT_IDS.length && !ALLOWED_CHAT_IDS.includes(String(chatId))) {
      await sendText(chatId, `Nisi autorizovan/a za ovog bota. Tvoj chat ID je <code>${chatId}</code> — prosledi ga adminu.`).catch(() => {})
      return NextResponse.json({ ok: true })
    }

    if (text.startsWith('/start')) {
      await sendText(
        chatId,
        'Zdravo! Pošalji mi sliku stranice iz udžbenika (ili opiši šta se radi) i napiši za koji razred je — npr. <b>Grade 7</b>. Za deveti razred pošalji <b>Grade 9 - tema</b>.',
      )
      return NextResponse.json({ ok: true })
    }

    // Photo (compressed) or an image sent as a file/document.
    const isImageDocument = message.document?.mime_type?.startsWith('image/')
    const fileId = message.photo?.length
      ? message.photo[message.photo.length - 1].file_id
      : isImageDocument
        ? message.document!.file_id
        : null

    if (fileId) {
      const { buffer, contentType } = await downloadTelegramFile(fileId)
      if (message.media_group_id) {
        scheduleGroup(message.media_group_id, chatId, text, { buffer, contentType })
      } else {
        await processRequest(chatId, text, [{ buffer, contentType }])
      }
      return NextResponse.json({ ok: true })
    }

    if (text) {
      await processRequest(chatId, text, [])
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[telegram-teach/webhook]', err)
    return NextResponse.json({ ok: true })
  }
}
