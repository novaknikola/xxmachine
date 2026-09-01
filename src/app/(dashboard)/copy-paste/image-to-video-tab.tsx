'use client'

import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Card, CardContent } from '@/components/ui/card'
import { Pagination } from '@/components/ui/pagination'
import {
  Clock, FolderOpen, Loader2, Trash2, Upload, Video, X,
} from 'lucide-react'
import { SEEDANCE_REFERENCE_COST_USD, SEEDANCE_REFERENCE_SECONDS } from '@/lib/runpod-seedance'

/** Kept in step with MAX_SEEDANCE_ITEMS in the queue submit route. */
const MAX_ITEMS = 500
const GRID_PAGE = 24

type Source = 'upload' | 'drive' | 'history'

interface PickedImage {
  id: string
  url: string
  source: Source
}

export function ImageToVideoTab() {
  const [images, setImages] = useState<PickedImage[]>([])
  const [page, setPage] = useState(1)
  const [duration, setDuration] = useState('5')
  const [resolution, setResolution] = useState<'480p' | '720p'>('720p')
  const [folderName, setFolderName] = useState('')
  const [customPrompt, setCustomPrompt] = useState('')
  const [generateAudio, setGenerateAudio] = useState(false)
  const [driveFolder, setDriveFolder] = useState('')
  const [loadingDrive, setLoadingDrive] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const add = useCallback((urls: string[], source: Source) => {
    if (!urls.length) return 0
    let added = 0
    setImages(prev => {
      const seen = new Set(prev.map(i => i.url))
      const next = [...prev]
      for (const url of urls) {
        if (seen.has(url) || next.length >= MAX_ITEMS) continue
        seen.add(url)
        next.push({ id: crypto.randomUUID(), url, source })
        added++
      }
      return next
    })
    return added
  }, [])

  async function onUpload(files: FileList | null) {
    if (!files?.length) return
    const urls: string[] = []
    for (const file of Array.from(files)) {
      try {
        const res = await fetch('/api/queue/upload-input', {
          method: 'POST',
          headers: {
            'content-type': file.type || 'image/jpeg',
            'x-file-name': encodeURIComponent(file.name),
          },
          body: file,
        })
        const data = await res.json() as { url?: string; error?: string }
        if (!res.ok || !data.url) throw new Error(data.error ?? 'Upload failed')
        urls.push(data.url)
      } catch (err) {
        toast.error(`${file.name}: ${err instanceof Error ? err.message : 'upload failed'}`)
      }
    }
    const n = add(urls, 'upload')
    if (n) toast.success(`${n} image${n === 1 ? '' : 's'} added`)
  }

  async function loadDrive() {
    const folder = driveFolder.trim()
    if (!folder) { toast.error('Paste a Drive folder link or id'); return }
    setLoadingDrive(true)
    try {
      // Accepts a full folder URL as well as a bare id — pasting the link is
      // what people actually do.
      const id = folder.match(/[-\w]{25,}/)?.[0] ?? folder
      const res = await fetch(`/api/drive/images?folderId=${encodeURIComponent(id)}`)
      const data = await res.json() as { urls?: string[]; error?: string; skipped?: number }
      if (!res.ok) throw new Error(data.error ?? 'Could not read that folder')
      const n = add(data.urls ?? [], 'drive')
      const skipped = data.skipped ? ` (${data.skipped} failed to load)` : ''
      toast.success(n ? `${n} image${n === 1 ? '' : 's'} from Drive${skipped}` : 'No new images in that folder')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Drive read failed')
    } finally {
      setLoadingDrive(false)
    }
  }

  async function loadHistory() {
    setLoadingHistory(true)
    try {
      const res = await fetch('/api/generations?limit=100')
      const data = await res.json() as { generations?: Array<{ image_urls: string[] }> }
      const urls = (data.generations ?? []).flatMap(g => g.image_urls ?? [])
      const n = add(urls, 'history')
      toast.success(n ? `${n} image${n === 1 ? '' : 's'} from history` : 'Nothing new in history')
    } catch {
      toast.error('Could not read history')
    } finally {
      setLoadingHistory(false)
    }
  }

  async function submit() {
    if (!images.length) { toast.error('Add some images first'); return }
    if (!folderName.trim()) { toast.error('Name the Drive folder these land in'); return }
    setSubmitting(true)
    try {
      const res = await fetch('/api/queue/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_type: 'seedance_i2v',
          input: {
            items: images.map(i => ({ imageUrl: i.url, source: i.source })),
            duration: Number(duration),
            resolution,
            folderName: folderName.trim(),
            customPrompt: customPrompt.trim() || undefined,
            generateAudio,
          },
        }),
      })
      const data = await res.json() as { id?: string; error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Submit failed')
      toast.success(`${images.length} video${images.length === 1 ? '' : 's'} queued`, {
        description: 'Runs in the background — you can leave this page. Stop it from the Queue.',
        action: { label: 'Open Queue', onClick: () => { window.location.href = '/captions?tab=queue' } },
      })
      setImages([])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Submit failed')
    } finally {
      setSubmitting(false)
    }
  }

  // Clamped by deriving rather than by correcting state in an effect: removing
  // images can leave the page beyond the end, and a render pass is enough to
  // fix that.
  const pageCount = Math.max(1, Math.ceil(images.length / GRID_PAGE))
  const currentPage = Math.min(page, pageCount)

  // Scales from a measured run rather than a guessed per-second rate, and the
  // real number is recorded per clip once the job runs.
  const perClip = (SEEDANCE_REFERENCE_COST_USD / SEEDANCE_REFERENCE_SECONDS) * Number(duration || 5)
  const estimate = perClip * images.length
  const pageImages = images.slice((currentPage - 1) * GRID_PAGE, currentPage * GRID_PAGE)

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-4 pt-1">
          <div className="flex items-center gap-2">
            <Video className="w-4 h-4 text-primary" />
            <p className="text-sm font-medium">Images in</p>
            <Badge variant="secondary" className="ml-auto">{images.length} / {MAX_ITEMS}</Badge>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
              onChange={e => { void onUpload(e.target.files); e.target.value = '' }} />
            <Button variant="outline" onClick={() => fileRef.current?.click()}>
              <Upload className="w-4 h-4 mr-1.5" /> Upload
            </Button>
            <Button variant="outline" onClick={() => void loadHistory()} disabled={loadingHistory}>
              {loadingHistory ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Clock className="w-4 h-4 mr-1.5" />}
              From history
            </Button>
            <Button variant="ghost" onClick={() => setImages([])} disabled={!images.length}>
              <Trash2 className="w-4 h-4 mr-1.5" /> Clear
            </Button>
          </div>

          <div className="flex gap-2">
            <Input
              value={driveFolder}
              onChange={e => setDriveFolder(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void loadDrive() }}
              placeholder="Google Drive folder link or id"
              className="text-sm"
            />
            <Button variant="outline" onClick={() => void loadDrive()} disabled={loadingDrive} className="shrink-0">
              {loadingDrive ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <FolderOpen className="w-4 h-4 mr-1.5" />}
              Load
            </Button>
          </div>

          {images.length > 0 && (
            <>
              <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2">
                {pageImages.map(img => (
                  <div key={img.id} className="relative group aspect-[9/16] rounded-lg overflow-hidden border border-border">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/proxy-image?url=${encodeURIComponent(img.url)}`} alt=""
                      className="absolute inset-0 w-full h-full object-cover" loading="lazy"
                      onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden' }} />
                    <button
                      onClick={() => setImages(prev => prev.filter(i => i.id !== img.id))}
                      className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </div>
                ))}
              </div>
              <Pagination page={currentPage} pageSize={GRID_PAGE} total={images.length} onPageChange={setPage} />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 pt-1">
          <p className="text-sm font-medium">Batch settings</p>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Clip length</Label>
              <Select value={duration} onValueChange={v => { if (v) setDuration(v) }}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['3', '4', '5', '6', '8', '10', '12'].map(s => (
                    <SelectItem key={s} value={s}>{s}s</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Resolution</Label>
              <Select value={resolution} onValueChange={v => { if (v) setResolution(v as '480p' | '720p') }}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="480p">480p</SelectItem>
                  <SelectItem value="720p">720p</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Drive folder</Label>
              <Input value={folderName} onChange={e => setFolderName(e.target.value)} placeholder="e.g. sofia_reels" />
            </div>
          </div>

          <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
            Every clip is 9:16. By default the prompt is written per image from a quick
            look at the still — who is in frame, what she is wearing, and whether it is a
            gym, mirror, portrait or ordinary shot. The movement itself is fixed per shot
            type: look at camera, slight head tilt, soft smile or wink. Set a custom
            prompt below to override this for the whole batch.
          </p>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Custom prompt (optional)</Label>
            <Textarea
              value={customPrompt}
              onChange={e => setCustomPrompt(e.target.value)}
              placeholder="Leave empty to auto-generate a prompt per image. Fill in to use this exact prompt for every clip in this batch instead."
              className="text-sm min-h-20"
              maxLength={2000}
            />
          </div>

          <label className="flex items-center gap-2 cursor-pointer w-fit">
            <input
              type="checkbox"
              checked={generateAudio}
              onChange={e => setGenerateAudio(e.target.checked)}
              className="w-4 h-4 rounded accent-primary"
            />
            <span className="text-xs text-muted-foreground">
              Generate audio — Seedance-composed ambient sound/breathing synced to the clip
            </span>
          </label>

          <div className="flex items-center justify-between gap-3 flex-wrap pt-1">
            <p className={`text-xs ${images.length > MAX_ITEMS ? 'text-destructive' : 'text-muted-foreground'}`}>
              {images.length} clip{images.length === 1 ? '' : 's'} × {duration}s ≈{' '}
              <strong className="text-foreground">${estimate.toFixed(2)}</strong>
              <span className="opacity-60"> — from a measured 5s/720p run; the real cost per clip is recorded as it goes</span>
            </p>
            <Button onClick={() => void submit()} disabled={submitting || !images.length}>
              {submitting ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Video className="w-4 h-4 mr-1.5" />}
              Generate {images.length || ''}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
