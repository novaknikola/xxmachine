import { NextResponse } from 'next/server'
import { rows } from '@/lib/db'

export async function GET() {
  try {
    const posts = await rows(
      `SELECT
        id,
        character_id   AS "characterId",
        character_name AS "characterName",
        COALESCE(image_urls, ARRAY[image_url]) AS "imageUrls",
        caption,
        platforms,
        scheduled_at   AS "scheduledAt",
        status,
        error,
        created_by     AS "createdBy"
       FROM scheduled_posts
       ORDER BY scheduled_at ASC`,
    )
    return NextResponse.json(posts)
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
