import { NextRequest, NextResponse } from 'next/server'
import { rows } from '@/lib/db'
import { requireUser } from '@/lib/session'

const SORTS = ['newest', 'oldest', 'title', 'author'] as const
type Sort = typeof SORTS[number]

function parseSort(raw: string | null): Sort {
  return (SORTS as readonly string[]).includes(raw ?? '') ? (raw as Sort) : 'newest'
}

function orderByFor(sort: Sort): string {
  if (sort === 'oldest') return 'source_rank DESC'
  if (sort === 'title') return 'title ASC NULLS LAST, source_rank ASC'
  if (sort === 'author') return 'author ASC NULLS LAST, source_rank ASC'
  return 'source_rank ASC'
}

interface ScrapedPromptRow {
  id: string
  title: string | null
  prompt: string
  preview_image_url: string | null
  media_urls: string[]
  author: string | null
  source_url: string | null
  has_template_args: boolean
  total_count: number
}

export async function GET(req: NextRequest) {
  const auth = await requireUser(req)
  if (auth instanceof NextResponse) return auth

  const params = req.nextUrl.searchParams
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1)
  const pageSize = Math.min(60, Math.max(1, Number(params.get('pageSize') ?? 24) || 24))
  const sort = parseSort(params.get('sort'))
  const q = params.get('q')?.trim() ?? ''
  const author = params.get('author')?.trim() ?? ''
  const offset = (page - 1) * pageSize

  const conditions: string[] = ['is_active = true']
  const values: unknown[] = []

  if (q) {
    values.push(`%${q}%`)
    conditions.push(`(title ILIKE $${values.length} OR prompt ILIKE $${values.length})`)
  }
  if (author) {
    values.push(author)
    conditions.push(`author = $${values.length}`)
  }

  values.push(pageSize)
  const limitIdx = values.length
  values.push(offset)
  const offsetIdx = values.length

  const result = await rows<ScrapedPromptRow>(
    `SELECT id, title, prompt, preview_image_url, media_urls, author, source_url, has_template_args,
            COUNT(*) OVER()::int AS total_count
       FROM scraped_prompts
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${orderByFor(sort)}
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    values,
  )

  const total = result[0]?.total_count ?? 0
  const items = result.map(({ total_count: _total_count, ...item }) => item)

  return NextResponse.json({ items, total, page, pageSize })
}
