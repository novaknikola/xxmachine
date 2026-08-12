'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { toast } from 'sonner'
import {
  Play, Square, Loader2, Download, Trash2, FolderDown, Upload, X, RefreshCw, ListTodo,
} from 'lucide-react'
import { uploadQueueInput } from '@/lib/upload-queue-input'
import {
  DEFAULT_REPRODUCE,
  type ReproduceSettings, type ReproduceVariant, type EffectRange,
} from './reproduce-logic'

const EFFECTS = [
  { key: 'crop',       label: 'Crop',       unit: '%' },
  { key: 'zoom',       label: 'Zoom',       unit: '%' },
  { key: 'rotation',   label: 'Rotation',   unit: '°' },
  { key: 'brightness', label: 'Brightness', unit: ''  },
  { key: 'contrast',   label: 'Contrast',   unit: ''  },
  { key: 'saturation', label: 'Saturation', unit: ''  },
  { key: 'hue',        label: 'Hue shift',  unit: '°' },
  { key: 'grain',      label: 'Grain',      unit: '%' },
  { key: 'vignette',   label: 'Vignette',   unit: '%' },
] as const

export function ReproduceTab() {
  const router = useRouter()
  const [settings, setSettings] = useState<ReproduceSettings>(DEFAULT_REPRODUCE)
  const [sources, setSources] = useState<Array<{ id: string; file: File; url: string }>>([])
  const [variants, setVariants] = useState<ReproduceVariant[]>([])
  const [running, setRunning] = useState(false)
  const [queueing, setQueueing] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [inputFolderId, setInputFolderId] = useState('')
  const [outputFolderId, setOutputFolderId] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef(false)

  function addSources(files: FileList | null) {
    if (!files) return
    setSources(prev => [...prev, ...Array.from(files).map(file => ({
      id: crypto.randomUUID(), file, url: URL.createObjectURL(file),
    }))])
  }

  function patchEffect<K extends keyof ReproduceSettings>(key: K, patch: Partial<ReproduceSettings[K]>) {
    setSettings(prev => ({ ...prev, [key]: { ...(prev[key] as object), ...patch } }))
  }

  // Immediate mode: max 10 per source, blocking, results shown inline
  async function runImmediate() {
    if (!sources.length) { toast.error('Upload at least one image'); return }
    if (settings.count > 10) { toast.error('Immediate mode supports max 10 variants — use Queue for more'); return }
    abortRef.current = false
    const total = sources.length * settings.count
    setRunning(true)
    setProgress({ done: 0, total })
    setVariants([])
    let done = 0
    let succeeded = 0

    for (const src of sources) {
      if (abortRef.current) break
      const fd = new FormData()
      fd.append('file', src.file)
      fd.append('settings', JSON.stringify(settings))
      fd.append('count', String(settings.count))
      fd.append('seed', String(Math.floor(Math.random() * 0xffffff)))

      try {
        const res = await fetch('/api/image-reproduce', { method: 'POST', body: fd })
        const contentType = res.headers.get('content-type') || ''
        const data = contentType.includes('application/json')
          ? await res.json()
          : { error: (await res.text()).slice(0, 500) || `Non-JSON response (${res.status})` }

        if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`)

        const results = Array.isArray(data.results) ? data.results : []
        if (results.length === 0) {
          throw new Error(data.error ?? 'No image variations were generated.')
        }

        for (const r of results) {
          setVariants(prev => [...prev, {
            id: r.id, sourceId: src.id, sourceName: src.file.name,
            url: `/api/image-reproduce?id=${r.id}`, seed: r.seed,
          }])
          done++
          succeeded++
          setProgress({ done, total })
        }
      } catch (err) {
        toast.error(`${src.file.name}: ${err instanceof Error ? err.message : 'error'}`)
        done += settings.count
        setProgress({ done, total })
      }
    }

    setRunning(false)
    if (!abortRef.current && succeeded > 0) {
      toast.success(`${succeeded} variations ready`)
    } else if (!abortRef.current && succeeded === 0) {
      toast.error('No variations were generated. Please check the errors above.')
    }
  }

  // Queue mode: upload to storage, submit background job(s)
  async function submitToQueue() {
    const inputFolder = inputFolderId.trim()
    if (!sources.length && !inputFolder) {
      toast.error('Upload at least one image, or give an input Drive folder')
      return
    }
    setQueueing(true)

    // Drive folder mode: the server lists the folder and fans out one job per
    // image, so there is nothing to upload from here.
    if (inputFolder) {
      try {
        const res = await fetch('/api/queue/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            job_type: 'image_repurpose',
            input: {
              inputDriveFolderId: inputFolder,
              outputDriveFolderId: outputFolderId.trim() || null,
              count: settings.count,
              baseSeed: Math.floor(Math.random() * 0xffffff),
              settings,
            },
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Submit failed')
        const n = (data as { ids?: string[] }).ids?.length ?? 1
        toast.success(`${n} job${n > 1 ? 's' : ''} queued from Drive — processing in background`, {
          action: { label: 'Open Queue', onClick: () => router.push('/captions?tab=queue') },
          duration: 6000,
        })
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Submit failed')
      } finally {
        setQueueing(false)
      }
      return
    }

    let submitted = 0

    for (const src of sources) {
      try {
        toast.loading(`Uploading ${src.file.name}…`, { id: `upload-${src.id}` })
        const { videoUrl: imageUrl, videoName: imageName } = await uploadQueueInput(src.file)
        toast.dismiss(`upload-${src.id}`)

        const res = await fetch('/api/queue/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            job_type: 'image_repurpose',
            input: {
              imageUrl, imageName,
              count: settings.count,
              baseSeed: Math.floor(Math.random() * 0xffffff),
              settings,
              outputDriveFolderId: outputFolderId.trim() || null,
            },
          }),
        })
        if (!res.ok) {
          const e = await res.json().catch(() => ({}))
          throw new Error((e as { error?: string }).error ?? 'Submit failed')
        }
        submitted++
      } catch (err) {
        toast.dismiss(`upload-${src.id}`)
        toast.error(`${src.file.name}: ${err instanceof Error ? err.message : 'error'}`)
      }
    }

    setQueueing(false)
    if (submitted > 0) {
      setSources([])
      toast.success(`${submitted} job${submitted > 1 ? 's' : ''} queued — processing in background`, {
        action: { label: 'Open Queue', onClick: () => router.push('/captions?tab=queue') },
        duration: 6000,
      })
    }
  }

  async function downloadZip() {
    if (!variants.length) return
    const JSZipMod = (await import('jszip')).default
    const zip = new JSZipMod()
    await Promise.all(variants.map(async (v, i) => {
      const blob = await fetch(v.url).then(r => r.blob())
      const name = v.sourceName.replace(/\.[^.]+$/, '')
      zip.file(`${name}_${String(i + 1).padStart(3, '0')}_s${v.seed}.jpg`, blob)
    }))
    // STORE, not DEFLATE — these are already-compressed JPEGs, so deflating
    // them burns CPU for near-zero size gain (the original cause of a
    // ~10-minute wait on large batches).
    const content = await zip.generateAsync({ type: 'blob', compression: 'STORE' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(content)
    a.download = `reproduce_${new Date().toISOString().slice(0, 10)}.zip`
    a.click()
    URL.revokeObjectURL(a.href)
    toast.success('ZIP downloaded')
  }

  const canRunImmediate = settings.count <= 10 && !running && !queueing && sources.length > 0
  const totalVariants = sources.length * settings.count
  const folderMode = inputFolderId.trim().length > 0

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6">

        {/* Left: settings */}
        <div className="space-y-4">

          {/* Upload */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Source images</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
                onChange={e => addSources(e.target.files)} />
              <button onClick={() => fileRef.current?.click()}
                className="w-full border-2 border-dashed border-border rounded-xl p-5 flex flex-col items-center gap-2 hover:border-primary/50 hover:bg-primary/5 transition-colors text-muted-foreground hover:text-foreground">
                <Upload className="w-5 h-5" />
                <span className="text-sm">Upload photos</span>
                <span className="text-xs opacity-60">JPG, PNG — one or many</span>
              </button>
              {sources.length > 0 && (
                <>
                  <div className="grid grid-cols-4 gap-1.5">
                    {sources.slice(0, 12).map(src => (
                      <div key={src.id} className="relative group aspect-square rounded-lg overflow-hidden border border-border">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={src.url} alt="" className="absolute inset-0 w-full h-full object-cover" />
                        <button onClick={() => setSources(prev => prev.filter(s => s.id !== src.id))}
                          className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <X className="w-2.5 h-2.5" />
                        </button>
                      </div>
                    ))}
                    {sources.length > 12 && (
                      <div className="aspect-square rounded-lg border border-dashed border-border flex items-center justify-center bg-secondary/30">
                        <span className="text-xs text-muted-foreground font-mono">+{sources.length - 12}</span>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">{sources.length} image(s) · {totalVariants} total</p>
                    <button className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                      onClick={() => setSources([])}>Clear all</button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Google Drive */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Google Drive</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">
                  Input folder ID <span className="opacity-60">(optional — images, flat)</span>
                </label>
                <input
                  value={inputFolderId}
                  onChange={e => setInputFolderId(e.target.value)}
                  placeholder="folder ID from the Drive URL"
                  className="w-full h-10 px-3 rounded-lg bg-secondary/50 border border-border text-sm font-mono focus:outline-none focus:border-primary/50"
                />
                <p className="text-[10px] text-muted-foreground">
                  Set this and every image in the folder becomes its own job — uploads above are ignored.
                </p>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">
                  Output folder ID <span className="opacity-60">(optional)</span>
                </label>
                <input
                  value={outputFolderId}
                  onChange={e => setOutputFolderId(e.target.value)}
                  placeholder="folder ID from the Drive URL"
                  className="w-full h-10 px-3 rounded-lg bg-secondary/50 border border-border text-sm font-mono focus:outline-none focus:border-primary/50"
                />
                <p className="text-[10px] text-muted-foreground">
                  Leave empty to keep results in the grid below only. Queue mode only.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Count */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Variations per image</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <input type="range" min={1} max={100} value={settings.count}
                  onChange={e => setSettings(p => ({ ...p, count: Number(e.target.value) }))}
                  className="flex-1 accent-primary" />
                <span className="text-sm font-mono w-8 text-center">{settings.count}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1.5">
                Total: <strong className="text-foreground">{totalVariants}</strong> variations
                {settings.count > 10 && <span className="text-amber-400/80"> · &gt;10 needs Queue</span>}
              </p>
            </CardContent>
          </Card>

          {/* Effects */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Effects</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {EFFECTS.map(({ key, label, unit }) => {
                const effect = settings[key] as EffectRange
                return (
                  <div key={key} className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium flex items-center gap-2">
                        <input type="checkbox" checked={effect.enabled}
                          onChange={e => patchEffect(key, { enabled: e.target.checked })}
                          className="accent-primary" />
                        {label}
                      </label>
                      {effect.enabled && (
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {effect.min}{unit} → {effect.max}{unit}
                        </span>
                      )}
                    </div>
                    {effect.enabled && (
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-0.5">
                          <p className="text-[10px] text-muted-foreground">Min</p>
                          <Input type="number" value={effect.min} step={1}
                            onChange={e => patchEffect(key, { min: Number(e.target.value) })}
                            className="h-7 text-xs" />
                        </div>
                        <div className="space-y-0.5">
                          <p className="text-[10px] text-muted-foreground">Max</p>
                          <Input type="number" value={effect.max} step={1}
                            onChange={e => patchEffect(key, { max: Number(e.target.value) })}
                            className="h-7 text-xs" />
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
              <div className="flex items-center gap-2 pt-1">
                <input type="checkbox" id="repFlipH" checked={settings.flipH}
                  onChange={e => setSettings(p => ({ ...p, flipH: e.target.checked }))}
                  className="accent-primary" />
                <label htmlFor="repFlipH" className="text-xs font-medium">Random horizontal flip</label>
              </div>
            </CardContent>
          </Card>

          {/* Actions */}
          <div className="space-y-2">
            {!running && !queueing ? (
              <div className="flex gap-2">
                <Button className="flex-1" onClick={runImmediate} disabled={!canRunImmediate}
                  title={
                    folderMode
                      ? 'Immediate mode needs an upload — a Drive folder only works with Queue'
                      : settings.count > 10 ? 'Max 10 for immediate run — use Queue' : undefined
                  }>
                  <Play className="w-4 h-4 mr-2" />
                  Run {settings.count <= 10 ? totalVariants : '(≤10 only)'}
                </Button>
                <Button variant="secondary" className="flex-1" onClick={submitToQueue}
                  disabled={!sources.length && !inputFolderId.trim()}>
                  <ListTodo className="w-4 h-4 mr-2" />
                  {inputFolderId.trim() ? `Queue folder ×${settings.count}` : `Queue ${totalVariants > 0 ? totalVariants : ''}`}
                </Button>
              </div>
            ) : running ? (
              <div className="flex gap-2">
                <Button className="flex-1" disabled>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {progress.done}/{progress.total}
                </Button>
                <Button variant="destructive" onClick={() => { abortRef.current = true }}>
                  <Square className="w-4 h-4" />
                </Button>
              </div>
            ) : (
              <Button className="w-full" disabled>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Uploading to queue…
              </Button>
            )}
            {folderMode && !sources.length && !running && !queueing && (
              <p className="text-[10px] text-amber-400/80">
                Drive folder is set — Run needs an upload instead, use Queue for the folder.
              </p>
            )}
            {variants.length > 0 && !running && !queueing && (
              <Button variant="outline" className="w-full" onClick={downloadZip}>
                <FolderDown className="w-4 h-4 mr-2" />Download ZIP ({variants.length})
              </Button>
            )}
            {variants.length > 0 && (
              <Button variant="ghost" className="w-full text-xs text-muted-foreground"
                onClick={() => { setVariants([]); setSources([]) }}>
                <Trash2 className="w-3.5 h-3.5 mr-1.5" />Clear all
              </Button>
            )}
          </div>
        </div>

        {/* Right: results */}
        <div>
          {running && (
            <div className="mb-4 space-y-1">
              <div className="h-2 rounded-full bg-secondary overflow-hidden">
                <div className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%` }} />
              </div>
              <p className="text-xs text-muted-foreground text-right">{progress.done} / {progress.total}</p>
            </div>
          )}
          {variants.length === 0 && !running && (
            <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
              <RefreshCw className="w-10 h-10 mb-3 opacity-20" />
              <p className="text-sm">Upload photos and generate variations</p>
              <p className="text-xs opacity-60 mt-1">Run ≤10 inline · Queue any amount in the background, straight to Drive</p>
            </div>
          )}
          {variants.length > 0 && (
            <div className="overflow-y-auto max-h-[calc(100vh-220px)] pr-1">
              <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-2">
                {variants.map((v, i) => (
                  <div key={v.id} className="group relative">
                    <div className="relative aspect-square rounded-lg overflow-hidden border border-border">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={v.url} alt="" className="absolute inset-0 w-full h-full object-cover" />
                    </div>
                    <p className="text-[9px] text-muted-foreground/50 mt-0.5 text-center font-mono truncate">
                      #{i + 1} · {v.seed.toString(16).slice(-6)}
                    </p>
                    <a href={v.url} download={`var_${i + 1}_s${v.seed}.jpg`}
                      onClick={e => e.stopPropagation()}
                      className="absolute top-1 left-1 w-5 h-5 rounded bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <Download className="w-2.5 h-2.5" />
                    </a>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
