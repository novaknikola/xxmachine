'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { generationsStore } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import JSZip from 'jszip'
import {
  Play, Upload, FileText, Info, ChevronDown, X, Clock, Shuffle, Plus, Download,
} from 'lucide-react'
import {
  renderToBlob, TEXT_STYLE_OPTIONS, POSITION_OPTIONS,
  type TextPosition, type TextStyle,
} from '@/lib/canvas-utils'
import { SlideCard, type Slide, type SlideStatus } from '../reels/slide-card'
import { CAROUSEL_PRESETS, getDefaultCarouselPreset, type CarouselPreset } from '@/lib/carousel-presets'

const CHUNK_SIZE = 10
const DEFAULT_FONT_PX = 72

interface CsvRow {
  url: string
  caption: string
  position: TextPosition
  style: TextStyle
  fontSizePx: number
  filename: string
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
              {error}
            </div>
          )}

          {rows.length > 0 && (
            <div className="space-y-2">
              <Button className="w-full" onClick={processBatch} disabled={processing}>
                {processing
                  ? `Processing ${processed}/${rows.length}...`
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

// ─── AI Poses & Variations Mode ────────────────────────────────

type WanPreset = CarouselPreset
const BUILT_IN_PRESETS: WanPreset[] = CAROUSEL_PRESETS

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
  const defaultPreset = getDefaultCarouselPreset()
  const [prompts, setPrompts] = useState<string[]>(defaultPreset.prompts)
  const [promptSuffix, setPromptSuffix] = useState(defaultPreset.suffix)
  const [activePresetId, setActivePresetId] = useState<string>(defaultPreset.id)
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
    const t = setTimeout(() => {
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
    }, 0)
    return () => clearTimeout(t)
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
    if (activePresetId === id) applyPreset(getDefaultCarouselPreset())
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

    const activePrompts = prompts.map((p, i) => ({ prompt: p, index: i })).filter(p => p.prompt.trim())
    if (!activePrompts.length) { toast.error('Add at least one prompt'); setGenerating(false); return }

    setSlides(makeWanSlides(activePrompts.length))

    for (let i = 0; i < activePrompts.length; i++) updateSlide(i, { status: 'generating' })

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
            const res = await fetch('/api/edit-image', { method: 'POST', body: fd })
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

            {baseImageFiles.length === 0 && !baseImageUrl && (
              <button onClick={() => fileUploadRef.current?.click()}
                className="w-full border-2 border-dashed border-border rounded-xl p-4 flex flex-col items-center gap-1.5 hover:border-primary/50 hover:bg-primary/5 transition-colors text-muted-foreground hover:text-foreground">
                <Upload className="w-4 h-4" />
                <span className="text-xs">Upload reference photos</span>
                <span className="text-[10px] opacity-60">Multiple files supported</span>
              </button>
            )}

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
                  <X className="w-4 h-4" />
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
                {analyzingPoses ? 'Analyzing image...' : <><Shuffle className="w-3.5 h-3.5 mr-1.5" />Generate prompts from image</>}
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
              {generating ? `Generating... (${doneCount}/5)` : <><Shuffle className="w-4 h-4 mr-2" />Generate variations</>}
            </Button>
            {doneCount > 0 && !generating && (
              <Button variant="outline" className="w-full border-green-500/40 text-green-400 hover:bg-green-500/10" onClick={downloadZip} disabled={downloading}>
                {downloading ? 'Exporting...' : <><Download className="w-4 h-4 mr-2" />Download ZIP ({doneCount} slides)</>}
              </Button>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
            Seedream image editing — each slide is generated sequentially (~2-3 min each). Keep this tab open.
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
            <p className="text-sm">Add a base image and click &quot;Generate variations&quot;</p>
            <p className="text-xs opacity-60 mt-1">5 different poses/angles via Seedream image editing</p>
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

// ─── Carousel Tab (wraps AI Poses + CSV Import) ────────────────

const SUB_MODES = ['AI Poses', 'CSV Import'] as const
type SubMode = typeof SUB_MODES[number]

export function CarouselTab() {
  const [subMode, setSubMode] = useState<SubMode>('AI Poses')
  const [textStyle, setTextStyle] = useState<TextStyle>('white-black')
  const [fontSizePx, setFontSizePx] = useState(DEFAULT_FONT_PX)
  const [defaultPosition, setDefaultPosition] = useState<TextPosition>('bottom')

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-4 px-5 py-3 border-b border-border shrink-0 bg-background flex-wrap">
        <div className="flex rounded-lg border border-border overflow-hidden text-sm">
          {SUB_MODES.map(m => (
            <button
              key={m}
              onClick={() => setSubMode(m)}
              className={`px-4 py-1.5 transition-colors ${subMode === m ? 'bg-primary text-primary-foreground font-medium' : 'text-muted-foreground hover:bg-secondary'}`}
            >
              {m}
            </button>
          ))}
        </div>

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

      <div className="flex-1 overflow-hidden">
        {subMode === 'AI Poses' && <WanVariationsMode textStyle={textStyle} fontSizePx={fontSizePx} defaultPosition={defaultPosition} />}
        {subMode === 'CSV Import' && <CsvMode defaultStyle={textStyle} defaultFontSizePx={fontSizePx} defaultPosition={defaultPosition} />}
      </div>
    </div>
  )
}
