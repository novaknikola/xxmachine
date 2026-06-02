import { NextRequest, NextResponse } from 'next/server'
import { query, one } from '@/lib/db'
import { sendPhoto, approvalKeyboard } from '@/lib/telegram'

const ADMIN_GROUP = process.env.TELEGRAM_ADMIN_GROUP_ID!

export async function POST(req: NextRequest) {
  try {
    const { characterId, characterName, imageUrls, caption, platforms, scheduledAt, createdBy } =
      await req.json()

    const urls: string[] = Array.isArray(imageUrls) ? imageUrls.filter(Boolean) : []
    if (!characterId || !urls.length || !caption || !platforms?.length || !scheduledAt || !createdBy) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    // Insert into DB
    const result = await one<{ id: string }>(
      `INSERT INTO scheduled_posts
        (character_id, character_name, image_url, image_urls, caption, platforms, scheduled_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [characterId, characterName, urls[0], urls, caption, platforms, scheduledAt, createdBy],
    )
    const postId = result!.id

    // Send approval request to admin Telegram group
    let telegramMessageId: number | null = null
    if (ADMIN_GROUP) {
      const scheduledDate = new Date(scheduledAt).toLocaleString('en-US', {
        dateStyle: 'medium', timeStyle: 'short',
      })
      const previewCaption =
        `📸 <b>${characterName}</b> — new post\n` +
        `🕐 Scheduled: ${scheduledDate}\n` +
        `📱 Platforms: ${platforms.join(', ')}\n` +
        `🖼 Images: ${urls.length}\n\n` +
        `${caption}`

      try {
        const msg = await sendPhoto(ADMIN_GROUP, urls[0], previewCaption, approvalKeyboard(postId))
        telegramMessageId = msg.message_id
        await query(
          'UPDATE scheduled_posts SET telegram_message_id=$1 WHERE id=$2',
          [telegramMessageId, postId],
        )
      } catch (e) {
        console.error('Telegram notification failed:', e)
      }
    }

    return NextResponse.json({ id: postId, telegramMessageId })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
