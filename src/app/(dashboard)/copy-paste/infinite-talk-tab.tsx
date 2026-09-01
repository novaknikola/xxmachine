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
  Clock, FileText, FolderOpen, Loader2, MessagesSquare, Trash2, Upload, X,
} from 'lucide-react'

/** Kept in step with MAX_SEEDANCE_ITEMS in the queue submit route. */
const MAX_ITEMS = 500
const GRID_PAGE = 24

type Source = 'upload' | 'drive' | 'history'

interface PickedImage {
  id: string
  url: string
  source: Source
}

/**
 * One spoken line per row. A single-column CSV is just lines, but a file
 * exported from a spreadsheet still arrives quoted and may carry a header, so
 * both are handled rather than telling the user to clean the file first.
 */
function parseCsvLines(raw: string): string[] {
  const out: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    let s = line.trim()
    if (!s) continue
    // Take the first column when a row has more, so an extra column someone
    // left in does not end up being read aloud.
    if (s.includes(',') || s.startsWith('"')) {
      const m = s.match(/^\s*"((?:[^"]|"")*)"/)
      s = m ? m[1].replace(/""/g, '"') : s.split(',')[0]
      s = s.trim()
    }
    if (!s) continue
    // A lone "text"/"spoken"/"line" first row is a header, not a line to say.
    if (out.length === 0 && /^(text|spoken|line|script|caption)$/i.test(s)) continue
    out.push(s)
  }
  return out
}

export function InfiniteTalkTab() {
  const [images, setImages] = useState<PickedImage[]>([])
  const [page, setPage] = useState(1)
  const [csvRaw, setCsvRaw] = useState('')
  const [voiceId, setVoiceId] = useState('')
  const [style, setStyle] = useState('')
  const [prompt, setPrompt] = useState('a woman speaking to the camera')
  const [resolution, setResolution] = useState<'480p' | '720p'>('480p')
  const [folderName, setFolderName] = useState('')
  const [driveFolder, setDriveFolder] = useState('')
  const [loadingDrive, setLoadingDrive] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const csvRef = useRef<HTMLInputElement>(null)

  const lines = parseCsvLines(csvRaw)

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
      const id = folder.match(/[-\w]{25,}/)?.[0] ?? folder
      const res = await fetch(`/api/drive/images?folderId=${encodeURIComponent(id)}`)
      const data = await res.json() as { urls?: string[]; error?: string; skipped?: number }
      if (!res.ok) throw new Error(data.error ?? 'Could not read that folder')
      const n = add(data.urls ?? [], 'drive')
      const skipped = data.skipped ? ` (${data.skipped} failed to load)` : ''
      toast.success(n ? `${n} image${n === 1 ? '' : 's'} from Drive${skipped}` : 'No new images there')
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
      const n = add((data.generations ?? []).flatMap(g => g.image_urls ?? []), 'history')
      toast.success(n ? `${n} image${n === 1 ? '' : 's'} from history` : 'Nothing new in history')
    } catch {
      toast.error('Could not read history')
    } finally {
      setLoadingHistory(false)
    }
  }

  function onCsvFile(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setCsvRaw(String(reader.result ?? ''))
      toast.success(`${file.name} loaded`)
    }
    reader.onerror = () => toast.error('Could not read that file')
    reader.readAsText(file)
  }

  async function submit() {
    if (!images.length && !lines.length) { toast.error('Add images and a CSV'); return }
    if (!voiceId.trim()) { toast.error('Fish Audio voice id required'); return }
    if (!folderName.trim()) { toast.error('Name the Drive folder these land in'); return }

    // Zipped by position; the longer side keeps going with the missing half
    // null, and the worker reports those as failures.
    const count = Math.max(images.length, lines.length)
    const items = Array.from({ length: count }, (_, i) => ({
      imageUrl: images[i]?.url ?? null,
      text: lines[i] ?? null,
      source: images[i]?.source ?? null,
    }))

    setSubmitting(true)
    try {
      const res = await fetch('/api/queue/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_type: 'infinite_talk',
          input: {
            items,
            voiceId: voiceId.trim(),
            style: style.trim() || null,
            resolution,
            prompt: prompt.trim(),
            folderName: folderName.trim(),
          },
        }),
      })
      const data = await res.json() as { id?: string; error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Submit failed')

      const paired = Math.min(images.length, lines.length)
      toast.success(`${paired} clip${paired === 1 ? '' : 's'} queued`, {
        description: count > paired
          ? `${count - paired} unmatched will come back as failed`
          : 'Runs in the background — stop it from the Queue.',
        action: { label: 'Open Queue', onClick: () => { window.location.href = '/captions?tab=queue' } },
      })
      setImages([])
      setCsvRaw('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Submit failed')
    } finally {
      setSubmitting(false)
    }
  }

  const pageCount = Math.max(1, Math.ceil(images.length / GRID_PAGE))
  const currentPage = Math.min(page, pageCount)
  const pageImages = images.slice((currentPage - 1) * GRID_PAGE, currentPage * GRID_PAGE)
  const paired = Math.min(images.length, lines.length)
  const unmatched = Math.max(images.length, lines.length) - paired

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-4 pt-1">
          <div className="flex items-center gap-2">
            <MessagesSquare className="w-4 h-4 text-primary" />
            <p className="text-sm font-medium">Images</p>
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
            <Input value={driveFolder} onChange={e => setDriveFolder(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void loadDrive() }}
              placeholder="Google Drive folder link or id" className="text-sm" />
            <Button variant="outline" onClick={() => void loadDrive()} disabled={loadingDrive} className="shrink-0">
              {loadingDrive ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <FolderOpen className="w-4 h-4 mr-1.5" />}
              Load
            </Button>
          </div>

          {images.length > 0 && (
            <>
              <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2">
                {pageImages.map((img, idx) => {
                  const lineIndex = (currentPage - 1) * GRID_PAGE + idx
                  const hasLine = lineIndex < lines.length
                  return (
                    <div key={img.id}
                      className={`relative group aspect-[9/16] rounded-lg overflow-hidden border ${hasLine ? 'border-border' : 'border-destructive/60'}`}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/api/proxy-image?url=${encodeURIComponent(img.url)}`} alt=""
                        className="absolute inset-0 w-full h-full object-cover" loading="lazy"
                        onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden' }} />
                      <span className="absolute bottom-1 left-1 px-1 rounded bg-black/70 text-[9px] text-white">
                        {lineIndex + 1}
                      </span>
                      <button onClick={() => setImages(prev => prev.filter(i => i.id !== img.id))}
                        className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  )
                })}
              </div>
              <Pagination page={currentPage} pageSize={GRID_PAGE} total={images.length} onPageChange={setPage} />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 pt-1">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-primary" />
            <p className="text-sm font-medium">Script</p>
            <Badge variant="secondary" className="ml-auto">{lines.length} line{lines.length === 1 ? '' : 's'}</Badge>
          </div>

          <input ref={csvRef} type="file" accept=".csv,text/csv,text/plain" className="hidden"
            onChange={e => { onCsvFile(e.target.files); e.target.value = '' }} />
          <Button variant="outline" size="sm" onClick={() => csvRef.current?.click()}>
            <Upload className="w-3.5 h-3.5 mr-1.5" /> Load CSV
          </Button>

          <Textarea value={csvRaw} onChange={e => setCsvRaw(e.target.value)} rows={7}
            placeholder={'One spoken line per row.\nHey guys, welcome back\nToday I want to show you something'}
            className="font-mono text-xs resize-none" />
          <p className="text-[10px] text-muted-foreground/60">
            Line 1 goes with image 1, line 2 with image 2, and so on. A header row and
            extra columns are ignored — only the first column is spoken.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 pt-1">
          <p className="text-sm font-medium">Voice and output</p>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Fish Audio voice id</Label>
              <Input value={voiceId} onChange={e => setVoiceId(e.target.value)} placeholder="reference id" className="font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Delivery hint <span className="opacity-60">(optional)</span></Label>
              <Input value={style} onChange={e => setStyle(e.target.value)} placeholder="e.g. warm, upbeat" />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
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
            <div className="space-y-1.5 sm:col-span-2">
              <Label className="text-xs text-muted-foreground">Drive folder</Label>
              <Input value={folderName} onChange={e => setFolderName(e.target.value)} placeholder="e.g. sofia_talks" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Scene direction</Label>
            <Input value={prompt} onChange={e => setPrompt(e.target.value)} />
            <p className="text-[10px] text-muted-foreground/60">
              Kept short on purpose — the audio drives the performance, this only sets the scene.
            </p>
          </div>

          <div className="flex items-center justify-between gap-3 flex-wrap pt-1">
            <p className="text-xs text-muted-foreground">
              <strong className="text-foreground">{paired}</strong> clip{paired === 1 ? '' : 's'} will render
              {unmatched > 0 && (
                <span className="text-amber-400/90">
                  {' '}· {unmatched} unmatched {images.length > lines.length ? 'image' : 'line'}
                  {unmatched === 1 ? '' : 's'} will come back as failed
                </span>
              )}
            </p>
            <Button onClick={() => void submit()} disabled={submitting || !paired}>
              {submitting ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <MessagesSquare className="w-4 h-4 mr-1.5" />}
              Generate {paired || ''}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
