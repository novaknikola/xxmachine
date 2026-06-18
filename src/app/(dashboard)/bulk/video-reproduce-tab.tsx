'use client'

import { useState, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { toast } from 'sonner'
import { Play, Square, Loader2, Download, Trash2, FolderDown, Upload, X } from 'lucide-react'

interface VideoVariant {
  id: string
  sourceName: string
  seed: number
  streamUrl: string  // /api/video-reproduce?id=...
}

interface VideoEffects {
  brightness: boolean
  contrast: boolean
  saturation: boolean
  hue: boolean
  speed: boolean
  flipH: boolean
  crop: boolean
}

const DEFAULT_EFFECTS: VideoEffects = {
  brightness: true,
  contrast: true,
  saturation: true,
  hue: false,
  speed: false,
  flipH: false,
  crop: true,
}

export function VideoReproduceTab() {
  const [sources, setSources] = useState<Array<{ id: string; file: File; name: string }>>([])
  const [effects, setEffects] = useState<VideoEffects>(DEFAULT_EFFECTS)
  const [count, setCount] = useState(3)
  const [variants, setVariants] = useState<VideoVariant[]>([])
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const fileRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef(false)

  function addSources(files: FileList | null) {
    if (!files) return
    setSources(prev => [...prev, ...Array.from(files).map(file => ({
      id: crypto.randomUUID(), file, name: file.name,
    }))])
  }

  function toggleEffect(key: keyof VideoEffects) {
    setEffects(prev => ({ ...prev, [key]: !prev[key] }))
  }

  async function run() {
    if (!sources.length) { toast.error('Upload at least one video'); return }
    abortRef.current = false
    const total = sources.length * count
    setRunning(true)
    setProgress({ done: 0, total })
    setVariants([])
    let done = 0

    for (const src of sources) {
      if (abortRef.current) break
      const fd = new FormData()
      fd.append('file', src.file)
      fd.append('count', String(count))
      fd.append('seed', String(Math.floor(Math.random() * 0xffffffff)))
      Object.entries(effects).forEach(([k, v]) => fd.append(k, String(v)))

      try {
        const res = await fetch('/api/video-reproduce', { method: 'POST', body: fd })
        const contentType = res.headers.get('content-type') || ''
        const data = contentType.includes('application/json')
          ? await res.json()
          : { error: (await res.text()).slice(0, 500) || `Non-JSON response (${res.status})` }

        if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`)

        const results = Array.isArray(data.results) ? data.results : []
        if (results.length === 0) {
          throw new Error(data.error ?? 'No video variations were generated.')
        }

        for (const r of results) {
          setVariants(prev => [...prev, {
            id: r.id,
            sourceName: src.name,
            seed: r.seed,
            streamUrl: `/api/video-reproduce?id=${r.id}`,
          }])
          done++
          setProgress({ done, total })
        }
      } catch (err) {
        toast.error(`${src.name}: ${err instanceof Error ? err.message : 'error'}`)
        done += count
        setProgress({ done, total })
      }
    }

    setRunning(false)
    if (!abortRef.current && done > 0) {
      toast.success(`${done} video variations ready`)
    } else if (!abortRef.current && done === 0) {
      toast.error('No video variations were generated. Please check the error above.')
    }
  }

  async function downloadAll() {
    const JSZipMod = (await import('jszip')).default
    const zip = new JSZipMod()
    await Promise.all(variants.map(async (v, i) => {
      try {
        const blob = await fetch(v.streamUrl).then(r => r.blob())
        const name = v.sourceName.replace(/\.[^.]+$/, '')
        zip.file(`${name}_${String(i + 1).padStart(3, '0')}.mp4`, blob)
      } catch {}
    }))
    const content = await zip.generateAsync({ type: 'blob' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(content)
    a.download = `video_reproduce_${new Date().toISOString().slice(0, 10)}.zip`
    a.click()
    URL.revokeObjectURL(a.href)
    toast.success('ZIP downloaded')
  }

  const EFFECT_LABELS: Record<keyof VideoEffects, string> = {
    brightness: 'Brightness',
    contrast: 'Contrast',
    saturation: 'Saturation',
    hue: 'Hue shift',
    speed: 'Speed ±3%',
    flipH: 'Random flip',
    crop: 'Slight crop',
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6">
        {/* Left */}
        <div className="space-y-4">

          {/* Upload */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Source videos</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <input ref={fileRef} type="file" accept="video/*" multiple className="hidden"
                onChange={e => addSources(e.target.files)} />
              <button onClick={() => fileRef.current?.click()}
                className="w-full border-2 border-dashed border-border rounded-xl p-5 flex flex-col items-center gap-2 hover:border-primary/50 hover:bg-primary/5 transition-colors text-muted-foreground hover:text-foreground">
                <Upload className="w-5 h-5" />
                <span className="text-sm">Upload videos</span>
                <span className="text-xs opacity-60">MP4, MOV — one or many</span>
              </button>
              {sources.length > 0 && (
                <>
                  <div className="space-y-1.5">
                    {sources.map(src => (
                      <div key={src.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-secondary/50 text-xs">
                        <span className="flex-1 truncate">{src.name}</span>
                        <button onClick={() => setSources(prev => prev.filter(s => s.id !== src.id))}
                          className="text-muted-foreground hover:text-destructive">
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-between items-center">
                    <p className="text-xs text-muted-foreground">{sources.length} video(s) · {sources.length * count} total</p>
                    <button className="text-xs text-muted-foreground hover:text-destructive" onClick={() => setSources([])}>Clear all</button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Count */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Variations per video</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <input type="range" min={1} max={10} value={count}
                  onChange={e => setCount(Number(e.target.value))}
                  className="flex-1 accent-primary" />
                <span className="text-sm font-mono w-4 text-center">{count}</span>
              </div>
            </CardContent>
          </Card>

          {/* Effects */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Effects</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {(Object.keys(DEFAULT_EFFECTS) as Array<keyof VideoEffects>).map(key => (
                <label key={key} className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={effects[key]}
                    onChange={() => toggleEffect(key)}
                    className="accent-primary" />
                  <span className="text-xs font-medium">{EFFECT_LABELS[key]}</span>
                </label>
              ))}
              <p className="text-[10px] text-muted-foreground pt-1">
                Processed server-side with FFmpeg. Each variant is unique.
              </p>
            </CardContent>
          </Card>

          {/* Actions */}
          <div className="space-y-2">
            {!running ? (
              <Button className="w-full" onClick={run} disabled={!sources.length}>
                <Play className="w-4 h-4 mr-2" />
                Generate {sources.length * count || ''} variations
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
              <Button variant="outline" className="w-full" onClick={downloadAll}>
                <FolderDown className="w-4 h-4 mr-2" />Download all ZIP ({variants.length})
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

        {/* Right — results */}
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
              <Upload className="w-10 h-10 mb-3 opacity-20" />
              <p className="text-sm">Upload videos and generate variations</p>
              <p className="text-xs opacity-60 mt-1">FFmpeg applies random filters server-side</p>
            </div>
          )}

          {variants.length > 0 && (
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 overflow-y-auto max-h-[calc(100vh-220px)] pr-1">
              {variants.map((v, i) => (
                <div key={v.id} className="space-y-2">
                  <video src={v.streamUrl} controls loop muted
                    className="w-full rounded-lg border border-border bg-black aspect-[9/16] object-contain" />
                  <div className="flex items-center justify-between">
                    <p className="text-[9px] text-muted-foreground font-mono">#{i + 1} · {v.seed.toString(16).slice(-6)}</p>
                    <a href={v.streamUrl} download={`video_${i + 1}.mp4`}
                      className="text-muted-foreground hover:text-foreground transition-colors">
                      <Download className="w-3.5 h-3.5" />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
