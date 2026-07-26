import { NextRequest, NextResponse } from 'next/server'
import { editImage, type SeedreamResolution } from '@/lib/wavespeed'
import { requireUser } from '@/lib/session'

const UPLOAD_URL = 'https://api.wavespeed.ai/api/v3/media/upload/binary'
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])
const SIZE_MAP: Record<string, string> = {
  '1:1': '1024*1024', '4:3': '1152*864', '3:4': '864*1152',
  '16:9': '1344*756', '9:16': '756*1344', '2:3': '768*1152', '3:2': '1152*768',
}

function wavespeedKey(): string {
  const key = process.env.WAVESPEED_API_KEY
  if (!key) throw new Error('WAVESPEED_API_KEY is not configured')
  return key
}

async function uploadToWavespeed(file: File): Promise<string> {
  const fd = new FormData()
  fd.append('file', file)

  const res = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${wavespeedKey()}` },
    body: fd,
  })
  const data = await res.json()
  if (data.code && data.code !== 200) {
    throw new Error(data.message ?? 'Upload failed')
  }
  const url = data?.data?.download_url
  if (!url) throw new Error('Upload response missing download_url')
  return url as string
}

/** Browsers often leave File.type empty for pasted/dragged images — infer from name. */
function resolveMime(file: File): string {
  if (file.type && ALLOWED_MIME.has(file.type)) return file.type
  const name = file.name.toLowerCase()
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg'
  if (name.endsWith('.png')) return 'image/png'
  if (name.endsWith('.webp')) return 'image/webp'
  // Empty type but image-looking blob from the Dataset picker — treat as jpeg.
  if (!file.type || file.type === 'application/octet-stream') return 'image/jpeg'
  return file.type
}

function assertImageFile(file: File) {
  const mime = resolveMime(file)
  if (!ALLOWED_MIME.has(mime)) {
    throw new Error('File must be a JPEG, PNG, or WebP image')
  }
}

function parseResolution(raw: unknown): SeedreamResolution {
  return raw === '2k' ? '2k' : '1k'
}

function parseSize(sizeRaw: string | undefined): string | undefined {
  if (!sizeRaw) return undefined
  return SIZE_MAP[sizeRaw] ?? (sizeRaw.includes('*') ? sizeRaw : undefined)
}

interface EditImageJsonBody {
  prompt?: string
  size?: string
  resolution?: SeedreamResolution
  imageUrls?: string[]
  imageUrl?: string
}

export async function POST(req: NextRequest) {
  const abort = AbortSignal.timeout(600_000)
  try {
    // This route is excluded from the proxy matcher (multipart uploads), so it is the only auth gate.
    const auth = await requireUser(req)
    if (auth instanceof NextResponse) return auth

    const apiKey = wavespeedKey()

    const contentType = req.headers.get('content-type') ?? ''

    // JSON body — preferred for carousel (URLs only, no multipart parsing issues).
    if (contentType.includes('application/json')) {
      const body = await req.json() as EditImageJsonBody
      const prompt = body.prompt?.trim()
      if (!prompt) return NextResponse.json({ error: 'Missing prompt' }, { status: 400 })

      const imageUrls = [
        ...(body.imageUrls ?? []),
        ...(body.imageUrl ? [body.imageUrl] : []),
      ].map(u => u.trim()).filter(Boolean)

      if (!imageUrls.length) {
        return NextResponse.json({ error: 'Missing imageUrls' }, { status: 400 })
      }

      const urls = await editImage({
        imageUrls,
        prompt,
        size: parseSize(body.size),
        resolution: parseResolution(body.resolution),
        apiKey,
        signal: abort,
      })

      return NextResponse.json({ urls, inputUrl: imageUrls[0] })
    }

    let form: FormData
    try {
      form = await req.formData()
    } catch {
      return NextResponse.json(
        { error: 'Failed to parse body as FormData — use JSON with imageUrls for carousel edits' },
        { status: 400 },
      )
    }

    const prompt = (form.get('prompt') as string | null)?.trim()
    const size = parseSize((form.get('size') as string | null) ?? undefined)
    const saveHistory = form.get('saveHistory') === 'true'
    const historyPrompt = (form.get('historyPrompt') as string | null) ?? prompt ?? ''
    const resolution = parseResolution((form.get('resolution') as string | null)?.trim())

    if (!prompt) return NextResponse.json({ error: 'Missing prompt' }, { status: 400 })

    const directUrl = (form.get('imageUrl') as string | null)?.trim()
    const referenceUrlList = form
      .getAll('referenceUrls[]')
      .map(v => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean)
    const referenceFiles = form.getAll('referenceFiles[]') as File[]

    let imageUrls: string[]
    try {
      if (directUrl) {
        imageUrls = [directUrl, ...referenceUrlList]
        if (referenceFiles.length) {
          for (const f of referenceFiles) assertImageFile(f)
          const uploaded = await Promise.all(referenceFiles.map(f => uploadToWavespeed(f)))
          imageUrls.push(...uploaded)
        }
      } else {
        const singleFile = form.get('file') as File | null
        const multiFiles = form.getAll('files[]') as File[]
        const allFiles = multiFiles.length > 0 ? multiFiles : singleFile ? [singleFile] : []

        if (!allFiles.length) return NextResponse.json({ error: 'Missing file or imageUrl' }, { status: 400 })
        for (const f of allFiles) assertImageFile(f)
        imageUrls = await Promise.all(allFiles.map(f => uploadToWavespeed(f)))
        if (referenceUrlList.length) imageUrls.push(...referenceUrlList)
      }
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Invalid image file' },
        { status: 400 },
      )
    }

    if (!imageUrls.length) {
      return NextResponse.json({ error: 'No input images' }, { status: 400 })
    }

    const urls = await editImage({ imageUrls, prompt, size, resolution, apiKey, signal: abort })

    if (saveHistory && urls.length) {
      fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'wan_edit',
          prompt: historyPrompt,
          dimension: size ?? '9:16',
          batch: 1,
          wavespeedUrls: urls,
          userId: auth.id,
        }),
      }).catch(e => console.error('[edit-image] history save failed:', e))
    }

    return NextResponse.json({ urls, inputUrl: imageUrls[0] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
