'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { charactersStore, generationsStore } from '@/lib/store'
import { Character } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import JSZip from 'jszip'
import {
  Download,
  Loader2,
  Play,
  ImageIcon,
  CheckCircle2,
  AlertCircle,
  Upload,
  FileText,
  Info,
  Film,
  ChevronDown,
  X,
  Trash2,
  Clock,
  ExternalLink,
  XCircle,
  Shuffle,
  Plus,
} from 'lucide-react'

import {
  applyText,
  renderToBlob,
  renderAugmented,
  randomTransform,
  TEXT_STYLE_OPTIONS,
  POSITION_OPTIONS,
  SLIDE_VARIATIONS as VARIATIONS_IMPORT,
  TextPosition,
  TextStyle,
  AugTransform,
} from '@/lib/canvas-utils'

// ─── Types ────────────────────────────────────────────────────

type SlideStatus = 'idle' | 'generating' | 'done' | 'error'
type PageMode = 'generate' | 'wan' | 'csv' | 'video'

interface Slide {
  index: number
  status: SlideStatus
  imageUrl: string
  caption: string          // supports \n for newlines
  position: TextPosition
  error?: string
}

interface HistoryEntry {
  id: string
  seriesName: string
  characterName: string
  slideCount: number
  imageUrls: string[]
  captions: string[]
  createdAt: string
}

interface CsvRow {
  url: string
  caption: string
  position: TextPosition
  style: TextStyle
  fontSizePx: number
  filename: string
}

// ─── Constants ────────────────────────────────────────────────

const VARIATIONS = VARIATIONS_IMPORT

const CHUNK_SIZE = 10
const HISTORY_KEY = 'xm_reels_history'
const DEFAULT_FONT_PX = 72

// ─── History store ────────────────────────────────────────────

function getHistory(): HistoryEntry[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') } catch { return [] }
}

function saveHistory(entries: HistoryEntry[]) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, 200)))
}

function addHistory(entry: HistoryEntry) {
  const all = [entry, ...getHistory()]
  saveHistory(all.slice(0, 200))
}

// (canvas rendering imported from @/lib/canvas-utils)

interface AugPanelProps {
  slides: Slide[]
  textStyle: TextStyle
  fontSizePx: number
  seriesName: string
}

function AugmentPanel({ slides, textStyle, fontSizePx, seriesName }: AugPanelProps) {
  const [open, setOpen] = useState(false)
  const [perSlide, setPerSlide] = useState(20)
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(0)

  const doneSlides = slides.filter(s => s.status === 'done' && s.imageUrl)
  const total = doneSlides.length * perSlide

  async function run() {
    if (!doneSlides.length) return
    setRunning(true)
    setDone(0)

    const zip = new JSZip()
    const base = seriesName.trim().replace(/\s+/g, '_').toLowerCase() || 'carousel'
    let idx = 0
    let failed = 0

    for (const slide of doneSlides) {
      for (let v = 0; v < perSlide; v++) {
        try {
          const blob = await renderAugmented(
            slide.imageUrl, slide.caption, slide.position, textStyle, fontSizePx,
            randomTransform(),
          )
          zip.file(`${base}_aug_${String(++idx).padStart(4, '0')}.jpg`, blob)
        } catch { failed++ }
        setDone(idx + failed)
      }
    }

    setRunning(false)
    if (idx === 0) { toast.error('All variations failed'); return }
    if (failed > 0) toast.warning(`${failed} failed, ${idx} OK`)

    try {
      const content = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(content)
      a.download = `${base}_augmented.zip`
      a.click()
      URL.revokeObjectURL(a.href)
      toast.success(`Downloaded ${idx} augmented images`)
    } catch { toast.error('ZIP failed — try fewer variations') }
  }

  if (!doneSlides.length) return null

  const progress = total > 0 ? Math.round((done / total) * 100) : 0

  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <button
        onClick={() => setOpen(p => !p)}
        className="w-full flex items-center gap-2 px-4 py-3 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        <Shuffle className="w-3.5 h-3.5 shrink-0 text-primary" />
        <span className="text-foreground font-semibold">Augment & Multiply</span>
        <ChevronDown className={`w-3.5 h-3.5 ml-auto transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="border-t border-border px-4 pb-4 pt-3 space-y-3">
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Generates multiple unique variations of each done slide using random combinations of:
            mirror, zoom/crop, brightness, contrast, saturation, hue shift, sepia, blur, B&W.
          </p>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium">Variations per slide</p>
              <p className="text-xs text-muted-foreground">→ {total} total images</p>
            </div>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={500}
                value={perSlide}
                onChange={e => setPerSlide(Math.max(1, Math.min(500, Number(e.target.value) || 20)))}
                className="h-8 text-sm"
              />
              <div className="flex gap-1">
                {[10, 20, 50].map(n => (
                  <button
                    key={n}
                    onClick={() => setPerSlide(n)}
                    className={`px-2 py-1 rounded text-xs border transition-colors ${perSlide === n ? 'border-primary bg-primary/10' : 'border-border text-muted-foreground hover:border-primary/50'}`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Transform legend */}
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            {[
              ['Mirror', '50% chance'],
              ['Zoom', '0–8% crop'],
              ['Brightness', '±13%'],
              ['Contrast', '±13%'],
              ['Saturation', '±13%'],
              ['Hue shift', '±12°'],
              ['Sepia', '0–12%'],
              ['Blur', '15% chance'],
              ['B&W', '15% chance'],
            ].map(([name, range]) => (
              <div key={name} className="flex items-center justify-between text-[10px]">
                <span className="text-muted-foreground">{name}</span>
                <span className="text-foreground/60">{range}</span>
              </div>
            ))}
          </div>

          <Button className="w-full" onClick={run} disabled={running}>
            {running
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{done}/{total} rendering...</>
              : <><Shuffle className="w-4 h-4 mr-2" />Generate {total} variations</>
            }
          </Button>

          {running && (
            <div className="space-y-1">
              <div className="w-full bg-secondary rounded-full h-1.5">
                <div className="bg-primary h-1.5 rounded-full transition-all duration-200" style={{ width: `${progress}%` }} />
              </div>
              <p className="text-[10px] text-muted-foreground text-center">{progress}% — all in browser, no AI calls</p>
            </div>
          )}

          {total > 200 && !running && (
            <p className="text-[10px] text-orange-400">⚠️ {total} images may take a while and use significant memory.</p>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Slide card (GenCard style) ───────────────────────────────

function SlideCard({
  slide, style, fontSizePx,
  onCaptionChange, onPositionChange, onDelete,
}: {
  slide: Slide; style: TextStyle; fontSizePx: number
  onCaptionChange: (idx: number, val: string) => void
  onPositionChange: (idx: number, val: TextPosition) => void
  onDelete: (idx: number) => void
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
    <div className="group relative rounded-xl border border-border/50 bg-card overflow-hidden flex flex-col">
      {/* Image area — 9:16 */}
      <div className="relative w-full aspect-[9/16] bg-secondary/30 overflow-hidden">
        {slide.status === 'idle' && (
          <div className="flex items-center justify-center h-full">
            <ImageIcon className="w-10 h-10 opacity-20 text-muted-foreground" />
          </div>
        )}
        {slide.status === 'generating' && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
            <Loader2 className="w-8 h-8 animate-spin" />
            <p className="text-xs">Generating...</p>
          </div>
        )}
        {slide.status === 'error' && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-destructive px-4 text-center">
            <XCircle className="w-8 h-8 opacity-50" />
            <p className="text-xs">{slide.error ?? 'Failed'}</p>
          </div>
        )}
        {slide.status === 'done' && (
          <div className="relative group/img w-full h-full">
            <canvas ref={canvasRef} className="w-full h-full object-cover transition-opacity group-hover/img:opacity-70" />
            <div className="absolute inset-0 flex items-center justify-center gap-2 opacity-0 group-hover/img:opacity-100 transition-opacity bg-black/20">
              <a
                href={slide.imageUrl} target="_blank" rel="noopener noreferrer"
                className="w-7 h-7 rounded-full bg-black/60 flex items-center justify-center hover:bg-black/80 transition-colors"
                onClick={e => e.stopPropagation()}
              >
                <ExternalLink className="w-3 h-3 text-white" />
              </a>
            </div>
          </div>
        )}

        {/* Slide number */}
        <div className="absolute top-2 right-2 bg-black/60 text-white text-[10px] font-bold px-2 py-0.5 rounded-full z-10">
          {slide.index + 1}
        </div>
        {slide.status === 'done' && (
          <div className="absolute top-2 left-2 z-10">
            <CheckCircle2 className="w-4 h-4 text-green-400 drop-shadow" />
          </div>
        )}
      </div>

      {/* Meta */}
      <div className="px-3 py-3 flex flex-col gap-2">
        <Textarea
          placeholder={`Slide ${slide.index + 1} caption...\nUse Enter for new line`}
          value={slide.caption}
          onChange={e => onCaptionChange(slide.index, e.target.value)}
          rows={3}
          className="text-sm resize-none"
        />
        <Select value={slide.position} onValueChange={v => onPositionChange(slide.index, v as TextPosition)}>
          <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {POSITION_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {/* Delete on hover */}
      <button
        onClick={() => onDelete(slide.index)}
        className="absolute top-10 right-2 w-6 h-6 rounded-full bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center hover:bg-destructive z-20"
      >
        <Trash2 className="w-3 h-3" />
      </button>
    </div>
  )
}

// ─── History panel ────────────────────────────────────────────

function HistoryPanel({ onRestore }: { onRestore: (entry: HistoryEntry) => void }) {
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setEntries(getHistory())
  }, [open])

  function remove(id: string) {
    const next = getHistory().filter(e => e.id !== id)
    saveHistory(next)
    setEntries(next)
  }

  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <button
        onClick={() => setOpen(p => !p)}
        className="w-full flex items-center gap-2 px-4 py-3 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        <Clock className="w-3.5 h-3.5 shrink-0" />
        <span>History ({entries.length})</span>
        <ChevronDown className={`w-3.5 h-3.5 ml-auto transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-border max-h-64 overflow-y-auto divide-y divide-border/50">
          {entries.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">No history yet</p>
          ) : entries.map(e => (
            <div key={e.id} className="flex items-center gap-2 px-4 py-2.5 hover:bg-secondary/30 group">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate">{e.seriesName || 'Untitled'}</p>
                <p className="text-[10px] text-muted-foreground">{e.characterName} · {e.slideCount} slides · {new Date(e.createdAt).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })}</p>
              </div>
              <button
                onClick={() => onRestore(e)}
                className="text-[10px] text-primary shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                Restore
              </button>
              <button
                onClick={() => remove(e.id)}
                className="text-muted-foreground hover:text-destructive shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── CSV Guide ────────────────────────────────────────────────

function CsvGuide() {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-xl border border-border bg-secondary/30 overflow-hidden">
      <button
        onClick={() => setOpen(p => !p)}
        className="w-full flex items-center gap-2 px-4 py-3 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        <Info className="w-3.5 h-3.5 shrink-0" />
        <span>CSV format & bulk guide</span>
        <ChevronDown className={`w-3.5 h-3.5 ml-auto transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3 text-xs text-muted-foreground border-t border-border pt-3">
          <div>
            <p className="font-semibold text-foreground mb-1">Minimum (required)</p>
            <code className="block bg-background rounded p-2 text-[10px]">{`url,caption`}</code>
          </div>
          <div>
            <p className="font-semibold text-foreground mb-1">Full format</p>
            <code className="block bg-background rounded p-2 text-[10px] whitespace-pre-wrap break-all">{`url,caption,position,style,font_size_px,filename

position:     top | center | bottom   (default: bottom)
style:        white-black | black-white | gold-black
font_size_px: integer pixels (default: 72)
filename:     custom name without .jpg`}</code>
          </div>
          <div>
            <p className="font-semibold text-foreground mb-1">Example</p>
            <code className="block bg-background rounded p-2 text-[10px] whitespace-pre-wrap break-all">{`https://cdn.example.com/photo1.jpg,Golden hour vibes,bottom,white-black,80,beach_01
https://cdn.example.com/photo2.jpg,Feeling free,center,,60,
https://cdn.example.com/photo3.jpg,Summer forever`}</code>
          </div>
          <div className="space-y-1.5 pt-1 border-t border-border">
            <p className="font-semibold text-foreground">10,000+ photos — tips</p>
            <ul className="space-y-1 list-disc list-inside">
              <li>URLs must be <strong>publicly accessible</strong> (CDN, S3, WaveSpeed links)</li>
              <li>Split into batches of <strong>max 500 rows</strong> per ZIP to avoid memory limits</li>
              <li>Processing: ~{CHUNK_SIZE} images in parallel → ~5–15s per 100 images</li>
              <li>ZIP files over ~500 MB may fail — prefer 200–300 image batches</li>
              <li>Multi-line captions in CSV: use <code>\n</code> literal in the caption field</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── CSV Mode ─────────────────────────────────────────────────

function CsvMode({ defaultStyle, defaultFontSizePx, defaultPosition }: {
  defaultStyle: TextStyle; defaultFontSizePx: number; defaultPosition: TextPosition
}) {
  const [rows, setRows] = useState<CsvRow[]>([])
  const [seriesName, setSeriesName] = useState('series')
  const [processed, setProcessed] = useState(0)
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  function parseCsv(text: string): CsvRow[] {
    const lines = text.trim().split(/\r?\n/).filter(Boolean)
    if (!lines.length) return []
    const firstLine = lines[0].toLowerCase()
    const hasHeader = firstLine.startsWith('url') || firstLine.startsWith('"url')
    const dataLines = hasHeader ? lines.slice(1) : lines

    return dataLines.map((line, i) => {
      const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, '').replace(/\\n/g, '\n'))
      const url        = cols[0] ?? ''
      const caption    = cols[1] ?? ''
      const position   = (['top','center','bottom'].includes(cols[2]) ? cols[2] : defaultPosition) as TextPosition
      const style      = (['white-black','black-white','gold-black'].includes(cols[3]) ? cols[3] : defaultStyle) as TextStyle
      const fontSizePx = parseInt(cols[4]) || defaultFontSizePx
      const filename   = cols[5] || String(i + 1).padStart(4, '0')
      return { url, caption, position, style, fontSizePx, filename }
    }).filter(r => r.url.startsWith('http'))
  }

  function handleFile(file: File) {
    setError('')
    const reader = new FileReader()
    reader.onload = e => {
      try {
        const parsed = parseCsv(e.target?.result as string)
        if (!parsed.length) { setError('No valid rows found. Check that URLs start with http.'); return }
        setRows(parsed)
        setProcessed(0)
        toast.success(`${parsed.length} rows loaded`)
      } catch { setError('Failed to parse CSV') }
    }
    reader.readAsText(file)
  }

  async function processBatch() {
    if (!rows.length) return
    setProcessing(true)
    setProcessed(0)

    const base = seriesName.trim().replace(/\s+/g, '_').toLowerCase() || 'series'
    const zip = new JSZip()
    let done = 0; let failed = 0

    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE)
      await Promise.allSettled(chunk.map(async (row, ci) => {
        try {
          const blob = await renderToBlob(row.url, row.caption, row.position, row.style, row.fontSizePx)
          const name = row.filename.includes('.') ? row.filename : `${base}_${row.filename}.jpg`
          zip.file(name, blob)
          done++
        } catch { failed++ }
        setProcessed(i + ci + 1)
      }))
    }

    setProcessing(false)
    if (done === 0) { toast.error('All images failed'); return }
    if (failed > 0) toast.warning(`${failed} failed, ${done} OK`)

    try {
      const content = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } })
      const url = URL.createObjectURL(content)
      const a = document.createElement('a')
      a.href = url; a.download = `${base}.zip`; a.click()
      URL.revokeObjectURL(url)
      toast.success(`Downloaded ${done} images`)
    } catch { toast.error('ZIP generation failed — try a smaller batch') }
  }

  const progress = rows.length ? Math.round((processed / rows.length) * 100) : 0

  return (
    <div className="flex h-full overflow-hidden">
      <div className="w-80 flex flex-col border-r border-border bg-sidebar/30 shrink-0 overflow-y-auto">
        <div className="px-5 py-5 space-y-4">
          <CsvGuide />

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Series / ZIP name</p>
            <Input value={seriesName} onChange={e => setSeriesName(e.target.value)} placeholder="my_series" />
          </div>

          <div
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f?.name.endsWith('.csv')) handleFile(f) }}
            onClick={() => fileRef.current?.click()}
            className="border-2 border-dashed border-border rounded-xl p-6 text-center cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-colors space-y-2"
          >
            <Upload className="w-8 h-8 mx-auto text-muted-foreground opacity-50" />
            <p className="text-sm font-medium">{rows.length ? `${rows.length} rows loaded` : 'Drop CSV or click to upload'}</p>
            <p className="text-xs text-muted-foreground">Supports 10,000+ rows</p>
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])} />
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-xs text-destructive">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{error}
            </div>
          )}

          {rows.length > 0 && (
            <div className="space-y-2">
              <Button className="w-full" onClick={processBatch} disabled={processing}>
                {processing
                  ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Processing {processed}/{rows.length}...</>
                  : <><Play className="w-4 h-4 mr-2" />Process & Download ({rows.length})</>
                }
              </Button>
              {(processing || processed > 0) && (
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{processed} / {rows.length}</span><span>{progress}%</span>
                  </div>
                  <div className="w-full bg-secondary rounded-full h-1.5">
                    <div className="bg-primary h-1.5 rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
                  </div>
                </div>
              )}
              <Button variant="ghost" size="sm" className="w-full text-muted-foreground" onClick={() => { setRows([]); setProcessed(0) }}>
                <X className="w-3.5 h-3.5 mr-1.5" />Clear
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
            <FileText className="w-16 h-16 opacity-10 mb-3" />
            <p className="text-sm">Upload a CSV to preview rows</p>
            <p className="text-xs opacity-60 mt-1">Each row = one image with text overlay</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">{rows.length} rows{rows.length > 100 ? ' — showing first 100' : ''}</p>
              {rows.length > 500 && <p className="text-xs text-orange-400">⚠️ Large batch — consider splitting into 500-row chunks</p>}
            </div>
            <div className="rounded-xl border border-border overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-secondary/60">
                  <tr>
                    {['#','URL','Caption','Pos','Style','Px','Filename'].map(h => (
                      <th key={h} className="text-left px-3 py-2 text-muted-foreground font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {rows.slice(0, 100).map((row, i) => (
                    <tr key={i} className="hover:bg-secondary/30">
                      <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                      <td className="px-3 py-2 max-w-[150px] truncate text-muted-foreground font-mono text-[10px]">{row.url.split('/').pop()}</td>
                      <td className="px-3 py-2 max-w-[140px] truncate">{row.caption.replace(/\n/g, '↵') || <span className="text-muted-foreground/40 italic">empty</span>}</td>
                      <td className="px-3 py-2">{row.position}</td>
                      <td className="px-3 py-2 text-muted-foreground">{row.style}</td>
                      <td className="px-3 py-2 text-muted-foreground">{row.fontSizePx}</td>
                      <td className="px-3 py-2 font-mono text-muted-foreground text-[10px]">{row.filename}</td>
                    </tr>
                  ))}
                  {rows.length > 100 && (
                    <tr><td colSpan={7} className="px-3 py-3 text-center text-muted-foreground italic">+ {rows.length - 100} more (all will be processed)</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── WAN Variations Mode ─────────────────────────────────────

interface WanPreset {
  id: string
  name: string
  prompts: string[]
  suffix: string
  builtIn?: boolean
}

const BUILT_IN_PRESETS: WanPreset[] = [
  {
    id: 'camera-angles',
    name: 'Camera Angles',
    suffix: 'photorealistic, sharp detail, natural lighting. Keep outfit, background identical.',
    builtIn: true,
    prompts: [
      'Front camera selfie — she holds phone toward camera, candid natural expression.',
      'Three-quarter angle — camera rotated slightly to the right. Same scene.',
      'She looks away from camera, candid over-the-shoulder moment.',
      'Close-up framing — camera zoomed closer, face fills more of frame.',
      'Low camera angle slightly upward from waist level. Same scene.',
    ],
  },
  {
    id: 'candid-dump',
    name: 'Candid Dump',
    suffix: 'film grain, warm tones, authentic candid moment, natural imperfection, pinterest aesthetic.',
    builtIn: true,
    prompts: [
      'Morning routine — she sips coffee by window, soft natural light, cozy and unstaged.',
      'Street walk — caught mid-stride on a quiet street, golden hour, casual outfit.',
      'Mirror moment — bathroom or bedroom mirror selfie, relaxed expression, authentic.',
      'Reading or phone — lounging on bed or couch, looking down, ambient warm light.',
      'Golden hour outdoor — face lit by low sun, eyes slightly squinted, natural smile.',
    ],
  },
  {
    id: 'mood-shift',
    name: 'Mood Shift',
    suffix: 'photorealistic, expressive, consistent outfit and setting.',
    builtIn: true,
    prompts: [
      'Neutral calm expression — composed, still, direct eye contact, serene.',
      'Soft genuine smile — warm, approachable, slight eye crinkle.',
      'Head thrown back laughing — full candid laugh, natural and unguarded.',
      'Thoughtful and distant — looking away, slightly melancholic, introspective.',
      'Playful smirk — one eyebrow raised, teasing expression, knowing look.',
    ],
  },
  {
    id: 'crop-zoom',
    name: 'Crop Zoom',
    suffix: 'sharp focus, consistent lighting and expression throughout.',
    builtIn: true,
    prompts: [
      'Full body shot — head to toe, natural standing pose, full environment visible.',
      'Three-quarter — waist to head, relaxed posture, background softly visible.',
      'Waist up — torso and face, hands partially visible, medium crop.',
      'Bust shot — shoulders and face only, intimate but not extreme.',
      'Face close-up — chin to forehead, skin detail, eyes as focal point.',
    ],
  },
  {
    id: 'body-language',
    name: 'Body Language',
    suffix: 'photorealistic, natural posture, same outfit and location.',
    builtIn: true,
    prompts: [
      'Standing tall — confident upright posture, hands relaxed at sides, direct gaze.',
      'Leaning against wall — casual, one shoulder back, arms loosely crossed.',
      'Seated relaxed — sitting naturally, weight to one side, comfortable and open.',
      'Dynamic movement — mid-step or turning, energy and motion implied.',
      'Intimate and close — leaning toward camera, elbows on surface, soft and inviting.',
    ],
  },
]

const PRESETS_STORAGE_KEY = 'xm_wan_presets'

function loadCustomPresets(): WanPreset[] {
  try {
    return JSON.parse(localStorage.getItem(PRESETS_STORAGE_KEY) ?? '[]')
  } catch { return [] }
}

function saveCustomPresets(presets: WanPreset[]) {
  localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(presets))
}

function makeWanSlides(count = 5): Slide[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i, status: 'idle' as SlideStatus, imageUrl: '', caption: '', position: 'bottom' as TextPosition,
  }))
}

function WanVariationsMode({ textStyle, fontSizePx, defaultPosition }: {
  textStyle: TextStyle; fontSizePx: number; defaultPosition: TextPosition
}) {
  const searchParams = useSearchParams()
  const [baseImageUrl, setBaseImageUrl] = useState('')
  const [baseImageFiles, setBaseImageFiles] = useState<Array<{ id: string; file: File; url: string }>>([])
  const fileUploadRef = useRef<HTMLInputElement>(null)
  const [prompts, setPrompts] = useState<string[]>(BUILT_IN_PRESETS[0].prompts)
  const [promptSuffix, setPromptSuffix] = useState(BUILT_IN_PRESETS[0].suffix)
  const [activePresetId, setActivePresetId] = useState<string>(BUILT_IN_PRESETS[0].id)
  const [customPresets, setCustomPresets] = useState<WanPreset[]>([])
  const [savePresetName, setSavePresetName] = useState('')
  const [showSaveInput, setShowSaveInput] = useState(false)
  const [seriesName, setSeriesName] = useState('')
  const [slides, setSlides] = useState<Slide[]>(makeWanSlides())
  const [promptHint, setPromptHint] = useState('')
  const [analyzingPoses, setAnalyzingPoses] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const [historyImages, setHistoryImages] = useState<{ url: string; id: string }[]>([])

  useEffect(() => {
    const url = searchParams.get('imageUrl')
    if (url) setBaseImageUrl(decodeURIComponent(url))
    const gens = generationsStore.getAll()
    const imgs: { url: string; id: string }[] = []
    for (const g of gens) {
      if (g.status === 'done') {
        for (const u of g.outputUrls) imgs.push({ url: u, id: g.id + u })
      }
    }
    setHistoryImages(imgs.slice(0, 100))
    setCustomPresets(loadCustomPresets())
  }, [searchParams])

  const allPresets = [...BUILT_IN_PRESETS, ...customPresets]

  function applyPreset(preset: WanPreset) {
    setPrompts([...preset.prompts])
    setPromptSuffix(preset.suffix)
    setActivePresetId(preset.id)
    setSeriesName(preset.name.toLowerCase().replace(/\s+/g, '_'))
  }

  function saveCurrentAsPreset() {
    if (!savePresetName.trim()) return
    const preset: WanPreset = {
      id: crypto.randomUUID(),
      name: savePresetName.trim(),
      prompts: [...prompts],
      suffix: promptSuffix,
    }
    const updated = [...customPresets, preset]
    setCustomPresets(updated)
    saveCustomPresets(updated)
    setActivePresetId(preset.id)
    setSavePresetName('')
    setShowSaveInput(false)
    toast.success(`Preset "${preset.name}" saved`)
  }

  function deleteCustomPreset(id: string) {
    const updated = customPresets.filter(p => p.id !== id)
    setCustomPresets(updated)
    saveCustomPresets(updated)
    if (activePresetId === id) setActivePresetId(BUILT_IN_PRESETS[0].id)
  }

  async function generatePromptsFromImage() {
    if (!baseImageFiles.length && !baseImageUrl.trim()) {
      toast.error('Upload a reference image first')
      return
    }
    setAnalyzingPoses(true)
    try {
      const fd = new FormData()
      if (baseImageFiles.length > 0) {
        for (const f of baseImageFiles) fd.append('files[]', f.file)
      } else {
        // Fetch URL via proxy and use as file
        const res = await fetch(`/api/proxy-image?url=${encodeURIComponent(baseImageUrl.trim())}`)
        if (!res.ok) throw new Error('Could not fetch image')
        const blob = await res.blob()
        fd.append('file', new File([blob], 'image.jpg', { type: blob.type || 'image/jpeg' }))
      }
      if (promptHint.trim()) fd.append('hint', promptHint.trim())
      fd.append('count', String(prompts.length))

      const res = await fetch('/api/grok/analyze-poses', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok || !data.prompts?.length) throw new Error(data.error ?? 'No prompts returned')

      setPrompts(data.prompts)
      toast.success('Prompts generated from image')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to analyze image')
    } finally {
      setAnalyzingPoses(false)
    }
  }

  function handleFileUpload(files: FileList | null) {
    if (!files?.length) return
    const newFiles = Array.from(files).map(file => ({
      id: crypto.randomUUID(), file, url: URL.createObjectURL(file),
    }))
    setBaseImageFiles(prev => [...prev, ...newFiles])
    setBaseImageUrl('')
  }

  const updateSlide = useCallback((idx: number, patch: Partial<Slide>) => {
    setSlides(prev => prev.map(s => s.index === idx ? { ...s, ...patch } : s))
  }, [])

  async function getBaseFilesForGeneration(): Promise<File[]> {
    if (baseImageFiles.length > 0) return baseImageFiles.map(f => f.file)
    // Fallback: single URL
    const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(baseImageUrl.trim())}`
    const res = await fetch(proxyUrl)
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error ?? `Could not fetch image (${res.status})`)
    }
    const blob = await res.blob()
    return [new File([blob], 'image.jpg', { type: blob.type || 'image/jpeg' })]
  }

  async function generateVariations() {
    if (!baseImageUrl.trim() && !baseImageFiles.length) { toast.error('Upload reference images or enter a URL'); return }
    setGenerating(true)
    setSlides(makeWanSlides())

    const files = await getBaseFilesForGeneration().catch(e => {
      toast.error(e instanceof Error ? e.message : 'Failed to load images')
      setGenerating(false)
      return null
    })
    if (!files) return

    // Only generate for prompts that have text
    const activePrompts = prompts.map((p, i) => ({ prompt: p, index: i })).filter(p => p.prompt.trim())
    if (!activePrompts.length) { toast.error('Add at least one prompt'); setGenerating(false); return }

    setSlides(makeWanSlides(activePrompts.length))

    // Mark all active as generating immediately
    for (let i = 0; i < activePrompts.length; i++) updateSlide(i, { status: 'generating' })

    // Fire all active requests in parallel
    await Promise.allSettled(
      activePrompts.map(({ prompt }, i) =>
        (async () => {
          const fd = new FormData()
          const fullPrompt = promptSuffix.trim()
            ? `${prompt} ${promptSuffix.trim()}`
            : prompt
          if (files.length === 1) {
            fd.append('file', files[0])
          } else {
            for (const f of files) fd.append('files[]', f)
          }
          fd.append('prompt', fullPrompt)
          fd.append('size', '756*1344')
          fd.append('saveHistory', 'true')
          fd.append('historyPrompt', fullPrompt)
          try {
            const res = await fetch('/api/wan-edit', { method: 'POST', body: fd })
            const data = await res.json()
            if (!res.ok || !data.urls?.length) throw new Error(data.error ?? 'No image returned')
            updateSlide(i, { status: 'done', imageUrl: data.urls[0] })
          } catch (e: unknown) {
            updateSlide(i, { status: 'error', error: e instanceof Error ? e.message : 'Error' })
          }
        })()
      )
    )

    setGenerating(false)
    toast.success('Variations done!')
  }

  async function downloadZip() {
    const doneSlides = slides.filter(s => s.status === 'done' && s.imageUrl)
    if (!doneSlides.length) return
    setDownloading(true)
    try {
      const zip = new JSZip()
      const base = seriesName.trim().replace(/\s+/g, '_').toLowerCase() || 'variations'
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

  const doneCount = slides.filter(s => s.status === 'done').length

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel */}
      <div className="w-80 flex flex-col border-r border-border bg-sidebar/30 shrink-0 overflow-y-auto">
        <div className="px-5 py-5 space-y-4">

          {/* Base images */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">Reference images</p>
              {baseImageFiles.length > 0 && (
                <button className="text-[10px] text-muted-foreground hover:text-destructive transition-colors"
                  onClick={() => setBaseImageFiles([])}>Clear all</button>
              )}
            </div>
            <input ref={fileUploadRef} type="file" accept="image/*" multiple className="hidden"
              onChange={e => handleFileUpload(e.target.files)} />

            {/* Upload zone (shown when no files) */}
            {baseImageFiles.length === 0 && !baseImageUrl && (
              <button onClick={() => fileUploadRef.current?.click()}
                className="w-full border-2 border-dashed border-border rounded-xl p-4 flex flex-col items-center gap-1.5 hover:border-primary/50 hover:bg-primary/5 transition-colors text-muted-foreground hover:text-foreground">
                <Upload className="w-4 h-4" />
                <span className="text-xs">Upload reference photos</span>
                <span className="text-[10px] opacity-60">Multiple files supported</span>
              </button>
            )}

            {/* Thumbnail grid */}
            {baseImageFiles.length > 0 && (
              <div className="space-y-2">
                <div className="grid grid-cols-4 gap-1.5">
                  {baseImageFiles.map(img => (
                    <div key={img.id} className="relative group aspect-square rounded-lg overflow-hidden border border-border">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.url} alt="" className="w-full h-full object-cover" />
                      <button onClick={() => setBaseImageFiles(prev => prev.filter(f => f.id !== img.id))}
                        className="absolute top-1 right-1 w-4 h-4 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  ))}
                  <button onClick={() => fileUploadRef.current?.click()}
                    className="aspect-square rounded-lg border-2 border-dashed border-border flex items-center justify-center hover:border-primary/50 hover:bg-primary/5 transition-colors text-muted-foreground">
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
                <p className="text-[10px] text-muted-foreground">{baseImageFiles.length} reference image(s) — all used per slide</p>
              </div>
            )}

            {/* URL input */}
            {baseImageFiles.length === 0 && (
              <div className="flex gap-1.5">
                <Input
                  placeholder="Or paste URL — Pinterest, CDN..."
                  value={baseImageUrl}
                  onChange={e => setBaseImageUrl(e.target.value)}
                  className="text-xs"
                />
                <Button variant="outline" size="icon" className="shrink-0 h-9 w-9" title="Upload instead"
                  onClick={() => fileUploadRef.current?.click()}>
                  <Upload className="w-4 h-4" />
                </Button>
                <Button variant="outline" size="icon" className="shrink-0 h-9 w-9" title="Pick from history"
                  onClick={() => setShowPicker(true)}>
                  <Clock className="w-4 h-4" />
                </Button>
              </div>
            )}
            {baseImageUrl && baseImageFiles.length === 0 && (
              <div className="relative w-full aspect-[9/16] rounded-lg overflow-hidden border border-border bg-secondary/30">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/proxy-image?url=${encodeURIComponent(baseImageUrl)}`} alt="base"
                  className="w-full h-full object-cover"
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
              </div>
            )}
          </div>

          {/* Preset selector */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Variation preset</p>
            <div className="flex gap-1.5">
              <select
                value={activePresetId}
                onChange={e => {
                  const p = allPresets.find(x => x.id === e.target.value)
                  if (p) applyPreset(p)
                }}
                className="flex-1 h-9 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <optgroup label="Built-in">
                  {BUILT_IN_PRESETS.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </optgroup>
                {customPresets.length > 0 && (
                  <optgroup label="Custom">
                    {customPresets.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </optgroup>
                )}
              </select>
              <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" title="Save current as preset"
                onClick={() => setShowSaveInput(v => !v)}>
                <Plus className="w-4 h-4" />
              </Button>
              {activePresetId && customPresets.find(p => p.id === activePresetId) && (
                <Button variant="outline" size="icon" className="h-9 w-9 shrink-0 hover:border-destructive hover:text-destructive"
                  title="Delete this preset"
                  onClick={() => { if (confirm('Delete this preset?')) deleteCustomPreset(activePresetId) }}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              )}
            </div>
            {showSaveInput && (
              <div className="flex gap-1.5">
                <Input
                  placeholder="Preset name..."
                  value={savePresetName}
                  onChange={e => setSavePresetName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') saveCurrentAsPreset() }}
                  className="text-xs h-8"
                  autoFocus
                />
                <Button size="sm" className="h-8 shrink-0" onClick={saveCurrentAsPreset}
                  disabled={!savePresetName.trim()}>Save</Button>
              </div>
            )}
          </div>

          {/* Series name */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Series name <span className="opacity-50">(filenames)</span></p>
            <Input placeholder="pose_variations" value={seriesName} onChange={e => setSeriesName(e.target.value)} />
          </div>

          {/* Prompt suffix */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Quality suffix <span className="opacity-50">(appended to every prompt)</span></p>
            <Textarea
              value={promptSuffix}
              onChange={e => setPromptSuffix(e.target.value)}
              rows={2}
              placeholder="photorealistic, sharp detail..."
              className="text-xs resize-none"
            />
          </div>

          {/* AI prompt generation from image */}
          {(baseImageFiles.length > 0 || baseImageUrl.trim()) && (
            <div className="space-y-1.5 p-3 rounded-xl border border-primary/20 bg-primary/5">
              <p className="text-xs font-medium text-foreground">Auto-generate prompts</p>
              <Input
                placeholder="Hint (optional) — e.g. outdoor, lingerie, dominant..."
                value={promptHint}
                onChange={e => setPromptHint(e.target.value)}
                className="text-xs h-8"
              />
              <Button
                className="w-full h-8 text-xs"
                onClick={generatePromptsFromImage}
                disabled={analyzingPoses || generating}
              >
                {analyzingPoses
                  ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Analyzing image...</>
                  : <><Shuffle className="w-3.5 h-3.5 mr-1.5" />Generate prompts from image</>}
              </Button>
            </div>
          )}

          {/* Variation prompts */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">Variation prompts</p>
              <p className="text-[10px] text-muted-foreground">
                {prompts.filter(p => p.trim()).length} / {prompts.length} active
              </p>
            </div>
            {prompts.map((p, i) => (
              <div key={i} className="space-y-1">
                <p className={`text-[10px] ${p.trim() ? 'text-primary/70' : 'text-muted-foreground/40'}`}>
                  Slide {i + 1}{!p.trim() ? ' — skip' : ''}
                </p>
                <Textarea
                  value={p}
                  onChange={e => setPrompts(prev => prev.map((x, j) => j === i ? e.target.value : x))}
                  rows={2}
                  className={`text-xs resize-none ${!p.trim() ? 'opacity-40' : ''}`}
                />
              </div>
            ))}
          </div>

          {/* Actions */}
          <div className="space-y-2 pt-1">
            <Button
              className="w-full"
              onClick={generateVariations}
              disabled={generating || (!baseImageUrl.trim() && !baseImageFiles.length)}
            >
              {generating
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Generating... ({doneCount}/5)</>
                : <><Shuffle className="w-4 h-4 mr-2" />Generate variations</>
              }
            </Button>
            {doneCount > 0 && !generating && (
              <Button variant="outline" className="w-full border-green-500/40 text-green-400 hover:bg-green-500/10" onClick={downloadZip} disabled={downloading}>
                {downloading
                  ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Exporting...</>
                  : <><Download className="w-4 h-4 mr-2" />Download ZIP ({doneCount} slides)</>
                }
              </Button>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
            WAN 2.7 image editing — each slide is generated sequentially (~2-3 min each). Keep this tab open.
          </p>
        </div>
      </div>

      {/* Right — slide grid */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid gap-4 grid-cols-5">
          {slides.map(slide => (
            <SlideCard
              key={slide.index}
              slide={slide}
              style={textStyle}
              fontSizePx={fontSizePx}
              onCaptionChange={(idx, val) => updateSlide(idx, { caption: val })}
              onPositionChange={(idx, val) => updateSlide(idx, { position: val })}
              onDelete={idx => updateSlide(idx, { status: 'idle', imageUrl: '', caption: '', error: undefined })}
            />
          ))}
        </div>
        {slides.every(s => s.status === 'idle') && (
          <div className="flex flex-col items-center justify-center h-64 text-muted-foreground mt-8">
            <Shuffle className="w-16 h-16 opacity-10 mb-3" />
            <p className="text-sm">Add a base image and click "Generate variations"</p>
            <p className="text-xs opacity-60 mt-1">5 different poses/angles via WAN 2.7 image editing</p>
          </div>
        )}
      </div>

      {/* History picker modal */}
      {showPicker && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={() => setShowPicker(false)}>
          <div className="bg-background border border-border rounded-xl w-[700px] max-h-[80vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <p className="font-semibold text-sm">Pick from generation history</p>
              <button onClick={() => setShowPicker(false)} className="text-muted-foreground hover:text-foreground">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-y-auto p-4">
              {historyImages.length === 0
                ? <p className="text-center text-muted-foreground py-8 text-sm">No generated images found</p>
                : (
                  <div className="grid grid-cols-5 gap-2">
                    {historyImages.map(img => (
                      <button
                        key={img.id}
                        className="aspect-[9/16] rounded-lg overflow-hidden border border-border hover:border-primary transition-colors"
                        onClick={() => { setBaseImageUrl(img.url); setShowPicker(false) }}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={img.url} alt="" className="w-full h-full object-cover" />
                      </button>
                    ))}
                  </div>
                )
              }
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Generate Mode ────────────────────────────────────────────

function makeSlides(count: number): Slide[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i, status: 'idle' as SlideStatus, imageUrl: '', caption: '', position: 'bottom' as TextPosition,
  }))
}

function GenerateMode({ textStyle, fontSizePx, defaultPosition }: {
  textStyle: TextStyle; fontSizePx: number; defaultPosition: TextPosition
}) {
  const [characters, setCharacters] = useState<Character[]>([])
  const [characterId, setCharacterId] = useState('')
  const [seriesName, setSeriesName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [slideCount, setSlideCount] = useState<3 | 5 | 7>(3)
  const [slides, setSlides] = useState<Slide[]>(makeSlides(3))
  const [generating, setGenerating] = useState(false)
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    const chars = charactersStore.getAll()
    setCharacters(chars)
    if (chars.length) setCharacterId(chars[0].id)
  }, [])

  const character = characters.find(c => c.id === characterId)

  function changeSlideCount(n: 3 | 5 | 7) {
    setSlideCount(n)
    setSlides(makeSlides(n))
  }

  const updateSlide = useCallback((idx: number, patch: Partial<Slide>) => {
    setSlides(prev => prev.map(s => s.index === idx ? { ...s, ...patch } : s))
  }, [])

  function resetSlide(idx: number) {
    updateSlide(idx, { status: 'idle', imageUrl: '', caption: '', error: undefined })
  }

  async function generateAll() {
    if (!prompt.trim() || !character) return
    if (!character.loraUrl) {
      toast.warning('This character has no LoRA URL configured. Images will generate without character likeness.')
    }
    setGenerating(true)

    const newSlides = makeSlides(slideCount)
    setSlides(newSlides)

    for (let i = 0; i < slideCount; i++) {
      updateSlide(i, { status: 'generating', imageUrl: '', error: undefined })
      const fullPrompt = `${prompt.trim()}, ${VARIATIONS[i % VARIATIONS.length]}`
      try {
        const res = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: fullPrompt,
            dimension: '9:16',
            batch: 1,
            loraUrl: character.loraUrl || null,
            loraScale: character.loraScale || 0.8,
          }),
        })
        const data = await res.json()
        if (!res.ok || !data.urls?.length) throw new Error(data.error ?? 'No image returned')
        updateSlide(i, { status: 'done', imageUrl: data.urls[0] })
      } catch (e: unknown) {
        updateSlide(i, { status: 'error', error: e instanceof Error ? e.message : 'Error' })
      }
    }

    setGenerating(false)

    // Save to history
    setSlides(current => {
      const doneUrls = current.filter(s => s.status === 'done').map(s => s.imageUrl)
      if (doneUrls.length) {
        addHistory({
          id: crypto.randomUUID(),
          seriesName: seriesName || 'Untitled',
          characterName: character?.name ?? '',
          slideCount,
          imageUrls: doneUrls,
          captions: current.map(s => s.caption),
          createdAt: new Date().toISOString(),
        })
      }
      return current
    })
    toast.success('Done!')
  }

  async function downloadZip() {
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

  function restoreFromHistory(entry: HistoryEntry) {
    setSeriesName(entry.seriesName)
    setSlides(entry.imageUrls.map((url, i) => ({
      index: i,
      status: 'done' as SlideStatus,
      imageUrl: url,
      caption: entry.captions[i] ?? '',
      position: 'bottom' as TextPosition,
    })))
    setSlideCount(entry.slideCount as 3 | 5 | 7)
    toast.success('Restored from history')
  }

  const doneCount = slides.filter(s => s.status === 'done').length

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel */}
      <div className="w-80 flex flex-col border-r border-border bg-sidebar/30 shrink-0 overflow-y-auto">
        <div className="px-5 py-5 space-y-4">
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Character</p>
            <Select value={characterId} onValueChange={v => setCharacterId(v ?? characterId)}>
              <SelectTrigger><SelectValue placeholder="Select character..." /></SelectTrigger>
              <SelectContent>
                {characters.map(c => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                    {!c.loraUrl && <span className="text-muted-foreground ml-1">(no LoRA)</span>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {character && !character.loraUrl && (
              <p className="text-[10px] text-orange-400">⚠️ No LoRA URL — configure in Admin → Characters</p>
            )}
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Series name <span className="opacity-50">(filenames)</span></p>
            <Input placeholder="beach_vacation" value={seriesName} onChange={e => setSeriesName(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Number of slides</p>
            <Select value={String(slideCount)} onValueChange={v => changeSlideCount(Number(v) as 3 | 5 | 7)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="3">3 slides</SelectItem>
                <SelectItem value="5">5 slides</SelectItem>
                <SelectItem value="7">7 slides</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Base prompt</p>
            <Textarea
              placeholder="at the beach, golden hour, wearing bikini..."
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              rows={4}
              className="resize-none text-sm"
            />
            <p className="text-[10px] text-muted-foreground">Pose/angle variation added per slide automatically.</p>
          </div>

          <div className="space-y-2 pt-1">
            <Button className="w-full" onClick={generateAll} disabled={generating || !prompt.trim() || !character}>
              {generating
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Generating... ({doneCount}/{slideCount})</>
                : <><Play className="w-4 h-4 mr-2" />Generate all slides</>
              }
            </Button>
            {doneCount > 0 && !generating && (
              <Button variant="outline" className="w-full border-green-500/40 text-green-400 hover:bg-green-500/10" onClick={downloadZip} disabled={downloading}>
                {downloading
                  ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Exporting...</>
                  : <><Download className="w-4 h-4 mr-2" />Download ZIP ({doneCount} slides)</>
                }
              </Button>
            )}
          </div>

          <AugmentPanel slides={slides} textStyle={textStyle} fontSizePx={fontSizePx} seriesName={seriesName} />
          <HistoryPanel onRestore={restoreFromHistory} />
        </div>
      </div>

      {/* Right — slide grid */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className={`grid gap-4 ${slideCount === 3 ? 'grid-cols-3' : slideCount === 5 ? 'grid-cols-5' : 'grid-cols-7'}`}>
          {slides.map(slide => (
            <SlideCard
              key={slide.index}
              slide={slide}
              style={textStyle}
              fontSizePx={fontSizePx}
              onCaptionChange={(idx, val) => updateSlide(idx, { caption: val })}
              onPositionChange={(idx, val) => updateSlide(idx, { position: val })}
              onDelete={idx => resetSlide(idx)}
            />
          ))}
        </div>
        {slides.every(s => s.status === 'idle') && (
          <div className="flex flex-col items-center justify-center h-64 text-muted-foreground mt-8">
            <ImageIcon className="w-16 h-16 opacity-10 mb-3" />
            <p className="text-sm">Click "Generate all slides" to begin</p>
            <p className="text-xs opacity-60 mt-1">Each slide gets a unique pose/angle variation</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Video Mode ───────────────────────────────────────────────

function VideoMode() {
  const [imageUrl, setImageUrl] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState('')
  const [prompt, setPrompt] = useState('')
  const [duration, setDuration] = useState<5 | 10 | 15>(5)
  const [resolution, setResolution] = useState<'480p' | '720p'>('720p')
  const [generating, setGenerating] = useState(false)
  const [videoUrl, setVideoUrl] = useState('')
  const [showHistoryPicker, setShowHistoryPicker] = useState(false)
  const [historyImages, setHistoryImages] = useState<{ url: string; id: string }[]>([])
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const gens = generationsStore.getAll()
    const imgs: { url: string; id: string }[] = []
    for (const g of gens) {
      if (g.status === 'done') {
        for (const u of g.outputUrls) imgs.push({ url: u, id: g.id + u })
      }
    }
    setHistoryImages(imgs.slice(0, 100))
  }, [])

  async function generate() {
    if (!prompt.trim()) { toast.error('Enter a prompt'); return }
    if (!imageUrl.trim() && !imageFile) { toast.error('Upload or paste an image URL'); return }
    setGenerating(true)
    setVideoUrl('')
    try {
      const fd = new FormData()
      fd.append('prompt', prompt.trim())
      fd.append('duration', String(duration))
      fd.append('resolution', resolution)
      if (imageFile) {
        fd.append('file', imageFile)
      } else {
        fd.append('imageUrl', imageUrl.trim())
      }
      const res = await fetch('/api/video-generate', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error ?? 'Failed')
      setVideoUrl(data.url)
      toast.success('Video generated!')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel */}
      <div className="w-80 flex flex-col border-r border-border bg-sidebar/30 shrink-0 overflow-y-auto">
        <div className="px-5 py-5 space-y-4">
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Reference image</p>
            <input ref={fileRef} type="file" accept="image/*" className="hidden"
              onChange={e => {
                const f = e.target.files?.[0]
                if (!f) return
                setImageFile(f)
                setImageUrl('')
                setImagePreview(URL.createObjectURL(f))
              }} />
            <div className="flex gap-1.5">
              <Input placeholder="Image URL..." value={imageUrl}
                onChange={e => { setImageUrl(e.target.value); setImageFile(null); setImagePreview('') }}
                className="text-xs" />
              <Button variant="outline" size="icon" className="h-9 w-9 shrink-0"
                onClick={() => fileRef.current?.click()}>
                <Upload className="w-4 h-4" />
              </Button>
              <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" title="Pick from history"
                onClick={() => setShowHistoryPicker(v => !v)}>
                <Clock className="w-4 h-4" />
              </Button>
            </div>

            {/* History picker */}
            {showHistoryPicker && historyImages.length > 0 && (
              <div className="rounded-lg border border-border bg-card p-2 mt-1">
                <p className="text-[10px] text-muted-foreground mb-2">Pick from history</p>
                <div className="grid grid-cols-4 gap-1.5 max-h-48 overflow-y-auto">
                  {historyImages.map(img => (
                    <button key={img.id}
                      className="aspect-square rounded overflow-hidden border border-border hover:border-primary transition-colors"
                      onClick={() => {
                        setImageUrl(img.url)
                        setImageFile(null)
                        setImagePreview('')
                        setShowHistoryPicker(false)
                      }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.url} alt="" className="w-full h-full object-cover" />
                    </button>
                  ))}
                </div>
              </div>
            )}
            {showHistoryPicker && historyImages.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-3">No history images yet</p>
            )}

            {(imagePreview || imageUrl) && (
              <div className="relative w-full aspect-[9/16] rounded-lg overflow-hidden border border-border bg-secondary/30 mt-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imagePreview || `/api/proxy-image?url=${encodeURIComponent(imageUrl)}`} alt="reference"
                  className="w-full h-full object-cover"
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Prompt</p>
            <Textarea placeholder="Describe the motion — walking towards camera, hair blowing in wind..."
              value={prompt} onChange={e => setPrompt(e.target.value)}
              rows={4} className="text-xs resize-none" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Duration</p>
              <div className="flex gap-1">
                {([5, 10, 15] as const).map(d => (
                  <button key={d} onClick={() => setDuration(d)}
                    className={`flex-1 py-1.5 rounded text-xs font-medium border transition-colors ${duration === d ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                    {d}s
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Resolution</p>
              <div className="flex gap-1">
                {(['480p', '720p'] as const).map(r => (
                  <button key={r} onClick={() => setResolution(r)}
                    className={`flex-1 py-1.5 rounded text-xs font-medium border transition-colors ${resolution === r ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                    {r}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <Button className="w-full" onClick={generate}
            disabled={generating || (!imageUrl.trim() && !imageFile) || !prompt.trim()}>
            {generating
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Generating video (~3-5 min)...</>
              : <><Film className="w-4 h-4 mr-2" />Generate video</>}
          </Button>

          <p className="text-[10px] text-muted-foreground/60">
            WAN 2.6 image-to-video · {duration}s · {resolution} · generation takes 3-5 minutes
          </p>
        </div>
      </div>

      {/* Right panel */}
      <div className="flex-1 flex items-center justify-center p-6">
        {generating && (
          <div className="flex flex-col items-center gap-4 text-muted-foreground">
            <Loader2 className="w-10 h-10 animate-spin text-primary" />
            <p className="text-sm">Generating video...</p>
            <p className="text-xs opacity-60">This takes 3-5 minutes. Keep this tab open.</p>
          </div>
        )}
        {!generating && !videoUrl && (
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <Film className="w-12 h-12 opacity-20" />
            <p className="text-sm">Upload an image and enter a prompt</p>
            <p className="text-xs opacity-60">WAN 2.6 will animate your reference image</p>
          </div>
        )}
        {videoUrl && (
          <div className="flex flex-col items-center gap-4 max-w-sm w-full">
            <video src={videoUrl} controls autoPlay loop
              className="w-full rounded-xl border border-border bg-black" />
            <div className="flex gap-2 w-full">
              <a href={videoUrl} download="generated_video.mp4" className="flex-1">
                <Button variant="outline" className="w-full gap-2">
                  <Download className="w-4 h-4" />Download MP4
                </Button>
              </a>
              <Button variant="outline" className="gap-2" onClick={() => { setVideoUrl(''); setPrompt('') }}>
                <X className="w-4 h-4" />New
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Root Page ────────────────────────────────────────────────

export default function ReelsPage() {
  const searchParams = useSearchParams()
  const [mode, setMode] = useState<PageMode>(() => {
    if (typeof window !== 'undefined') {
      const tab = new URLSearchParams(window.location.search).get('tab')
      if (tab === 'wan') return 'wan'
    }
    return 'generate'
  })
  const [textStyle, setTextStyle] = useState<TextStyle>('white-black')
  const [fontSizePx, setFontSizePx] = useState(DEFAULT_FONT_PX)
  const [defaultPosition, setDefaultPosition] = useState<TextPosition>('bottom')

  useEffect(() => {
    const tab = searchParams.get('tab')
    if (tab === 'wan') setMode('wan')
  }, [searchParams])

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── Top bar ── */}
      <div className="flex items-center gap-4 px-5 py-3 border-b border-border shrink-0 bg-background flex-wrap">
        <div className="flex items-center gap-2">
          <Film className="w-4 h-4 text-muted-foreground" />
          <p className="text-sm font-semibold">Reels / Carousel Generator</p>
        </div>

        {/* Mode tabs */}
        <div className="flex rounded-lg border border-border overflow-hidden text-sm">
          <button
            onClick={() => setMode('generate')}
            className={`px-4 py-1.5 transition-colors ${mode === 'generate' ? 'bg-primary text-primary-foreground font-medium' : 'text-muted-foreground hover:bg-secondary'}`}
          >
            AI Generate
          </button>
          <button
            onClick={() => setMode('wan')}
            className={`px-4 py-1.5 transition-colors ${mode === 'wan' ? 'bg-violet-600 text-white font-medium' : 'text-muted-foreground hover:bg-secondary'}`}
          >
            Poses & Variations
          </button>
          <button
            onClick={() => setMode('csv')}
            className={`px-4 py-1.5 transition-colors ${mode === 'csv' ? 'bg-primary text-primary-foreground font-medium' : 'text-muted-foreground hover:bg-secondary'}`}
          >
            CSV Import
          </button>
          <button
            onClick={() => setMode('video')}
            className={`px-4 py-1.5 transition-colors ${mode === 'video' ? 'bg-orange-600 text-white font-medium' : 'text-muted-foreground hover:bg-secondary'}`}
          >
            Video
          </button>
        </div>

        {/* Global style controls */}
        <div className="flex items-center gap-3 ml-auto flex-wrap">
          <div className="flex items-center gap-2">
            <p className="text-xs text-muted-foreground whitespace-nowrap">Text style</p>
            <Select value={textStyle} onValueChange={v => setTextStyle(v as TextStyle)}>
              <SelectTrigger className="h-8 w-44 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {TEXT_STYLE_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <p className="text-xs text-muted-foreground whitespace-nowrap">Font size (px)</p>
            <Input
              type="number"
              min={12}
              max={300}
              value={fontSizePx}
              onChange={e => setFontSizePx(Math.max(12, Math.min(300, Number(e.target.value) || DEFAULT_FONT_PX)))}
              className="h-8 w-20 text-xs text-center"
            />
          </div>
          <div className="flex items-center gap-2">
            <p className="text-xs text-muted-foreground whitespace-nowrap">Default pos.</p>
            <Select value={defaultPosition} onValueChange={v => setDefaultPosition(v as TextPosition)}>
              <SelectTrigger className="h-8 w-28 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {POSITION_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* ── Content ── */}
      <div className="flex-1 overflow-hidden">
        {mode === 'generate' && <GenerateMode textStyle={textStyle} fontSizePx={fontSizePx} defaultPosition={defaultPosition} />}
        {mode === 'wan' && <WanVariationsMode textStyle={textStyle} fontSizePx={fontSizePx} defaultPosition={defaultPosition} />}
        {mode === 'csv' && <CsvMode defaultStyle={textStyle} defaultFontSizePx={fontSizePx} defaultPosition={defaultPosition} />}
        {mode === 'video' && <VideoMode />}
      </div>
    </div>
  )
}
