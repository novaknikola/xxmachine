'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { charactersStore, generationsStore } from '@/lib/store'
import { Character } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
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
  Upload,
  Film,
  ChevronDown,
  X,
  Clock,
  Shuffle,
} from 'lucide-react'

import {
  renderToBlob,
  renderAugmented,
  randomTransform,
  TEXT_STYLE_OPTIONS,
  POSITION_OPTIONS,
  SLIDE_VARIATIONS as VARIATIONS_IMPORT,
  TextPosition,
  TextStyle,
} from '@/lib/canvas-utils'
import { SlideCard, type Slide, type SlideStatus } from './slide-card'

// ─── Types ────────────────────────────────────────────────────

type PageMode = 'generate' | 'video'

interface HistoryEntry {
  id: string
  seriesName: string
  characterName: string
  slideCount: number
  imageUrls: string[]
  captions: string[]
  createdAt: string
}

// ─── Constants ────────────────────────────────────────────────

const VARIATIONS = VARIATIONS_IMPORT

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

// ─── History panel ────────────────────────────────────────────

function HistoryPanel({ onRestore }: { onRestore: (entry: HistoryEntry) => void }) {
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setEntries(getHistory()), 0)
    return () => clearTimeout(t)
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
    const t = setTimeout(() => {
      const chars = charactersStore.getAll()
      setCharacters(chars)
      if (chars.length) setCharacterId(chars[0].id)
    }, 0)
    return () => clearTimeout(t)
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
            // Without these the Drive archive has no character to file under
            // and everything lands in _unsorted/.
            characterId,
            characterName: character.name,
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
            <p className="text-sm">Click &quot;Generate all slides&quot; to begin</p>
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
    const t = setTimeout(() => {
      const gens = generationsStore.getAll()
      const imgs: { url: string; id: string }[] = []
      for (const g of gens) {
        if (g.status === 'done') {
          for (const u of g.outputUrls) imgs.push({ url: u, id: g.id + u })
        }
      }
      setHistoryImages(imgs.slice(0, 100))
    }, 0)
    return () => clearTimeout(t)
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
                  className="absolute inset-0 w-full h-full object-cover"
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
  const [mode, setMode] = useState<PageMode>('generate')
  const [textStyle, setTextStyle] = useState<TextStyle>('white-black')
  const [fontSizePx, setFontSizePx] = useState(DEFAULT_FONT_PX)
  const [defaultPosition, setDefaultPosition] = useState<TextPosition>('bottom')

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
          {/* Video mode hidden for now — VideoMode component and its render slot below are kept intact */}
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
        {mode === 'video' && <VideoMode />}
      </div>
    </div>
  )
}
