'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { charactersStore, generationsStore } from '@/lib/store'
import { Character, GenerationRow, DIMENSIONS } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toast } from 'sonner'
import {
  Layers, Play, Square, CheckCircle2, XCircle, Loader2,
  Download, Trash2, RotateCcw, Info, ChevronDown, ExternalLink,
  FolderDown, Upload, Cpu, Database, Plus, X, RefreshCw, HelpCircle,
} from 'lucide-react'
import { PromptHelpDialog } from './prompt-library'
import { ReproduceTab } from './reproduce-tab'
import { GenerateTab } from './generate-tab'
import { VideoReproduceTab } from './video-reproduce-tab'

// ─── Types ────────────────────────────────────────────────────

type JobStatus = 'pending' | 'processing' | 'done' | 'error' | 'skipped'

interface BulkJob {
  id: string; characterId: string; characterName: string; prompt: string
  dimension: string; status: JobStatus; outputUrls: string[]
  error?: string; startedAt?: string; finishedAt?: string
}

interface DatasetImage {
  id: string; url: string; prompt: string; selected: boolean
}

interface LoraRow {
  id: string; name: string; trigger_word: string | null
  lora_url: string | null; status: 'training' | 'ready' | 'failed'
  steps: number; learning_rate: number; lora_rank: number
  wavespeed_request_id: string | null; error_message: string | null
  created_at: string
}

const CONCURRENCY = 2
const TAB_LABELS = ['Image Generate', 'Dataset', 'Train LoRA', 'Bulk Generate', 'Img Reproduce', 'Video Reproduce'] as const
type Tab = typeof TAB_LABELS[number]

// ─── Helpers ─────────────────────────────────────────────────

function StatusIcon({ status }: { status: JobStatus }) {
  if (status === 'processing') return <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400" />
  if (status === 'done') return <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
  if (status === 'error') return <XCircle className="w-3.5 h-3.5 text-red-400" />
  if (status === 'skipped') return <RotateCcw className="w-3.5 h-3.5 text-yellow-400" />
  return <div className="w-3.5 h-3.5 rounded-full border border-muted-foreground/40" />
}

function StatusBadge({ status }: { status: JobStatus }) {
  const map: Record<JobStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
    pending: { label: 'Waiting', variant: 'outline' },
    processing: { label: 'Generating...', variant: 'default' },
    done: { label: 'Done', variant: 'secondary' },
    error: { label: 'Error', variant: 'destructive' },
    skipped: { label: 'Skipped', variant: 'outline' },
  }
  const { label, variant } = map[status]
  return (
    <Badge variant={variant} className="text-xs gap-1">
      <StatusIcon status={status} />
      {label}
    </Badge>
  )
}

// ─── Main Page ────────────────────────────────────────────────

export default function BulkPage() {
  const { user } = useAuth()
  const [tab, setTab] = useState<Tab>('Image Generate')
  const [characters, setCharacters] = useState<Character[]>([])
  const [loras, setLoras] = useState<LoraRow[]>([])

  const [showPromptHelp, setShowPromptHelp] = useState(false)

  // ── Dataset state ────────────────────────────────────────────
  const [refImages, setRefImages] = useState<Array<{ id: string; file: File; url: string }>>([])
  const [datasetPrompts, setDatasetPrompts] = useState('')
  const [datasetSize, setDatasetSize] = useState('1:1')
  const [datasetImages, setDatasetImages] = useState<DatasetImage[]>([])
  const [datasetRunning, setDatasetRunning] = useState(false)
  const [datasetProgress, setDatasetProgress] = useState({ done: 0, total: 0 })
  const [datasetHistory, setDatasetHistory] = useState<GenerationRow[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const datasetAbortRef = useRef(false)

  // ── Train state ──────────────────────────────────────────────
  const [trainName, setTrainName] = useState('')
  const [trainTrigger, setTrainTrigger] = useState('')
  const [trainSteps, setTrainSteps] = useState(1000)
  const [trainLr, setTrainLr] = useState(0.0001)
  const [trainRank, setTrainRank] = useState(16)
  const [training, setTraining] = useState(false)
  const [trainPollingId, setTrainPollingId] = useState<string | null>(null)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Bulk generate state ──────────────────────────────────────
  const [selectedCharIds, setSelectedCharIds] = useState<string[]>([])
  const [promptsRaw, setPromptsRaw] = useState('')
  const [dimension, setDimension] = useState('9:16')
  const [jobs, setJobs] = useState<BulkJob[]>([])
  const [running, setRunning] = useState(false)
  const [expandedJobs, setExpandedJobs] = useState<Set<string>>(new Set())
  const abortRef = useRef(false)
  const [zipping, setZipping] = useState<string | null>(null)
  const [bulkLoraUrl, setBulkLoraUrl] = useState('')
  const [bulkLoraScale, setBulkLoraScale] = useState(0.8)

  const loadLoras = useCallback(async () => {
    const res = await fetch('/api/loras').catch(() => null)
    if (res?.ok) { const d = await res.json(); setLoras(d.loras ?? []) }
  }, [])

  function loadDatasetHistory() {
    setDatasetHistory(generationsStore.getAll().filter(r => r.kind === 'wan_edit'))
  }

  function clearDatasetHistory() {
    generationsStore.save(generationsStore.getAll().filter(r => r.kind !== 'wan_edit'))
    setDatasetHistory([])
  }

  useEffect(() => {
    setCharacters(charactersStore.getAll())
    loadLoras()
    loadDatasetHistory()
  }, [loadLoras])

  // ─────────────────────────────────────────────────────────────
  // REPRODUCE TAB
  // ─────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────
  // DATASET TAB
  // ─────────────────────────────────────────────────────────────

  function addRefImages(files: FileList | null) {
    if (!files) return
    const newImgs = Array.from(files).map(file => ({
      id: crypto.randomUUID(), file, url: URL.createObjectURL(file),
    }))
    setRefImages(prev => [...prev, ...newImgs])
  }

  async function generateDataset() {
    const prompts = datasetPrompts.split('\n').map(l => l.trim()).filter(Boolean)
    if (prompts.length === 0) { toast.error('Add at least one prompt'); return }
    if (refImages.length === 0) { toast.error('Upload at least one reference image'); return }

    // Each prompt uses one reference image (cycling through the set)
    // 3 prompts × 10 refs = 3 dataset images (not 30)
    const total = prompts.length
    datasetAbortRef.current = false
    setDatasetRunning(true)
    setDatasetProgress({ done: 0, total })
    setDatasetImages([])

    let done = 0
    for (let i = 0; i < prompts.length; i++) {
      if (datasetAbortRef.current) break
      const prompt = prompts[i]
      const ref = refImages[i % refImages.length] // cycle through references
      try {
        const fd = new FormData()
        fd.append('file', ref.file)
        fd.append('prompt', prompt)
        fd.append('size', datasetSize)
        const res = await fetch('/api/wan-edit', { method: 'POST', body: fd })
        const data = await res.json()
        if (!res.ok || !data.urls?.length) throw new Error(data.error ?? 'Failed')
        const rowId = crypto.randomUUID()
        setDatasetImages(prev => [...prev, {
          id: rowId, url: data.urls[0], prompt, selected: true,
        }])
        generationsStore.add({
          id: rowId,
          kind: 'wan_edit',
          characterId: '',
          characterName: 'Dataset',
          prompt,
          dimension: datasetSize,
          batch: 1,
          status: 'done',
          outputUrls: data.urls,
          inputImageUrl: data.inputUrl,
          createdAt: new Date().toISOString(),
          userId: user?.id ?? '',
        })
      } catch (err) {
        toast.error(`Failed: "${prompt}" — ${err instanceof Error ? err.message : 'error'}`)
      }
      done++
      setDatasetProgress({ done, total })
    }

    setDatasetRunning(false)
    loadDatasetHistory()
    if (!datasetAbortRef.current) toast.success(`Dataset generated: ${done}/${total} images`)
    else toast.info(`Stopped at ${done}/${total} images`)
  }

  const selectedDatasetImages = datasetImages.filter(i => i.selected)

  // ─────────────────────────────────────────────────────────────
  // TRAIN TAB
  // ─────────────────────────────────────────────────────────────

  async function startTraining() {
    if (!trainName.trim()) { toast.error('Enter a LoRA name'); return }
    if (!trainTrigger.trim()) { toast.error('Enter a trigger word'); return }
    if (selectedDatasetImages.length < 5) {
      toast.error('Select at least 5 dataset images for training'); return
    }

    setTraining(true)
    try {
      const res = await fetch('/api/loras/train', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageUrls: selectedDatasetImages.map(i => i.url),
          name: trainName.trim(),
          triggerWord: trainTrigger.trim(),
          steps: trainSteps,
          learningRate: trainLr,
          loraRank: trainRank,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      toast.success('Training started! (~12 min)')
      setTrainPollingId(data.loraId)
      loadLoras()

      // Start polling every 30s
      pollingRef.current = setInterval(async () => {
        const s = await fetch(`/api/loras/${data.loraId}/status`).then(r => r.json())
        if (s.lora?.status === 'ready') {
          clearInterval(pollingRef.current!)
          setTrainPollingId(null)
          setTraining(false)
          toast.success(`LoRA "${trainName}" is ready!`)
          loadLoras()
        } else if (s.lora?.status === 'failed') {
          clearInterval(pollingRef.current!)
          setTrainPollingId(null)
          setTraining(false)
          toast.error(`Training failed: ${s.lora.error_message}`)
          loadLoras()
        }
      }, 30_000)
    } catch (err) {
      setTraining(false)
      toast.error(err instanceof Error ? err.message : 'Training failed')
    }
  }

  async function deleteLoRA(id: string) {
    if (!confirm('Delete this LoRA?')) return
    await fetch('/api/loras', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    loadLoras()
    toast.success('Deleted')
  }

  // ─────────────────────────────────────────────────────────────
  // BULK GENERATE TAB
  // ─────────────────────────────────────────────────────────────

  async function downloadZip(filterCharId: string | 'all') {
    const targetJobs = filterCharId === 'all'
      ? jobs.filter(j => j.status === 'done' && j.outputUrls.length > 0)
      : jobs.filter(j => j.status === 'done' && j.outputUrls.length > 0 && j.characterId === filterCharId)
    if (!targetJobs.length) { toast.error('No completed images'); return }

    setZipping(filterCharId)
    try {
      const JSZipMod = (await import('jszip')).default
      const zip = new JSZipMod()
      for (const job of targetJobs) {
        const folder = zip.folder(job.characterName)!
        for (let i = 0; i < job.outputUrls.length; i++) {
          try {
            const blob = await fetch(job.outputUrls[i]).then(r => r.blob())
            const ext = blob.type.includes('png') ? 'png' : 'jpg'
            folder.file(`${job.prompt.slice(0, 40).replace(/[^a-zA-Z0-9]/g, '_')}_${i + 1}.${ext}`, blob)
          } catch {}
        }
      }
      const content = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(content)
      a.download = `xmachine_bulk_${new Date().toISOString().slice(0, 10)}.zip`
      a.click()
      URL.revokeObjectURL(a.href)
      toast.success('ZIP downloaded')
    } finally { setZipping(null) }
  }

  function buildJobs() {
    const lines = promptsRaw.split('\n').map(l => l.trim()).filter(Boolean)
    if (!lines.length) { toast.error('Add at least one prompt'); return }
    if (!selectedCharIds.length && !bulkLoraUrl) { toast.error('Select a character or enter a LoRA URL'); return }

    const newJobs: BulkJob[] = []
    if (selectedCharIds.length > 0) {
      for (const charId of selectedCharIds) {
        const char = characters.find(c => c.id === charId)
        if (!char) continue
        for (const prompt of lines) {
          newJobs.push({ id: crypto.randomUUID(), characterId: charId, characterName: char.name, prompt, dimension, status: 'pending', outputUrls: [] })
        }
      }
    } else {
      for (const prompt of lines) {
        newJobs.push({ id: crypto.randomUUID(), characterId: '', characterName: 'Custom LoRA', prompt, dimension, status: 'pending', outputUrls: [] })
      }
    }
    setJobs(newJobs)
    toast.success(`${newJobs.length} tasks created`)
  }

  function updateJob(id: string, patch: Partial<BulkJob>) {
    setJobs(prev => prev.map(j => j.id === id ? { ...j, ...patch } : j))
  }

  async function generateOne(job: BulkJob) {
    const char = characters.find(c => c.id === job.characterId)
    const loraUrl = bulkLoraUrl || char?.loraUrl
    const loraScale = bulkLoraScale || char?.loraScale || 0.8
    const basePrompt = char?.basePromptStyle ? `${char.basePromptStyle}, ${job.prompt}` : job.prompt

    updateJob(job.id, { status: 'processing', startedAt: new Date().toISOString() })
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: basePrompt, dimension: job.dimension, batch: 1, loraUrl, loraScale, characterId: job.characterId, characterName: job.characterName, userId: user?.id }),
      })
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error ?? 'API error')
      const urls: string[] = data.urls ?? []
      updateJob(job.id, { status: 'done', outputUrls: urls, finishedAt: new Date().toISOString() })
      generationsStore.add({ id: job.id, kind: 'text2img', characterId: job.characterId, characterName: job.characterName, prompt: basePrompt, dimension: job.dimension, batch: 1, status: 'done', outputUrls: urls, createdAt: job.startedAt ?? new Date().toISOString(), userId: user?.id ?? '' })
    } catch (err) {
      updateJob(job.id, { status: 'error', error: err instanceof Error ? err.message : 'error', finishedAt: new Date().toISOString() })
    }
  }

  async function startBulk() {
    const pending = jobs.filter(j => j.status === 'pending' || j.status === 'error')
    if (!pending.length) { toast.error('No tasks to run'); return }
    abortRef.current = false
    setRunning(true)
    let idx = 0
    async function worker() {
      while (idx < pending.length) {
        if (abortRef.current) break
        await generateOne(pending[idx++])
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
    setRunning(false)
    if (!abortRef.current) toast.success('Bulk generation complete!')
  }

  const stats = { total: jobs.length, done: jobs.filter(j => j.status === 'done').length, error: jobs.filter(j => j.status === 'error').length, processing: jobs.filter(j => j.status === 'processing').length, images: jobs.reduce((acc, j) => acc + j.outputUrls.length, 0) }
  const promptCount = promptsRaw.split('\n').filter(l => l.trim()).length
  const readyLoras = loras.filter(l => l.status === 'ready')

  // ─────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* Unified underline tab bar */}
      <div className="flex border-b border-border shrink-0 px-4 pt-2 gap-1 bg-background">
        {TAB_LABELS.map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${tab === t ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            {t}
            {t === 'Train LoRA' && loras.filter(l => l.status === 'training').length > 0 && (
              <Badge variant="default" className="ml-1.5 text-[10px] px-1 h-4">{loras.filter(l => l.status === 'training').length}</Badge>
            )}
          </button>
        ))}
      </div>

      {/* Image Generate — full height, no padding wrapper */}
      {tab === 'Image Generate' && (
        <div className="flex-1 min-h-0">
          <GenerateTab />
        </div>
      )}

      {/* All other tabs — padded scrollable container */}
      {tab !== 'Image Generate' && (
        <div className="flex-1 overflow-y-auto">
          <div className="p-6 max-w-5xl mx-auto space-y-6">

      {/* ── DATASET TAB ───────────────────────────────────────── */}
      {tab === 'Dataset' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Reference images */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">1. Reference images</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden"
                  onChange={e => addRefImages(e.target.files)} />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full border-2 border-dashed border-border rounded-xl p-6 flex flex-col items-center gap-2 hover:border-primary/50 hover:bg-primary/5 transition-colors text-muted-foreground hover:text-foreground">
                  <Upload className="w-6 h-6" />
                  <span className="text-sm">Upload reference photos</span>
                  <span className="text-xs opacity-60">Face + body shots, JPG/PNG</span>
                </button>
                {refImages.length > 0 && (
                  <div className="grid grid-cols-4 gap-2">
                    {refImages.map(img => (
                      <div key={img.id} className="relative group aspect-square rounded-lg overflow-hidden border border-border">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={img.url} alt="" className="w-full h-full object-cover" />
                        <button onClick={() => setRefImages(prev => prev.filter(i => i.id !== img.id))}
                          className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <X className="w-2.5 h-2.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {refImages.length > 0 && <p className="text-xs text-muted-foreground text-center">{refImages.length} reference image(s) loaded</p>}
              </CardContent>
            </Card>

            {/* Prompts */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">2. Prompts (1 per line)</CardTitle>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                    title="Browse prompt library" onClick={() => setShowPromptHelp(true)}>
                    <HelpCircle className="w-4 h-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <Textarea
                  placeholder={"sitting on a beach, golden hour\nworking in a café, laptop open\nwalking through a market in Bali\n..."}
                  value={datasetPrompts}
                  onChange={e => setDatasetPrompts(e.target.value)}
                  rows={10}
                  className="resize-none font-mono text-sm"
                />
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Aspect ratio</Label>
                  <Select value={datasetSize} onValueChange={v => { if (v) setDatasetSize(v) }}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(DIMENSIONS).map(([ratio, px]) => (
                        <SelectItem key={ratio} value={ratio}>{ratio} — {px}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2 p-3 rounded-lg bg-secondary/50 border border-border text-xs text-muted-foreground">
                  <Info className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    <strong className="text-foreground">{datasetPrompts.split('\n').filter(l => l.trim()).length}</strong> prompts →{' '}
                    <strong className="text-primary">{datasetPrompts.split('\n').filter(l => l.trim()).length}</strong> dataset images
                    {refImages.length > 1 && <span className="text-muted-foreground/60"> (cycling {refImages.length} refs)</span>}
                  </span>
                </div>
                {!datasetRunning ? (
                  <Button className="w-full" onClick={generateDataset}
                    disabled={!datasetPrompts.trim() || !refImages.length}>
                    <Play className="w-4 h-4 mr-2" />Generate Dataset
                  </Button>
                ) : (
                  <div className="flex gap-2">
                    <Button className="flex-1" disabled>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Generating... ({datasetProgress.done}/{datasetProgress.total})
                    </Button>
                    <Button variant="destructive" onClick={() => { datasetAbortRef.current = true }}>
                      <Square className="w-4 h-4" />
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Dataset progress bar */}
          {datasetRunning && (
            <div className="space-y-1">
              <div className="h-2 rounded-full bg-secondary overflow-hidden">
                <div className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${datasetProgress.total > 0 ? (datasetProgress.done / datasetProgress.total) * 100 : 0}%` }} />
              </div>
            </div>
          )}

          {/* Dataset history */}
          {datasetHistory.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">
                    History ({datasetHistory.length})
                  </CardTitle>
                  <Button size="sm" variant="destructive" className="h-7 text-xs gap-1"
                    onClick={() => { if (confirm('Clear all dataset history?')) clearDatasetHistory() }}>
                    <Trash2 className="w-3 h-3" />Clear all
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {datasetHistory.map(row => (
                    <div key={row.id} className="space-y-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground font-mono">{new Date(row.createdAt).toLocaleString()}</span>
                        <Badge variant="outline" className="text-[10px] h-4 px-1">{row.dimension}</Badge>
                        <span className="text-xs text-muted-foreground truncate flex-1">{row.prompt}</span>
                      </div>
                      <div className="flex gap-2">
                        {row.outputUrls.map((url, i) => (
                          <a key={i} href={url} target="_blank" rel="noopener noreferrer"
                            className="w-16 h-16 rounded-lg overflow-hidden border border-border block shrink-0">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={url} alt="" className="w-full h-full object-cover hover:scale-105 transition-transform" />
                          </a>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Generated images grid */}
          {datasetImages.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">
                    Generated dataset ({selectedDatasetImages.length}/{datasetImages.length} selected)
                  </CardTitle>
                  <div className="flex gap-2 flex-wrap">
                    <Button size="sm" variant="outline" className="h-7 text-xs"
                      onClick={() => setDatasetImages(prev => prev.map(i => ({ ...i, selected: true })))}>
                      Select all
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-xs"
                      onClick={() => setDatasetImages(prev => prev.map(i => ({ ...i, selected: false })))}>
                      Deselect all
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-xs"
                      onClick={async () => {
                        const JSZipMod = (await import('jszip')).default
                        const zip = new JSZipMod()
                        await Promise.all(datasetImages.map(async (img, i) => {
                          try {
                            const blob = await fetch(img.url).then(r => r.blob())
                            const ext = blob.type.includes('png') ? 'png' : 'jpg'
                            zip.file(`dataset_${String(i + 1).padStart(3, '0')}.${ext}`, blob)
                          } catch {}
                        }))
                        const content = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
                        const a = document.createElement('a')
                        a.href = URL.createObjectURL(content)
                        a.download = `dataset_${new Date().toISOString().slice(0, 10)}.zip`
                        a.click()
                        URL.revokeObjectURL(a.href)
                      }}>
                      <FolderDown className="w-3 h-3 mr-1" />ZIP all
                    </Button>
                    <Button size="sm" className="h-7 text-xs bg-primary"
                      disabled={selectedDatasetImages.length < 5}
                      onClick={() => setTab('Train LoRA')}>
                      <Cpu className="w-3 h-3 mr-1.5" />
                      Train with {selectedDatasetImages.length}
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 gap-2">
                  {datasetImages.map((img, i) => (
                    <div key={img.id} className="group relative">
                      <div
                        className={`aspect-square rounded-lg overflow-hidden border-2 cursor-pointer transition-all ${img.selected ? 'border-primary' : 'border-transparent opacity-50'}`}
                        onClick={() => setDatasetImages(prev => prev.map(d => d.id === img.id ? { ...d, selected: !d.selected } : d))}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={img.url} alt="" className="w-full h-full object-cover" />
                        {img.selected && (
                          <div className="absolute top-1 right-1 w-4 h-4 rounded-full bg-primary flex items-center justify-center">
                            <CheckCircle2 className="w-2.5 h-2.5 text-primary-foreground" />
                          </div>
                        )}
                      </div>
                      {/* Per-image download */}
                      <a
                        href={img.url}
                        download={`dataset_${String(i + 1).padStart(3, '0')}.jpg`}
                        onClick={e => e.stopPropagation()}
                        className="absolute bottom-1 left-1 w-5 h-5 rounded bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                        title="Download">
                        <Download className="w-2.5 h-2.5" />
                      </a>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <PromptHelpDialog
            open={showPromptHelp}
            onClose={() => setShowPromptHelp(false)}
            onAdd={prompts => {
              setDatasetPrompts(prev => {
                const existing = prev.trim()
                return existing ? existing + '\n' + prompts.join('\n') : prompts.join('\n')
              })
              setShowPromptHelp(false)
              toast.success(`Added ${prompts.length} prompt${prompts.length > 1 ? 's' : ''}`)
            }}
          />
        </div>
      )}

      {/* ── TRAIN LORA TAB ─────────────────────────────────────── */}
      {tab === 'Train LoRA' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Training config */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Training config</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">LoRA name</Label>
                  <Input value={trainName} onChange={e => setTrainName(e.target.value)}
                    placeholder="e.g. Tiana v1" className="h-8 text-sm" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Trigger word</Label>
                  <Input value={trainTrigger} onChange={e => setTrainTrigger(e.target.value)}
                    placeholder="e.g. t1ana" className="h-8 text-sm font-mono" />
                  <p className="text-[10px] text-muted-foreground">Unique word used to activate LoRA in prompts</p>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Steps</Label>
                    <Input type="number" value={trainSteps} min={100} max={5000}
                      onChange={e => setTrainSteps(Number(e.target.value))} className="h-8 text-xs" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Learn. rate</Label>
                    <Input type="number" value={trainLr} step={0.00001} min={0.00001} max={0.001}
                      onChange={e => setTrainLr(Number(e.target.value))} className="h-8 text-xs" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">LoRA rank</Label>
                    <Input type="number" value={trainRank} min={4} max={64}
                      onChange={e => setTrainRank(Number(e.target.value))} className="h-8 text-xs" />
                  </div>
                </div>
                <div className="flex items-center gap-2 p-2.5 rounded-lg bg-secondary/50 text-xs text-muted-foreground">
                  <Info className="w-3.5 h-3.5 shrink-0" />
                  <span>~${((trainSteps / 1000) * 1.25).toFixed(2)} · ~{Math.round(trainSteps * 0.75 / 60)} min</span>
                </div>

                {selectedDatasetImages.length > 0 && (
                  <div className="flex items-center gap-2 p-2.5 rounded-lg bg-primary/10 border border-primary/20 text-xs">
                    <CheckCircle2 className="w-3.5 h-3.5 text-primary shrink-0" />
                    <span className="text-foreground">{selectedDatasetImages.length} images from Dataset tab selected</span>
                  </div>
                )}
                {selectedDatasetImages.length === 0 && (
                  <div className="flex items-center gap-2 p-2.5 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-xs text-yellow-400">
                    <Info className="w-3.5 h-3.5 shrink-0" />
                    Generate and select dataset images in the Dataset tab first
                  </div>
                )}

                <Button className="w-full" onClick={startTraining}
                  disabled={training || selectedDatasetImages.length < 5 || !trainName || !trainTrigger}>
                  {training
                    ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Training in progress...</>
                    : <><Cpu className="w-4 h-4 mr-2" />Start Training</>}
                </Button>
              </CardContent>
            </Card>

            {/* LoRA library */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">LoRA Library</CardTitle>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={loadLoras}>
                    <RefreshCw className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {loras.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Cpu className="w-8 h-8 mx-auto mb-2 opacity-20" />
                    <p className="text-sm">No LoRAs yet</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {loras.map(lora => (
                      <div key={lora.id} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium truncate">{lora.name}</p>
                            <Badge variant={lora.status === 'ready' ? 'secondary' : lora.status === 'failed' ? 'destructive' : 'default'}
                              className="text-[10px] px-1.5 h-4 shrink-0">
                              {lora.status === 'training' && <Loader2 className="w-2.5 h-2.5 mr-0.5 animate-spin inline" />}
                              {lora.status}
                            </Badge>
                          </div>
                          {lora.trigger_word && <p className="text-xs text-primary font-mono mt-0.5">{lora.trigger_word}</p>}
                          {lora.lora_url && (
                            <p className="text-[10px] text-muted-foreground truncate mt-0.5">{lora.lora_url}</p>
                          )}
                          {lora.error_message && (
                            <p className="text-[10px] text-destructive truncate mt-0.5">{lora.error_message}</p>
                          )}
                        </div>
                        <div className="flex gap-1 shrink-0">
                          {lora.lora_url && (
                            <a href={lora.lora_url} target="_blank" rel="noopener noreferrer"
                              className="w-7 h-7 rounded-md border border-border flex items-center justify-center hover:border-primary transition-colors">
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                          <button onClick={() => deleteLoRA(lora.id)}
                            className="w-7 h-7 rounded-md border border-border flex items-center justify-center hover:border-destructive hover:text-destructive transition-colors">
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* ── BULK GENERATE TAB ─────────────────────────────────── */}
      {tab === 'Bulk Generate' && (
        <div className="space-y-6">
          {jobs.length === 0 ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Left: Characters + LoRA */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">1. LoRA & Characters</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* LoRA from library */}
                  {readyLoras.length > 0 && (
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">LoRA from library</Label>
                      <Select value={bulkLoraUrl}
                        onValueChange={v => {
                          setBulkLoraUrl(v === '__none__' ? '' : v)
                          if (v !== '__none__') setSelectedCharIds([])
                        }}>
                        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select LoRA..." /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">None (use character LoRA)</SelectItem>
                          {readyLoras.map(l => (
                            <SelectItem key={l.id} value={l.lora_url!}>
                              {l.name} · <span className="font-mono text-primary">{l.trigger_word}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {bulkLoraUrl && (
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">LoRA scale</Label>
                      <Input type="number" min={0.1} max={1.5} step={0.05} value={bulkLoraScale}
                        onChange={e => setBulkLoraScale(Number(e.target.value))} className="h-8 text-xs w-24" />
                    </div>
                  )}
                  {!bulkLoraUrl && (
                    <>
                      <Separator />
                      <p className="text-xs text-muted-foreground">Or select character(s):</p>
                      <div className="space-y-2">
                        {characters.map(char => {
                          const selected = selectedCharIds.includes(char.id)
                          return (
                            <button key={char.id} onClick={() => setSelectedCharIds(prev => prev.includes(char.id) ? prev.filter(x => x !== char.id) : [...prev, char.id])}
                              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-all ${selected ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/40 text-muted-foreground hover:text-foreground'}`}>
                              <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 ${selected ? 'border-primary bg-primary' : 'border-muted-foreground/40'}`}>
                                {selected && <CheckCircle2 className="w-3 h-3 text-primary-foreground" />}
                              </div>
                              <p className="font-medium text-sm">{char.name}</p>
                              {selected && <Badge variant="secondary" className="text-xs ml-auto">Selected</Badge>}
                            </button>
                          )
                        })}
                      </div>
                    </>
                  )}
                  <Separator />
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Dimension</Label>
                    <Select value={dimension} onValueChange={setDimension}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Object.entries(DIMENSIONS).map(([ratio, px]) => (
                          <SelectItem key={ratio} value={ratio}>{ratio} — {px}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>

              {/* Right: Prompts */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">2. Prompts (1 per line)</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Textarea
                    placeholder={"sitting on a beach, golden hour\nworking in a café, laptop open\nwalking through a market in Bali"}
                    value={promptsRaw}
                    onChange={e => setPromptsRaw(e.target.value)}
                    rows={12}
                    className="resize-none font-mono text-sm"
                  />
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-secondary/50 border border-border text-sm">
                    <Info className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                    <span className="text-muted-foreground text-xs">
                      <strong className="text-foreground">{promptCount}</strong> prompts ×{' '}
                      <strong className="text-foreground">{bulkLoraUrl ? 1 : selectedCharIds.length}</strong> model(s) ={' '}
                      <strong className="text-primary">{promptCount * (bulkLoraUrl ? 1 : selectedCharIds.length)} images</strong>
                    </span>
                  </div>
                  <Button className="w-full" onClick={buildJobs}
                    disabled={promptCount === 0 || (!bulkLoraUrl && selectedCharIds.length === 0)}>
                    <Layers className="w-4 h-4 mr-2" />
                    Create {promptCount * (bulkLoraUrl ? 1 : selectedCharIds.length)} tasks
                  </Button>
                </CardContent>
              </Card>
            </div>
          ) : (
            // Jobs view
            <div className="space-y-4">
              <Card>
                <CardContent className="py-4 px-5">
                  <div className="flex flex-wrap items-center gap-4">
                    <span className="text-sm text-muted-foreground">Total: <strong className="text-foreground">{stats.total}</strong></span>
                    <span className="text-sm text-muted-foreground">Done: <strong className="text-green-400">{stats.done}</strong></span>
                    <span className="text-sm text-muted-foreground">Error: <strong className="text-red-400">{stats.error}</strong></span>
                    <span className="text-sm text-muted-foreground">Images: <strong className="text-primary">{stats.images}</strong></span>
                    <div className="flex-1 min-w-32">
                      <div className="h-2 rounded-full bg-secondary overflow-hidden">
                        <div className="h-full bg-primary transition-all duration-500"
                          style={{ width: `${stats.total > 0 ? ((stats.done + stats.error) / stats.total) * 100 : 0}%` }} />
                      </div>
                    </div>
                    <div className="flex gap-2 ml-auto">
                      {!running ? (
                        <Button onClick={startBulk} size="sm">
                          <Play className="w-3.5 h-3.5 mr-1.5" />Run
                        </Button>
                      ) : (
                        <Button onClick={() => { abortRef.current = true; setRunning(false) }} variant="destructive" size="sm">
                          <Square className="w-3.5 h-3.5 mr-1.5" />Stop
                        </Button>
                      )}
                      <Button onClick={() => downloadZip('all')} variant="outline" size="sm" disabled={zipping !== null || stats.done === 0}>
                        {zipping === 'all' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderDown className="w-3.5 h-3.5" />}
                      </Button>
                      <Button onClick={() => setJobs([])} variant="outline" size="sm">
                        <Plus className="w-3.5 h-3.5" />New
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <div className="space-y-2">
                {jobs.map(job => (
                  <div key={job.id} className="rounded-xl border border-border bg-card overflow-hidden">
                    <button className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-secondary/30 transition-colors"
                      onClick={() => setExpandedJobs(prev => { const n = new Set(prev); n.has(job.id) ? n.delete(job.id) : n.add(job.id); return n })}>
                      <StatusIcon status={job.status} />
                      <span className="flex-1 text-sm truncate">{job.prompt}</span>
                      <span className="text-xs text-muted-foreground shrink-0">{job.characterName}</span>
                      <StatusBadge status={job.status} />
                      {expandedJobs.has(job.id) ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground rotate-180" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
                    </button>
                    {expandedJobs.has(job.id) && job.outputUrls.length > 0 && (
                      <div className="px-4 pb-4 grid grid-cols-4 gap-2">
                        {job.outputUrls.map((url, i) => (
                          <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="aspect-square rounded-lg overflow-hidden border border-border block">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={url} alt="" className="w-full h-full object-cover hover:scale-105 transition-transform" />
                          </a>
                        ))}
                      </div>
                    )}
                    {expandedJobs.has(job.id) && job.error && (
                      <p className="px-4 pb-3 text-xs text-destructive">{job.error}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

          {/* ── REPRODUCE TAB ─────────────────────────────────────── */}
          {tab === 'Img Reproduce' && <ReproduceTab />}

          {/* ── VIDEO REPRODUCE TAB ───────────────────────────────── */}
          {tab === 'Video Reproduce' && <VideoReproduceTab />}
          </div>
        </div>
      )}
    </div>
  )
}
