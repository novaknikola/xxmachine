'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { charactersStore, generationsStore } from '@/lib/store'
import { Character, GenerationRow, DIMENSIONS } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import JSZip from 'jszip'
import {
  ImageIcon, Loader2, ExternalLink, Trash2, Clock, Layers, Maximize2,
  CheckCircle2, XCircle, Copy, Download, X, ChevronLeft, ChevronRight,
  CalendarClock, Plus, Shuffle, ChevronDown, Film, BookOpen,
} from 'lucide-react'
import { ScheduleModal } from '@/components/schedule-modal'
import { PromptLibraryModal } from '@/components/prompt-library-modal'
import {
  applyText, renderToBlob, renderAugmented, randomTransform,
  TEXT_STYLE_OPTIONS, POSITION_OPTIONS, TextPosition, TextStyle,
} from '@/lib/canvas-utils'

const BATCH_OPTIONS = [1, 2, 3, 4, 5]
const PAGE_SIZE = 10
const DEFAULT_FONT_PX = 72

type SlideStatus = 'idle' | 'generating' | 'done' | 'error'

interface Slide {
  id: string
  index: number
  status: SlideStatus
  imageUrl: string
  caption: string
  position: TextPosition
  error?: string
}

async function downloadAsZip(urls: string[], filename = 'xxmachine-images.zip') {
  const JSZipMod = (await import('jszip')).default
  const zip = new JSZipMod()
  await Promise.all(
    urls.map(async (url, i) => {
      const blob = await fetch(url).then(r => r.blob())
      const ext = url.split('.').pop()?.split('?')[0] ?? 'jpg'
      zip.file(`image-${String(i + 1).padStart(3, '0')}.${ext}`, blob)
    }),
  )
  const content = await zip.generateAsync({ type: 'blob' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(content)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

function StatusBadge({ status }: { status: GenerationRow['status'] }) {
  const map = {
    idle:       { label: 'Waiting',       color: 'secondary'   as const },
    processing: { label: 'Generating...', color: 'default'     as const },
    done:       { label: 'Done',          color: 'secondary'   as const },
    error:      { label: 'Error',         color: 'destructive' as const },
  }
  const { label, color } = map[status]
  return (
    <Badge variant={color} className="text-xs">
      {status === 'processing' && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
      {status === 'done'       && <CheckCircle2 className="w-3 h-3 mr-1 text-green-400" />}
      {status === 'error'      && <XCircle className="w-3 h-3 mr-1" />}
      {label}
    </Badge>
  )
}

function GenCard({ row, onDelete, onSchedule, onAddToCarousel }: {
  row: GenerationRow
  onDelete: () => void
  onSchedule: (imageUrl: string) => void
  onAddToCarousel: (imageUrl: string) => void
}) {
  const cols = row.batch >= 3 ? 3 : row.batch === 2 ? 2 : 1
  return (
    <div className="group relative rounded-xl border border-border/50 bg-card overflow-hidden flex flex-col">
      <div className="grid gap-0.5 bg-secondary/30" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {row.status === 'processing' &&
          Array.from({ length: row.batch }).map((_, i) => (
            <div key={i} className="aspect-square bg-secondary animate-pulse" />
          ))
        }
        {row.status === 'error' && (
          <div className="aspect-square bg-destructive/10 flex items-center justify-center col-span-full">
            <XCircle className="w-5 h-5 text-destructive/50" />
          </div>
        )}
        {row.outputUrls.map((url, i) => (
          <div key={i} className="relative aspect-square overflow-hidden group/img">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt="" className="w-full h-full object-cover transition-opacity group-hover/img:opacity-70" />
            <div className="absolute inset-0 flex items-center justify-center gap-2 opacity-0 group-hover/img:opacity-100 transition-opacity bg-black/30">
              <a href={url} target="_blank" rel="noopener noreferrer"
                className="w-7 h-7 rounded-full bg-black/60 flex items-center justify-center hover:bg-black/80 transition-colors"
                onClick={e => e.stopPropagation()}>
                <ExternalLink className="w-3 h-3 text-white" />
              </a>
              {row.status === 'done' && (
                <>
                  <button className="w-7 h-7 rounded-full bg-primary/80 flex items-center justify-center hover:bg-primary transition-colors"
                    onClick={() => onSchedule(url)} title="Schedule this image">
                    <CalendarClock className="w-3 h-3 text-white" />
                  </button>
                  <button className="w-7 h-7 rounded-full bg-violet-600/80 flex items-center justify-center hover:bg-violet-600 transition-colors"
                    onClick={() => onAddToCarousel(url)} title="Add to carousel">
                    <Plus className="w-3 h-3 text-white" />
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="px-4 py-3 flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs font-semibold text-primary truncate">{row.characterName}</span>
          <StatusBadge status={row.status} />
          <Badge variant="outline" className="text-xs h-4 px-1 border-border/50 ml-auto shrink-0">{row.dimension}</Badge>
        </div>
        <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">{row.prompt}</p>
        <div className="flex items-center gap-1 text-xs text-muted-foreground/50">
          <Clock className="w-2.5 h-2.5" />
          {new Date(row.createdAt).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })}
        </div>
      </div>
      <button onClick={onDelete}
        className="absolute top-2 right-2 w-6 h-6 rounded-full bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center hover:bg-destructive">
        <Trash2 className="w-3 h-3" />
      </button>
    </div>
  )
}

function Pagination({ page, pageCount, onChange }: { page: number; pageCount: number; onChange: (p: number) => void }) {
  if (pageCount <= 1) return null
  const pages: (number | '…')[] = []
  if (pageCount <= 7) {
    for (let i = 1; i <= pageCount; i++) pages.push(i)
  } else {
    pages.push(1)
    if (page > 3) pages.push('…')
    for (let i = Math.max(2, page - 1); i <= Math.min(pageCount - 1, page + 1); i++) pages.push(i)
    if (page < pageCount - 2) pages.push('…')
    pages.push(pageCount)
  }
  return (
    <div className="flex items-center justify-center gap-1 mt-4">
      <button disabled={page === 1} onClick={() => onChange(page - 1)}
        className="w-7 h-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed">
        <ChevronLeft className="w-3.5 h-3.5" />
      </button>
      {pages.map((p, i) =>
        p === '…' ? (
          <span key={`e${i}`} className="w-7 h-7 flex items-center justify-center text-xs text-muted-foreground">…</span>
        ) : (
          <button key={p} onClick={() => onChange(p as number)}
            className={`w-7 h-7 flex items-center justify-center rounded-md text-xs font-medium transition-colors ${p === page ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'}`}>
            {p}
          </button>
        ),
      )}
      <button disabled={page === pageCount} onClick={() => onChange(page + 1)}
        className="w-7 h-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed">
        <ChevronRight className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

function DownloadPanel({ history, onClose }: { history: GenerationRow[]; onClose: () => void }) {
  const doneRows = history.filter(r => r.status === 'done' && r.outputUrls.length > 0)
  const allUrls = doneRows.flatMap(r => r.outputUrls)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [zipping, setZipping] = useState(false)

  function toggleAll() {
    if (selected.size === allUrls.length) setSelected(new Set())
    else setSelected(new Set(allUrls))
  }

  async function handleDownload(urls: string[]) {
    if (urls.length === 0) { toast.error('No images selected'); return }
    setZipping(true)
    try { await downloadAsZip(urls); toast.success(`Downloading ${urls.length} images…`) }
    catch { toast.error('ZIP download failed') }
    finally { setZipping(false) }
  }

  return (
    <div className="absolute inset-0 bg-background z-10 flex flex-col">
      <div className="flex items-center gap-3 px-6 py-4 border-b border-border shrink-0">
        <Download className="w-4 h-4 text-primary" />
        <h2 className="font-semibold text-base flex-1">Download history</h2>
        <button onClick={toggleAll} className="text-xs text-muted-foreground hover:text-foreground">
          {selected.size === allUrls.length ? 'Deselect all' : 'Select all'}
        </button>
        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={selected.size === 0 || zipping}
          onClick={() => handleDownload([...selected])}>
          {zipping ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Download className="w-3 h-3 mr-1" />}
          Download selected ({selected.size})
        </Button>
        <Button size="sm" className="h-7 text-xs" disabled={allUrls.length === 0 || zipping}
          onClick={() => handleDownload(allUrls)}>
          {zipping ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Download className="w-3 h-3 mr-1" />}
          Download all ZIP ({allUrls.length})
        </Button>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground ml-1"><X className="w-4 h-4" /></button>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {doneRows.length === 0 && <p className="text-sm text-muted-foreground text-center py-16">No completed generations yet.</p>}
        {doneRows.map(row => (
          <div key={row.id}>
            <p className="text-xs text-muted-foreground mb-2">
              <span className="font-semibold text-foreground">{row.characterName}</span>
              {' · '}{new Date(row.createdAt).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })}
              {' · '}<span className="italic">{row.prompt.slice(0, 60)}{row.prompt.length > 60 ? '…' : ''}</span>
            </p>
            <div className="space-y-1.5">
              {row.outputUrls.map((url, i) => (
                <label key={i} className="flex items-center gap-3 p-2 rounded-lg hover:bg-secondary/50 cursor-pointer">
                  <input type="checkbox" checked={selected.has(url)} onChange={() => {
                    setSelected(prev => { const n = new Set(prev); n.has(url) ? n.delete(url) : n.add(url); return n })
                  }} className="w-4 h-4 rounded accent-primary" />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={url} alt="" className="w-10 h-10 rounded object-cover border border-border/50 shrink-0" />
                  <span className="text-xs text-muted-foreground truncate flex-1">{url}</span>
                  <a href={url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>
                    <ExternalLink className="w-3 h-3 text-muted-foreground hover:text-primary" />
                  </a>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function SlideCard({ slide, style, fontSizePx, onCaptionChange, onPositionChange, onDelete }: {
  slide: Slide; style: TextStyle; fontSizePx: number
  onCaptionChange: (id: string, val: string) => void
  onPositionChange: (id: string, val: TextPosition) => void
  onDelete: (id: string) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (slide.status !== 'done' || !slide.imageUrl || !canvasRef.current) return
    const canvas = canvasRef.current
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      applyText(ctx, canvas.width, canvas.height, slide.caption, slide.position, style, fontSizePx)
    }
    img.src = slide.imageUrl
  }, [slide.status, slide.imageUrl, slide.caption, slide.position, style, fontSizePx])

  return (
    <div className="group relative rounded-xl border border-border/50 bg-card overflow-hidden flex flex-col shrink-0 w-36">
      <div className="relative w-full aspect-[9/16] bg-secondary/30 overflow-hidden">
        {slide.status === 'done' ? (
          <div className="relative group/img w-full h-full">
            <canvas ref={canvasRef} className="w-full h-full object-cover" />
            <div className="absolute top-1.5 left-1.5 z-10">
              <CheckCircle2 className="w-3.5 h-3.5 text-green-400 drop-shadow" />
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full">
            <ImageIcon className="w-8 h-8 opacity-20 text-muted-foreground" />
          </div>
        )}
        <div className="absolute top-1.5 right-1.5 bg-black/60 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full z-10">
          {slide.index + 1}
        </div>
      </div>
      <div className="px-2 py-2 flex flex-col gap-1.5">
        <Textarea placeholder="Caption..." value={slide.caption}
          onChange={e => onCaptionChange(slide.id, e.target.value)}
          rows={2} className="text-xs resize-none" />
        <Select value={slide.position} onValueChange={v => onPositionChange(slide.id, v as TextPosition)}>
          <SelectTrigger className="h-6 text-[10px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {POSITION_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <button onClick={() => onDelete(slide.id)}
        className="absolute top-8 right-1 w-5 h-5 rounded-full bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center hover:bg-destructive z-20">
        <Trash2 className="w-2.5 h-2.5" />
      </button>
    </div>
  )
}

function AugmentPanel({ slides, textStyle, fontSizePx, seriesName }: {
  slides: Slide[]; textStyle: TextStyle; fontSizePx: number; seriesName: string
}) {
  const [open, setOpen] = useState(false)
  const [perSlide, setPerSlide] = useState(20)
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(0)

  const doneSlides = slides.filter(s => s.status === 'done' && s.imageUrl)
  const total = doneSlides.length * perSlide

  async function run() {
    if (!doneSlides.length) return
    setRunning(true); setDone(0)
    const zip = new JSZip()
    const base = seriesName.trim().replace(/\s+/g, '_').toLowerCase() || 'carousel'
    let idx = 0; let failed = 0
    for (const slide of doneSlides) {
      for (let v = 0; v < perSlide; v++) {
        try {
          const blob = await renderAugmented(slide.imageUrl, slide.caption, slide.position, textStyle, fontSizePx, randomTransform())
          zip.file(`${base}_aug_${String(++idx).padStart(4, '0')}.jpg`, blob)
        } catch { failed++ }
        setDone(idx + failed)
      }
    }
    setRunning(false)
    if (idx === 0) { toast.error('All failed'); return }
    if (failed > 0) toast.warning(`${failed} failed, ${idx} OK`)
    const content = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(content)
    a.download = `${base}_augmented.zip`
    a.click()
    URL.revokeObjectURL(a.href)
    toast.success(`Downloaded ${idx} augmented images`)
  }

  if (!doneSlides.length) return null
  const progress = total > 0 ? Math.round((done / total) * 100) : 0

  return (
    <div className="border-t border-border/50">
      <button onClick={() => setOpen(p => !p)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
        <Shuffle className="w-3.5 h-3.5 shrink-0 text-primary" />
        <span className="text-foreground font-semibold">Augment & Multiply</span>
        <ChevronDown className={`w-3.5 h-3.5 ml-auto transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-border/50 px-4 pb-4 pt-3 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium">Variations per slide</p>
            <p className="text-xs text-muted-foreground">→ {total} total</p>
          </div>
          <div className="flex items-center gap-2">
            <Input type="number" min={1} max={500} value={perSlide}
              onChange={e => setPerSlide(Math.max(1, Math.min(500, Number(e.target.value) || 20)))}
              className="h-8 text-sm" />
            <div className="flex gap-1">
              {[10, 20, 50].map(n => (
                <button key={n} onClick={() => setPerSlide(n)}
                  className={`px-2 py-1 rounded text-xs border transition-colors ${perSlide === n ? 'border-primary bg-primary/10' : 'border-border text-muted-foreground hover:border-primary/50'}`}>{n}</button>
              ))}
            </div>
          </div>
          <Button className="w-full" onClick={run} disabled={running}>
            {running
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{done}/{total} rendering...</>
              : <><Shuffle className="w-4 h-4 mr-2" />Generate {total} variations</>}
          </Button>
          {running && (
            <div className="w-full bg-secondary rounded-full h-1.5">
              <div className="bg-primary h-1.5 rounded-full transition-all" style={{ width: `${progress}%` }} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function GenerateTab() {
  const { user } = useAuth()
  const router = useRouter()
  const [scheduleModal, setScheduleModal] = useState<{ urls: string[]; characterId: string; characterName: string } | null>(null)
  const [showLibrary, setShowLibrary] = useState(false)

  const [characters, setCharacters] = useState<Character[]>([])
  const [history, setHistory] = useState<GenerationRow[]>([])
  const [page, setPage] = useState(1)
  const [showDownload, setShowDownload] = useState(false)
  const [characterId, setCharacterId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [dimension, setDimension] = useState('9:16')
  const [batch, setBatch] = useState(1)
  const [loading, setLoading] = useState(false)

  const [slides, setSlides] = useState<Slide[]>([])
  const [seriesName, setSeriesName] = useState('')
  const [textStyle, setTextStyle] = useState<TextStyle>('white-black')
  const [fontSizePx, setFontSizePx] = useState(DEFAULT_FONT_PX)
  const [defaultPosition, setDefaultPosition] = useState<TextPosition>('bottom')
  const [downloading, setDownloading] = useState(false)

  const refreshHistory = useCallback(() => {
    const rows = user?.role === 'admin'
      ? generationsStore.getAll()
      : generationsStore.getByUser(user?.id ?? '')
    setHistory(rows)
    setPage(1)
  }, [user])

  useEffect(() => {
    let cancelled = false

    async function loadCharacters() {
      try {
        const res = await fetch('/api/characters', { cache: 'no-store' })
        const chars = await res.json()
        if (!res.ok) throw new Error(chars.error || 'Failed to load characters')
        if (cancelled) return

        setCharacters(chars)
        setCharacterId(prev => prev || (chars.length > 0 ? chars[0].id : ''))
      } catch (err) {
        console.error('[GenerateTab] failed to load characters from API', err)
        const fallback = charactersStore.getAll()
        if (!cancelled) {
          setCharacters(fallback)
          setCharacterId(prev => prev || (fallback.length > 0 ? fallback[0].id : ''))
        }
      } finally {
        if (!cancelled) refreshHistory()
      }
    }

    loadCharacters()

    return () => {
      cancelled = true
    }
  }, [user, refreshHistory])

  async function handleGenerate() {
    if (!prompt.trim()) { toast.error('Enter a prompt'); return }
    if (!characterId) { toast.error('Select a character'); return }
    const character = characters.find(c => c.id === characterId)
    if (!character) return

    const row: GenerationRow = {
      id: crypto.randomUUID(),
      kind: 'text2img',
      characterId,
      characterName: character.name,
      prompt: prompt.trim(),
      dimension,
      batch,
      status: 'processing',
      outputUrls: [],
      createdAt: new Date().toISOString(),
      userId: user?.id ?? '',
    }

    generationsStore.add(row)
    refreshHistory()
    setLoading(true)

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim(), dimension, batch, loraUrl: character.loraUrl, loraScale: character.loraScale, characterId, characterName: character.name, userId: user?.id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'API error')
      generationsStore.update(row.id, { status: 'done', outputUrls: data.urls })
      toast.success(`Generated ${data.urls.length} images!`)
    } catch (err) {
      generationsStore.update(row.id, { status: 'error' })
      toast.error(err instanceof Error ? err.message : 'Generation error')
    } finally {
      setLoading(false)
      refreshHistory()
    }
  }

  function deleteRow(id: string) {
    generationsStore.save(generationsStore.getAll().filter(r => r.id !== id))
    refreshHistory()
  }

  const updateSlide = useCallback((id: string, patch: Partial<Slide>) => {
    setSlides(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s))
  }, [])

  function addToCarousel(imageUrl: string) {
    setSlides(prev => {
      const index = prev.length
      return [...prev, { id: crypto.randomUUID(), index, status: 'done', imageUrl, caption: '', position: defaultPosition }]
    })
    toast.success('Added to carousel')
  }

  async function downloadCarouselZip() {
    const doneSlides = slides.filter(s => s.status === 'done' && s.imageUrl)
    if (!doneSlides.length) return
    setDownloading(true)
    try {
      const zip = new JSZip()
      const base = seriesName.trim().replace(/\s+/g, '_').toLowerCase() || 'carousel'
      await Promise.all(doneSlides.map(async slide => {
        const blob = await renderToBlob(slide.imageUrl, slide.caption, slide.position, textStyle, fontSizePx)
        zip.file(`${base}_${String(slide.index + 1).padStart(2, '0')}.jpg`, blob)
      }))
      const content = await zip.generateAsync({ type: 'blob' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(content)
      a.download = `${base}.zip`
      a.click()
      URL.revokeObjectURL(a.href)
    } catch { toast.error('Download failed') }
    finally { setDownloading(false) }
  }

  const selectedChar = characters.find(c => c.id === characterId)
  const pageCount = Math.ceil(history.length / PAGE_SIZE)
  const pageRows = history.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const carouselDone = slides.filter(s => s.status === 'done').length

  return (
    <>
    <div className="flex h-full min-h-0">
      {/* Left panel */}
      <div className="w-80 shrink-0 border-r border-border bg-card flex flex-col">
        <div className="px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <ImageIcon className="w-4 h-4 text-primary" />
            <h1 className="font-semibold text-base">Image Generator</h1>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Character</Label>
            <Select value={characterId} onValueChange={(v: string | null) => { if (v) setCharacterId(v) }}>
              <SelectTrigger className="bg-input border-border"><SelectValue placeholder="Select character" /></SelectTrigger>
              <SelectContent>
                {characters.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {selectedChar && (
              <div className="mt-2 p-2.5 rounded-lg bg-secondary/50 border border-border/50">
                <p className="text-xs text-muted-foreground line-clamp-3">{selectedChar.story || 'No character description.'}</p>
              </div>
            )}
          </div>

          <Separator className="bg-border/50" />

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Prompt</Label>
            <Textarea placeholder="Describe the scene, outfit, pose..."
              value={prompt} onChange={e => setPrompt(e.target.value)}
              rows={4} className="bg-input border-border resize-none text-sm" />
            {selectedChar && (
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" className="flex-1 text-xs text-muted-foreground h-7"
                  onClick={() => { setPrompt(selectedChar.basePromptStyle); toast.success('Base prompt copied') }}>
                  <Copy className="w-3 h-3 mr-1.5" />Copy base prompt
                </Button>
                <Button variant="ghost" size="sm" className="flex-1 text-xs text-muted-foreground h-7"
                  onClick={() => setShowLibrary(true)}>
                  <BookOpen className="w-3 h-3 mr-1.5" />Library
                </Button>
              </div>
            )}
          </div>

          <Separator className="bg-border/50" />

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">
              <Maximize2 className="w-3 h-3 inline mr-1.5" />Dimension
            </Label>
            <div className="grid grid-cols-4 gap-1.5">
              {Object.keys(DIMENSIONS).map(dim => (
                <button key={dim} onClick={() => setDimension(dim)}
                  className={`py-1.5 rounded-md text-xs font-medium border transition-colors ${dimension === dim ? 'bg-primary text-primary-foreground border-primary' : 'bg-secondary border-border text-muted-foreground hover:text-foreground hover:border-border/80'}`}>
                  {dim}
                </button>
              ))}
            </div>
          </div>

          <Separator className="bg-border/50" />

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">
              <Layers className="w-3 h-3 inline mr-1.5" />Batch ({batch} {batch === 1 ? 'image' : 'images'})
            </Label>
            <div className="flex gap-1.5">
              {BATCH_OPTIONS.map(n => (
                <button key={n} onClick={() => setBatch(n)}
                  className={`flex-1 py-1.5 rounded-md text-sm font-semibold border transition-colors ${batch === n ? 'bg-primary text-primary-foreground border-primary' : 'bg-secondary border-border text-muted-foreground hover:text-foreground'}`}>
                  {n}
                </button>
              ))}
            </div>
          </div>

          <Separator className="bg-border/50" />

          <div className="space-y-3">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Film className="w-3 h-3" />Carousel
            </Label>
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">Series name</p>
              <Input placeholder="beach_vacation" value={seriesName} onChange={e => setSeriesName(e.target.value)} className="h-8 text-sm" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Text style</p>
                <Select value={textStyle} onValueChange={v => setTextStyle(v as TextStyle)}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TEXT_STYLE_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Default pos.</p>
                <Select value={defaultPosition} onValueChange={v => setDefaultPosition(v as TextPosition)}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {POSITION_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Font size (px)</p>
              <Input type="number" min={12} max={300} value={fontSizePx}
                onChange={e => setFontSizePx(Math.max(12, Math.min(300, Number(e.target.value) || DEFAULT_FONT_PX)))}
                className="h-8 text-sm w-24" />
            </div>
            {carouselDone > 0 && (
              <Button variant="outline" className="w-full border-green-500/40 text-green-400 hover:bg-green-500/10 h-8 text-xs"
                onClick={downloadCarouselZip} disabled={downloading}>
                {downloading
                  ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Exporting...</>
                  : <><Download className="w-3 h-3 mr-1.5" />Download ZIP ({carouselDone} slides)</>}
              </Button>
            )}
            {slides.length > 0 && (
              <button onClick={() => setSlides([])} className="w-full text-xs text-muted-foreground hover:text-destructive transition-colors py-0.5">
                Clear carousel
              </button>
            )}
          </div>
        </div>

        <div className="px-5 py-4 border-t border-border">
          <Button className="w-full font-semibold" size="lg" onClick={handleGenerate} disabled={loading}>
            {loading
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Generating...</>
              : <><ImageIcon className="w-4 h-4 mr-2" />Generate</>}
          </Button>
        </div>
      </div>

      {/* Right panel */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <div className="flex-1 overflow-y-auto p-6 relative min-h-0">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-semibold text-base text-foreground">Generation history</h2>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-xs">{history.length} rows</Badge>
              <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={() => setShowDownload(true)}>
                <Download className="w-3 h-3" />Download
              </Button>
            </div>
          </div>

          {history.length === 0 && (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <ImageIcon className="w-10 h-10 text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground text-sm">No generations yet.</p>
              <p className="text-muted-foreground/60 text-xs mt-1">Create your first image on the left.</p>
            </div>
          )}

          <div className="grid grid-cols-3 gap-3 xl:grid-cols-4">
            {pageRows.map(row => (
              <GenCard key={row.id} row={row}
                onDelete={() => deleteRow(row.id)}
                onSchedule={url => setScheduleModal({ urls: [url], characterId: row.characterId, characterName: row.characterName })}
                onAddToCarousel={addToCarousel}
              />
            ))}
          </div>

          <Pagination page={page} pageCount={pageCount} onChange={setPage} />

          {showDownload && <DownloadPanel history={history} onClose={() => setShowDownload(false)} />}
        </div>

        <div className="border-t border-border bg-sidebar/20 shrink-0">
          <div className="flex items-center gap-3 px-6 py-3 border-b border-border/50">
            <Film className="w-4 h-4 text-violet-400" />
            <p className="text-sm font-semibold">Carousel</p>
            {slides.length > 0 && (
              <Badge variant="secondary" className="text-xs">{carouselDone}/{slides.length} slides</Badge>
            )}
            <p className="text-xs text-muted-foreground ml-1">
              {slides.length === 0 ? 'Hover any image above → click + to add to carousel' : ''}
            </p>
          </div>
          {slides.length === 0 ? (
            <div className="flex items-center justify-center h-24 text-muted-foreground/40">
              <p className="text-xs">No slides yet — hover images above and click the violet + button</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <div className="flex gap-3 px-6 py-4" style={{ minWidth: 'max-content' }}>
                {slides.map(slide => (
                  <SlideCard key={slide.id} slide={slide} style={textStyle} fontSizePx={fontSizePx}
                    onCaptionChange={(id, val) => updateSlide(id, { caption: val })}
                    onPositionChange={(id, val) => updateSlide(id, { position: val })}
                    onDelete={id => setSlides(prev => prev.filter(s => s.id !== id).map((s, i) => ({ ...s, index: i })))}
                  />
                ))}
              </div>
              <AugmentPanel slides={slides} textStyle={textStyle} fontSizePx={fontSizePx} seriesName={seriesName} />
            </div>
          )}
        </div>
      </div>
    </div>

    {scheduleModal && (
      <ScheduleModal
        open={!!scheduleModal}
        onClose={() => setScheduleModal(null)}
        imageUrls={scheduleModal.urls}
        characterId={scheduleModal.characterId}
        characterName={scheduleModal.characterName}
      />
    )}
    {showLibrary && selectedChar && (
      <PromptLibraryModal
        open={showLibrary}
        onClose={() => setShowLibrary(false)}
        characterId={characterId}
        characterName={selectedChar.name}
        onSelect={p => setPrompt(p)}
        currentPrompt={prompt}
      />
    )}
    </>
  )
}
