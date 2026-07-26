import { NextRequest, NextResponse } from 'next/server'
import { rows, query } from '@/lib/db'
import { uploadImagesFromUrls } from '@/lib/supabase-storage'
import { requireUser } from '@/lib/session'

interface SaveBody {
  kind: string
  characterId?: string
  characterName?: string
  prompt: string
  dimension?: string
  batch?: number
  wavespeedUrls: string[]
  userId?: string
}

export interface HistoryRecord {
  id: string
  kind: string
  character_id: string | null
  character_name: string | null
  prompt: string
  dimension: string | null
  batch: number
  image_urls: string[]
  video_url: string | null
  user_id: string | null
  created_at: string
  source: 'generations' | 'discovery' | 'queue'
}

// POST — save a generation, upload images to Storage, persist to DB
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as SaveBody

    if (!body.wavespeedUrls?.length) {
      return NextResponse.json({ error: 'No URLs provided' }, { status: 400 })
    }
    if (!body.prompt) {
      return NextResponse.json({ error: 'Missing prompt' }, { status: 400 })
    }

    const genId = crypto.randomUUID()
    const basePath = `${body.userId ?? 'anon'}/${genId}`
    const permanentUrls = await uploadImagesFromUrls(body.wavespeedUrls, basePath)

    await query(
      `INSERT INTO generations
        (id, kind, character_id, character_name, prompt, dimension, batch, image_urls, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        genId,
        body.kind ?? 'text2img',
        body.characterId ?? null,
        body.characterName ?? null,
        body.prompt,
        body.dimension ?? null,
        body.batch ?? 1,
        permanentUrls,
        body.userId ?? null,
      ],
    )

    return NextResponse.json({ ok: true, id: genId, imageUrls: permanentUrls })
  } catch (err) {
    console.error('[generations] save error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}

function extractQueueUrls(output: unknown): string[] {
  if (!output || typeof output !== 'object') return []
  const o = output as Record<string, unknown>
  const urls: string[] = []
  if (Array.isArray(o.urls)) {
    for (const u of o.urls) {
      if (typeof u === 'string' && u && !u.startsWith('error:')) urls.push(u)
    }
  }
  if (typeof o.finalUrl === 'string' && o.finalUrl) urls.push(o.finalUrl)
  if (Array.isArray(o.carouselRows)) {
    for (const row of o.carouselRows as Array<{ images?: string[] }>) {
      if (Array.isArray(row.images)) urls.push(...row.images.filter(Boolean))
    }
  }
  return [...new Set(urls)]
}

// GET — unified history: generations + discovery replicate + queue outputs
export async function GET(req: NextRequest) {
  try {
    const auth = await requireUser(req)
    if (auth instanceof NextResponse) return auth

    const { searchParams } = new URL(req.url)
    const kind = searchParams.get('kind')
    const limit = Math.min(Number(searchParams.get('limit') ?? 200), 500)
    const offset = Number(searchParams.get('offset') ?? 0)
    const userId = auth.id

    const [gens, discovery, queueJobs] = await Promise.all([
      rows<{
        id: string
        kind: string
        character_id: string | null
        character_name: string | null
        prompt: string
        dimension: string | null
        batch: number
        image_urls: string[]
        user_id: string | null
        created_at: string
      }>(
        `SELECT id, kind, character_id, character_name, prompt, dimension, batch,
                image_urls, user_id, created_at
           FROM generations
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 500`,
        [userId],
      ),
      rows<{
        id: string
        profile: string
        scene_prompt: string | null
        generated_image_url: string | null
        generated_end_image_url: string | null
        kling_video_url: string | null
        discovered_at: string
        content_type: string | null
      }>(
        `SELECT id, profile, scene_prompt, generated_image_url, generated_end_image_url,
                kling_video_url, discovered_at, content_type
           FROM discovery_items
          WHERE user_id = $1
            AND (
              generated_image_url IS NOT NULL
              OR generated_end_image_url IS NOT NULL
              OR kling_video_url IS NOT NULL
            )
          ORDER BY discovered_at DESC
          LIMIT 300`,
        [userId],
      ),
      rows<{
        id: string
        job_type: string
        output: unknown
        created_at: string
        finished_at: string | null
      }>(
        `SELECT id, job_type, output, created_at, finished_at
           FROM generation_queue
          WHERE user_id = $1 AND status = 'done' AND output IS NOT NULL
          ORDER BY COALESCE(finished_at, created_at) DESC
          LIMIT 200`,
        [userId],
      ),
    ])

    const merged: HistoryRecord[] = []

    for (const g of gens) {
      merged.push({
        id: g.id,
        kind: g.kind,
        character_id: g.character_id,
        character_name: g.character_name,
        prompt: g.prompt,
        dimension: g.dimension,
        batch: g.batch,
        image_urls: g.image_urls ?? [],
        video_url: null,
        user_id: g.user_id,
        created_at: g.created_at,
        source: 'generations',
      })
    }

    for (const d of discovery) {
      const images = [d.generated_image_url, d.generated_end_image_url].filter(Boolean) as string[]
      if (images.length) {
        merged.push({
          id: `${d.id}:img`,
          kind: 'replicate',
          character_id: null,
          character_name: d.profile,
          prompt: d.scene_prompt ?? `Copy-Paste @${d.profile}`,
          dimension: null,
          batch: images.length,
          image_urls: images,
          video_url: null,
          user_id: userId,
          created_at: d.discovered_at,
          source: 'discovery',
        })
      }
      if (d.kling_video_url) {
        merged.push({
          id: `${d.id}:vid`,
          kind: 'replicate_video',
          character_id: null,
          character_name: d.profile,
          prompt: d.scene_prompt ?? `Copy-Paste video @${d.profile}`,
          dimension: null,
          batch: 1,
          image_urls: d.generated_image_url ? [d.generated_image_url] : [],
          video_url: d.kling_video_url,
          user_id: userId,
          created_at: d.discovered_at,
          source: 'discovery',
        })
      }
    }

    for (const q of queueJobs) {
      const urls = extractQueueUrls(q.output)
      if (!urls.length) continue
      const videos = urls.filter(u => /\.mp4(\?|$)/i.test(u) || u.includes('/video'))
      const images = urls.filter(u => !videos.includes(u))
      merged.push({
        id: `queue:${q.id}`,
        kind: q.job_type,
        character_id: null,
        character_name: null,
        prompt: `Queue · ${q.job_type}`,
        dimension: null,
        batch: urls.length,
        image_urls: images,
        video_url: videos[0] ?? null,
        user_id: userId,
        created_at: q.finished_at ?? q.created_at,
        source: 'queue',
      })
    }

    merged.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    const filtered = kind && kind !== 'all'
      ? merged.filter(r => r.kind === kind)
      : merged

    const page = filtered.slice(offset, offset + limit)
    return NextResponse.json({ generations: page, total: filtered.length })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const auth = await requireUser(req)
    if (auth instanceof NextResponse) return auth

    const { id } = await req.json()
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

    // Only rows that live in `generations` are hard-deletable from this endpoint.
    if (String(id).includes(':') || String(id).startsWith('queue:')) {
      return NextResponse.json({ error: 'This item is managed elsewhere and cannot be deleted here' }, { status: 400 })
    }

    await query('DELETE FROM generations WHERE id = $1 AND user_id = $2', [id, auth.id])
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 })
  }
}
