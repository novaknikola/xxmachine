'use client'

import { useState, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { toast } from 'sonner'
import {
  Play, Square, Loader2, Download, Trash2, FolderDown, Upload, X, RefreshCw,
} from 'lucide-react'
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

const WORKER_CONCURRENCY = 4

function createWorker() {
  return new Worker('/reproduce.worker.js')
}

async function processWithWorker(
  worker: Worker,
  file: File,
  settings: ReproduceSettings,
  seed: number,
): Promise<string> {
  return new Promise(async (resolve, reject) => {
    const taskId = crypto.randomUUID()
    const buf = await file.arrayBuffer()
    const fileData = { buffer: buf, type: file.type || 'image/jpeg' }

    worker.onmessage = (e) => {
      if (e.data.taskId !== taskId) return
      if (e.data.ok) {
        const blob = new Blob([e.data.buffer], { type: e.data.type })
        resolve(URL.createObjectURL(blob))
      } else {
        reject(new Error(e.data.error ?? 'Worker error'))
      }
    }
    worker.onerror = (e) => reject(new Error(e.message))
    worker.postMessage({ taskId, fileData, settings, seed }, [buf])
  })
}

export function ReproduceTab() {
  const [settings, setSettings] = useState<ReproduceSettings>(DEFAULT_REPRODUCE)
  const [sources, setSources] = useState<Array<{ id: string; file: File; url: string }>>([])
  const [variants, setVariants] = useState<ReproduceVariant[]>([])
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
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

  async function run() {
    if (!sources.length) { toast.error('Upload at least one image'); return }
    abortRef.current = false
    const total = sources.length * settings.count
    setRunning(true)
    setProgress({ done: 0, total })
    setVariants([])

    // Build task list
    const tasks: Array<{ src: typeof sources[0]; seed: number }> = []
    for (const src of sources) {
      for (let i = 0; i < settings.count; i++) {
        tasks.push({ src, seed: Math.floor(Math.random() * 0xffffffff) })
      }
    }

    // Spawn workers
    const workerCount = Math.min(WORKER_CONCURRENCY, tasks.length)
    const workers = Array.from({ length: workerCount }, () => createWorker())
    let taskIdx = 0
    let done = 0
    const settingsSnapshot = { ...settings }

    async function workerLoop(worker: Worker) {
      while (taskIdx < tasks.length) {
        if (abortRef.current) break
        const task = tasks[taskIdx++]
        try {
          const url = await processWithWorker(worker, task.src.file, settingsSnapshot, task.seed)
          setVariants(prev => [...prev, {
            id: crypto.randomUUID(), sourceId: task.src.id,
            sourceName: task.src.file.name, url, seed: task.seed,
          }])
        } catch (err) {
          toast.error(`Failed: ${err instanceof Error ? err.message : 'error'}`)
        }
        done++
        setProgress({ done, total })
      }
    }

    await Promise.all(workers.map(w => workerLoop(w)))
    workers.forEach(w => w.terminate())

    setRunning(false)
    if (!abortRef.current) toast.success(`${done} variations ready`)
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
    const content = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(content)
    a.download = `reproduce_${new Date().toISOString().slice(0, 10)}.zip`
    a.click()
    URL.revokeObjectURL(a.href)
    toast.success('ZIP downloaded')
  }

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
                        <img src={src.url} alt="" className="w-full h-full object-cover" />
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
                    <p className="text-xs text-muted-foreground">{sources.length} image(s) · {sources.length * settings.count} total</p>
                    <button className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                      onClick={() => setSources([])}>Clear all</button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Count */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Variations per image</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <input type="range" min={1} max={20} value={settings.count}
                  onChange={e => setSettings(p => ({ ...p, count: Number(e.target.value) }))}
                  className="flex-1 accent-primary" />
                <span className="text-sm font-mono w-6 text-center">{settings.count}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1.5">
                Total: <strong className="text-foreground">{sources.length * settings.count}</strong> variations
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
            {!running ? (
              <Button className="w-full" onClick={run} disabled={!sources.length}>
                <Play className="w-4 h-4 mr-2" />
                Generate {sources.length * settings.count || ''} variations
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button className="flex-1" disabled>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {progress.done}/{progress.total}
                </Button>
                <Button variant="destructive" onClick={() => { abortRef.current = true }}>
                  <Square className="w-4 h-4" />
                </Button>
              </div>
            )}
            {variants.length > 0 && !running && (
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
              <p className="text-xs opacity-60 mt-1">All processing is local — no API calls, no cost</p>
            </div>
          )}
          {variants.length > 0 && (
            <div className="overflow-y-auto max-h-[calc(100vh-220px)] pr-1">
              <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-2">
                {variants.map((v, i) => (
                  <div key={v.id} className="group relative">
                    <div className="aspect-square rounded-lg overflow-hidden border border-border">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={v.url} alt="" className="w-full h-full object-cover" />
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
