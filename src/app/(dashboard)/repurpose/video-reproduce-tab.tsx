'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { toast } from 'sonner'
import {
  Play, Square, Loader2, Download, Trash2, FolderDown,
  Upload, X, ListTodo,
} from 'lucide-react'
import { uploadQueueInput } from '@/lib/upload-queue-input'
import { pollQueueJob } from '@/lib/poll-queue-job'
import { DEFAULT_VIDEO_RANGES, type VideoEffectRanges, type VideoEffectRange } from '@/lib/video-effect-ranges'

interface VideoVariant {
  id: string
  sourceName: string
  seed: number
  streamUrl: string
}

interface VideoEffects {
  brightness: boolean
  contrast: boolean
  saturation: boolean
  hue: boolean
  speed: boolean
  flipH: boolean
  crop: boolean
  fade: boolean
}

const DEFAULT_EFFECTS: VideoEffects = {
  brightness: true,
  contrast: true,
  saturation: true,
  hue: false,
  speed: false,
  flipH: false,
  crop: true,
  fade: false,
}

const EFFECT_LABELS: Record<keyof VideoEffects, string> = {
  brightness: 'Brightness',
  contrast: 'Contrast',
  saturation: 'Saturation',
  hue: 'Hue shift',
  speed: 'Speed ±3%',
  flipH: 'Random flip',
  crop: 'Slight crop',
  fade: 'Fade in/out',
}

const PRESETS = [10, 20, 50, 100] as const

/** Effects with a user-adjustable min/max — flipH and fade stay plain toggles. */
const RANGE_EFFECTS: Array<{ key: keyof VideoEffectRanges; label: string; step: number }> = [
  { key: 'brightness', label: 'Brightness range', step: 0.01 },
  { key: 'contrast', label: 'Contrast range', step: 0.01 },
  { key: 'saturation', label: 'Saturation range', step: 0.01 },
  { key: 'hue', label: 'Hue shift range (°)', step: 1 },
  { key: 'speed', label: 'Speed range', step: 0.01 },
  { key: 'crop', label: 'Crop range (0-1)', step: 0.01 },
]

export function VideoReproduceTab() {
  const router = useRouter()
  const [sources, setSources] = useState<Array<{ id: string; file: File; name: string }>>([])
  const [effects, setEffects] = useState<VideoEffects>(DEFAULT_EFFECTS)
  const [ranges, setRanges] = useState<VideoEffectRanges>(DEFAULT_VIDEO_RANGES)
  const [count, setCount] = useState(10)
  const [variants, setVariants] = useState<VideoVariant[]>([])
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
      id: crypto.randomUUID(), file, name: file.name,
    }))])
  }

  function toggleEffect(key: keyof VideoEffects) {
    setEffects(prev => ({ ...prev, [key]: !prev[key] }))
  }

  function patchRange(key: keyof VideoEffectRanges, patch: Partial<VideoEffectRange>) {
    setRanges(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }))
  }

  // Immediate mode: max 10 per source, results shown inline. Submitted through
  // the same queue path Queue mode uses (short upload, short submit, then
  // polled to completion) instead of one long blocking POST — that request
  // held a single connection open through the whole upload plus every
  // sequential ffmpeg pass, and a client network that couldn't sustain it
  // killed the request outright (nginx logged bare 499s: the browser side
  // closing the socket, not a server error or crash). No request in this path
  // stays open more than a couple of seconds, so there is nothing left for a
  // flaky connection to drop mid-flight.
  async function runImmediate() {
    if (!sources.length) { toast.error('Upload at least one video'); return }
    if (count > 10) { toast.error('Immediate mode supports max 10 variants — use Queue for more'); return }
    abortRef.current = false
    const total = sources.length * count
    setRunning(true)
    setProgress({ done: 0, total })
    setVariants([])
    let doneItems = 0
    let succeeded = 0

    for (let srcIdx = 0; srcIdx < sources.length; srcIdx++) {
      const src = sources[srcIdx]!
      if (abortRef.current) break
      const baseDone = srcIdx * count

      try {
        toast.loading(`Uploading ${src.name}…`, { id: `run-${src.id}` })
        const { videoUrl, videoName } = await uploadQueueInput(src.file)
        const baseSeed = Math.floor(Math.random() * 0xffffff)

        const submitRes = await fetch('/api/queue/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            job_type: 'video_repurpose',
            input: { videoUrl, videoName, count, baseSeed, effects, effectRanges: ranges },
          }),
        })
        const submitData = await submitRes.json().catch(() => ({}))
        if (!submitRes.ok) throw new Error((submitData as { error?: string }).error ?? 'Submit failed')
        const jobId = (submitData as { id?: string }).id
        if (!jobId) throw new Error('Submit did not return a job id')
        toast.dismiss(`run-${src.id}`)

        const job = await pollQueueJob(
          jobId,
          d => setProgress({ done: baseDone + d, total }),
          () => abortRef.current,
        )
        doneItems = baseDone + count
        if (!job) break // stopped by the user

        const rawUrls = job.output?.urls ?? []
        rawUrls.forEach((url, i) => {
          if (url.startsWith('error:')) return
          succeeded++
          setVariants(prev => [...prev, {
            id: `${jobId}-${i}`,
            sourceName: src.name,
            seed: baseSeed + i * 1337,
            streamUrl: url,
          }])
        })
        if (!rawUrls.some(u => !u.startsWith('error:'))) {
          const firstError = rawUrls.find(u => u.startsWith('error:'))
          throw new Error(firstError ? firstError.replace(/^error:/, '') : 'No video variations were generated.')
        }
      } catch (err) {
        toast.dismiss(`run-${src.id}`)
        toast.error(`${src.name}: ${err instanceof Error ? err.message : 'error'}`)
        doneItems = baseDone + count
      }
      setProgress({ done: doneItems, total })
    }

    setRunning(false)
    if (!abortRef.current && succeeded > 0) {
      toast.success(`${succeeded} video variations ready`)
    } else if (!abortRef.current && succeeded === 0) {
      toast.error('No video variations were generated. Please check the errors above.')
    }
  }

  // Queue mode: upload to storage, submit background job(s)
  async function submitToQueue() {
    const inputFolder = inputFolderId.trim()
    if (!sources.length && !inputFolder) {
      toast.error('Upload at least one video, or give an input Drive folder')
      return
    }
    setQueueing(true)

    // Drive folder mode: the server lists the folder and fans out one job per
    // video, so there is nothing to upload from here.
    if (inputFolder) {
      try {
        const res = await fetch('/api/queue/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            job_type: 'video_repurpose',
            input: {
              inputDriveFolderId: inputFolder,
              outputDriveFolderId: outputFolderId.trim() || null,
              count,
              baseSeed: Math.floor(Math.random() * 0xffffff),
              effects,
              effectRanges: ranges,
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
        toast.loading(`Uploading ${src.name}…`, { id: `upload-${src.id}` })
        const { videoUrl, videoName } = await uploadQueueInput(src.file)
        toast.dismiss(`upload-${src.id}`)

        const res = await fetch('/api/queue/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            job_type: 'video_repurpose',
            input: {
              videoUrl,
              videoName,
              count,
              baseSeed: Math.floor(Math.random() * 0xffffff),
              effects,
              effectRanges: ranges,
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
        toast.error(`${src.name}: ${err instanceof Error ? err.message : 'error'}`)
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

  // A plain <a download> only forces a save for a same-origin href — streamUrl
  // is now a Supabase storage URL, so fetch it to a blob first (same trick
  // downloadAll already uses for the ZIP).
  async function downloadVariant(v: VideoVariant, i: number) {
    try {
      const blob = await fetch(v.streamUrl).then(r => r.blob())
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `video_${i + 1}.mp4`
      a.click()
      URL.revokeObjectURL(a.href)
    } catch {
      toast.error('Download failed')
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

  const canRunImmediate = count <= 10 && !running && !queueing && sources.length > 0
  const totalVariants = sources.length * count
  const folderMode = inputFolderId.trim().length > 0

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6">
        {/* Left panel */}
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
                    <p className="text-xs text-muted-foreground">{sources.length} file(s) · {totalVariants} total</p>
                    <button className="text-xs text-muted-foreground hover:text-destructive" onClick={() => setSources([])}>
                      Clear all
                    </button>
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
                  Input folder ID <span className="opacity-60">(optional — videos, flat)</span>
                </label>
                <input
                  value={inputFolderId}
                  onChange={e => setInputFolderId(e.target.value)}
                  placeholder="folder ID from the Drive URL"
                  className="w-full h-10 px-3 rounded-lg bg-secondary/50 border border-border text-sm font-mono focus:outline-none focus:border-primary/50"
                />
                <p className="text-[10px] text-muted-foreground">
                  Set this and every video in the folder becomes its own job — uploads above are ignored.
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
                  Leave empty to keep the dated archive tree. Queue mode only.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Variations count */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Variations per video</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Presets */}
              <div className="flex gap-1.5">
                {PRESETS.map(preset => (
                  <button
                    key={preset}
                    onClick={() => setCount(preset)}
                    className={`flex-1 text-xs font-semibold py-1.5 rounded-lg border transition-colors ${
                      count === preset
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
                    }`}
                  >
                    {preset}x
                  </button>
                ))}
              </div>
              {/* Slider */}
              <div className="flex items-center gap-3">
                <input
                  type="range" min={1} max={100} value={count}
                  onChange={e => setCount(Number(e.target.value))}
                  className="flex-1 accent-primary"
                />
                <span className="text-sm font-mono w-8 text-center">{count}</span>
              </div>
              {count > 10 && (
                <p className="text-[10px] text-amber-400/80">
                  &gt;10 variants — use Queue (background processing)
                </p>
              )}
            </CardContent>
          </Card>

          {/* Effects */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Effects</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {(Object.keys(DEFAULT_EFFECTS) as Array<keyof VideoEffects>).map(key => {
                const range = RANGE_EFFECTS.find(r => r.key === key)
                return (
                  <div key={key} className="space-y-1.5">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={effects[key]}
                        onChange={() => toggleEffect(key)}
                        className="accent-primary" />
                      <span className="text-xs font-medium">{EFFECT_LABELS[key]}</span>
                    </label>
                    {range && effects[key] && (
                      <div className="grid grid-cols-2 gap-2 pl-6">
                        <div className="space-y-0.5">
                          <p className="text-[10px] text-muted-foreground">{range.label} — min</p>
                          <Input type="number" step={range.step} value={ranges[range.key].min}
                            onChange={e => patchRange(range.key, { min: Number(e.target.value) })}
                            className="h-7 text-xs" />
                        </div>
                        <div className="space-y-0.5">
                          <p className="text-[10px] text-muted-foreground">{range.label} — max</p>
                          <Input type="number" step={range.step} value={ranges[range.key].max}
                            onChange={e => patchRange(range.key, { max: Number(e.target.value) })}
                            className="h-7 text-xs" />
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
              <p className="text-[10px] text-muted-foreground pt-1">
                FFmpeg processes each variant with unique randomized parameters within these ranges.
              </p>
            </CardContent>
          </Card>

          {/* Actions */}
          <div className="space-y-2">
            {!running && !queueing ? (
              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  onClick={runImmediate}
                  disabled={!sources.length || count > 10}
                  title={
                    folderMode
                      ? 'Immediate mode needs an upload — a Drive folder only works with Queue'
                      : count > 10 ? 'Max 10 for immediate run — use Queue' : undefined
                  }
                >
                  <Play className="w-4 h-4 mr-2" />
                  Run {count <= 10 ? `${totalVariants}` : '(≤10 only)'}
                </Button>
                <Button
                  variant="secondary"
                  className="flex-1"
                  onClick={submitToQueue}
                  disabled={!sources.length && !inputFolderId.trim()}
                >
                  <ListTodo className="w-4 h-4 mr-2" />
                  {inputFolderId.trim()
                    ? `Queue folder ×${count}`
                    : `Queue ${totalVariants > 0 ? totalVariants : ''}`}
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

        {/* Right — inline results (quick mode only) */}
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
              <p className="text-xs opacity-60 mt-1">Run ≤10 inline · Queue up to 100 in background</p>
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
                    <button
                      onClick={() => downloadVariant(v, i)}
                      className="text-muted-foreground hover:text-foreground transition-colors">
                      <Download className="w-3.5 h-3.5" />
                    </button>
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
