'use client'

import { useState, useEffect, useRef, useCallback, Suspense, lazy } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { charactersStore, generationsStore } from '@/lib/store'
import { Character, GenerationRow, DIMENSIONS } from '@/lib/types'
import {
  CAROUSEL_PRESETS,
  DEFAULT_CAROUSEL_PRESET_ID,
  buildCarouselBasePrompt,
  getCarouselGrokHint,
  getCarouselGrokStyle,
  recommendedCarouselExtras,
  getCarouselVariantPrompts,
} from '@/lib/carousel-presets'
import { cleanSceneRefUrls } from '@/lib/scene-refs'
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
  ListTodo,
} from 'lucide-react'
import { GenerateTab } from './generate-tab'
import { buildStyledScenePrompt, withTriggerWord } from '@/lib/character-prompt'
import { SEEDREAM_MAX_IMAGES, type SeedreamResolution } from '@/lib/wavespeed'
import {
  CONTENT_FORMATS,
  driveFormatFolderName,
  suggestedDimensionForFormat,
  type ContentFormat,
} from '@/lib/drive-archive/content-format'

const PromptHelpDialog = lazy(() =>
  import('./prompt-library').then(m => ({ default: m.PromptHelpDialog })),
)
const InstagramBundleDialog = lazy(() =>
  import('./prompt-library').then(m => ({ default: m.InstagramBundleDialog })),
)
import { CarouselTab } from './carousel-tab'

// ─── Types ────────────────────────────────────────────────────

type JobStatus = 'pending' | 'processing' | 'done' | 'error' | 'skipped'

interface RefImageItem {
  id: string
  file: File
  url: string
}

const MAX_CAROUSEL_REF_IMAGES = SEEDREAM_MAX_IMAGES

interface BulkJob {
  id: string; characterId: string; characterName: string; prompt: string
  dimension: string; status: JobStatus; outputUrls: string[]
  sentPrompt?: string; sentLoraUrl?: string
  /** Scene reference this job alone uses, on top of the shared character refs. */
  sceneRefUrl?: string
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
const TAB_LABELS = ['Image Generate', 'Dataset', 'Train LoRA', 'Bulk Generate', 'Carousel'] as const
type Tab = typeof TAB_LABELS[number]

const TAB_FROM_QUERY: Record<string, Tab> = {
  generate: 'Image Generate',
  dataset: 'Dataset',
  train: 'Train LoRA',
  bulk: 'Bulk Generate',
  carousel: 'Carousel',
}

const QUERY_FROM_TAB: Record<Tab, string> = {
  'Image Generate': 'generate',
  Dataset: 'dataset',
  'Train LoRA': 'train',
  'Bulk Generate': 'bulk',
  Carousel: 'carousel',
}

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

/**
 * Splits a pasted prompt list into clean lines, stripping markdown noise that
 * commonly comes along when copying prompts out of a chat response — code-fence
 * markers (```text, ```) and separator lines (---, ===, ***) — so only real
 * prompt text is counted and sent to generation.
 */
function cleanPromptLines(raw: string): string[] {
  return raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !/^```/.test(l) && !/^[-=*_~]{3,}$/.test(l))
}


// ─── Main Page ────────────────────────────────────────────────

function BulkPageInner() {
  const { user } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const initialTab = TAB_FROM_QUERY[searchParams.get('tab') ?? ''] ?? 'Image Generate'
  const [tab, setTabState] = useState<Tab>(initialTab)
  const [characters, setCharacters] = useState<Character[]>([])
  const [loras, setLoras] = useState<LoraRow[]>([])

  useEffect(() => {
    const raw = searchParams.get('tab') ?? ''
    const next = TAB_FROM_QUERY[raw] ?? 'Image Generate'
    setTabState(prev => (prev === next ? prev : next))
  }, [searchParams])

  function setTab(next: Tab) {
    setTabState(next)
    const q = QUERY_FROM_TAB[next]
    const current = searchParams.get('tab')
    // Image Generate uses bare /bulk; treat ?tab=generate as already there.
    const alreadyOnTab =
      (q === 'generate' && (current === null || current === '' || current === 'generate'))
      || (q !== 'generate' && current === q)
    if (alreadyOnTab) {
      // One-shot normalize so sidebar ?tab=generate and page /bulk stay in sync.
      if (q === 'generate' && current === 'generate') {
        router.replace('/bulk', { scroll: false })
      }
      return
    }
    router.replace(q === 'generate' ? '/bulk' : `/bulk?tab=${q}`, { scroll: false })
  }

  const [showPromptHelp, setShowPromptHelp] = useState(false)
  const [showBundleDialog, setShowBundleDialog] = useState(false)

  // ── Dataset state ────────────────────────────────────────────
  const [refImages, setRefImages] = useState<Array<{ id: string; file: File; url: string }>>([])
  const [datasetPrompts, setDatasetPrompts] = useState('')
  const [datasetSize, setDatasetSize] = useState('1:1')
  const [datasetImages, setDatasetImages] = useState<DatasetImage[]>([])
  const [datasetRunning, setDatasetRunning] = useState(false)
  const [datasetProgress, setDatasetProgress] = useState({ done: 0, total: 0 })
  const [datasetHistory, setDatasetHistory] = useState<GenerationRow[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const carouselRefInputRef = useRef<HTMLInputElement>(null)
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
  const [contentFormat, setContentFormat] = useState<ContentFormat>('stories')
  const [driveLabel, setDriveLabel] = useState('')
  const [jobs, setJobs] = useState<BulkJob[]>([])
  const [running, setRunning] = useState(false)
  const [expandedJobs, setExpandedJobs] = useState<Set<string>>(new Set())
  const abortRef = useRef(false)
  const [zipping, setZipping] = useState<string | null>(null)
  const [bulkLoraUrl, setBulkLoraUrl] = useState('')
  const [bulkLoraScale, setBulkLoraScale] = useState(0.8)
  const [carouselMode, setCarouselMode] = useState(false)
  const [carouselExtra, setCarouselExtra] = useState<1 | 2 | 3 | 4>(1)
  const [carouselPresetId, setCarouselPresetId] = useState(DEFAULT_CAROUSEL_PRESET_ID)
  const [carouselGrokSmart, setCarouselGrokSmart] = useState(false)
  const [carouselRefImages, setCarouselRefImages] = useState<RefImageItem[]>([])
  const [sceneRefUrlsRaw, setSceneRefUrlsRaw] = useState('')
  const [seedreamResolution, setSeedreamResolution] = useState<SeedreamResolution>('1k')
  const carouselRefUrlsRef = useRef<string[]>([])
  const sceneRefUrls = cleanSceneRefUrls(sceneRefUrlsRaw)

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
    const t = setTimeout(() => {
      setCharacters(charactersStore.getAll())
      loadLoras()
      loadDatasetHistory()
    }, 0)
    return () => clearTimeout(t)
  }, [loadLoras])

  useEffect(() => {
    if (!carouselMode) return
    setCarouselExtra(recommendedCarouselExtras(carouselPresetId))
    setContentFormat('carousels')
  }, [carouselMode, carouselPresetId])

  useEffect(() => {
    carouselRefUrlsRef.current = []
  }, [carouselRefImages])

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
    const prompts = cleanPromptLines(datasetPrompts)
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
        // Ensure MIME is set — empty File.type is rejected by /api/edit-image.
        const typed = ref.file.type
          ? ref.file
          : new File([ref.file], ref.file.name || 'ref.jpg', { type: 'image/jpeg' })
        fd.append('file', typed)
        fd.append('prompt', prompt)
        fd.append('size', datasetSize)
        fd.append('saveHistory', 'true')
        fd.append('historyPrompt', prompt)
        // Matches the job row below; without it the Drive archive files these
        // under _unsorted/ instead of dataset/.
        fd.append('characterName', 'Dataset')
        const res = await fetch('/api/edit-image', { method: 'POST', body: fd })
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

  async function ensureCarouselRefUrls(): Promise<string[]> {
    if (carouselRefUrlsRef.current.length > 0) return carouselRefUrlsRef.current
    if (!carouselRefImages.length) return []
    carouselRefUrlsRef.current = await uploadCarouselRefImages()
    return carouselRefUrlsRef.current
  }

  async function callSeedreamEdit(
    prompt: string,
    size: string,
    imageUrls: string[],
    meta?: {
      characterId?: string
      characterName?: string
      contentFormat?: ContentFormat
      seriesId?: string
      seriesIndex?: number
      seriesTotal?: number
    },
  ): Promise<string[]> {
    const res = await fetch('/api/edit-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        size,
        resolution: seedreamResolution,
        imageUrls,
        saveHistory: true,
        historyPrompt: prompt,
        kind: 'seedream_edit',
        characterId: meta?.characterId,
        characterName: meta?.characterName,
        contentFormat: meta?.contentFormat ?? contentFormat,
        seriesId: meta?.seriesId,
        seriesIndex: meta?.seriesIndex,
        seriesTotal: meta?.seriesTotal,
      }),
    })
    const data = await res.json()
    if (!res.ok || !data.urls?.length) throw new Error(data.error ?? 'Seedream edit failed')
    return data.urls as string[]
  }

  function addCarouselRefImages(files: FileList | null) {
    if (!files?.length) return
    const room = MAX_CAROUSEL_REF_IMAGES - carouselRefImages.length
    if (room <= 0) {
      toast.error(`Max ${MAX_CAROUSEL_REF_IMAGES} reference images`)
      return
    }
    const newImgs = Array.from(files).slice(0, room).map(file => ({
      id: crypto.randomUUID(),
      file,
      url: URL.createObjectURL(file),
    }))
    setCarouselRefImages(prev => [...prev, ...newImgs])
    if (files.length > room) {
      toast.message(`Only ${room} more reference image(s) added (max ${MAX_CAROUSEL_REF_IMAGES})`)
    }
  }

  async function uploadCarouselRefImages(): Promise<string[]> {
    const urls: string[] = []
    for (const ref of carouselRefImages) {
      const res = await fetch('/api/queue/upload-input', {
        method: 'POST',
        headers: {
          'content-type': ref.file.type || 'image/jpeg',
          'x-file-name': encodeURIComponent(ref.file.name),
        },
        body: ref.file,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Reference upload failed')
      urls.push(data.url as string)
    }
    return urls
  }

  function isSeedreamRefOnlyMode(): boolean {
    return (carouselRefImages.length > 0 || sceneRefUrls.length > 0)
      && !bulkLoraUrl
      && selectedCharIds.length === 0
  }

  function buildJobs() {
    const lines = cleanPromptLines(promptsRaw)
    if (!lines.length) { toast.error('Add at least one prompt'); return }
    const refOnly = isSeedreamRefOnlyMode()
    if (!selectedCharIds.length && !bulkLoraUrl && !refOnly) {
      toast.error('Select a character, LoRA, or upload Seedream reference images')
      return
    }
    if (refOnly && !driveLabel.trim() && selectedCharIds.length === 0) {
      toast.error('Enter a Drive folder name (girl) for Seedream-only jobs')
      return
    }

    // Every scene reference becomes its own job, so N pasted URLs × M prompts
    // = N×M jobs. With no scene refs this is a single undefined slot and the
    // job list comes out exactly as it did before.
    const refSlots: (string | undefined)[] = sceneRefUrls.length ? sceneRefUrls : [undefined]

    const newJobs: BulkJob[] = []
    const pushJobs = (characterId: string, characterName: string) => {
      for (const prompt of lines) {
        for (const sceneRefUrl of refSlots) {
          newJobs.push({ id: crypto.randomUUID(), characterId, characterName, prompt, dimension, status: 'pending', outputUrls: [], sceneRefUrl })
        }
      }
    }

    if (selectedCharIds.length > 0) {
      for (const charId of selectedCharIds) {
        const char = characters.find(c => c.id === charId)
        if (!char) continue
        const folderName =
          selectedCharIds.length === 1 && driveLabel.trim()
            ? driveLabel.trim()
            : char.name
        pushJobs(charId, folderName)
      }
    } else if (refOnly) {
      pushJobs('', driveLabel.trim() || 'seedream_refs')
    } else {
      pushJobs('', driveLabel.trim() || 'custom_lora')
    }
    setJobs(newJobs)
    toast.success(`${newJobs.length} tasks created`)
  }

  function updateJob(id: string, patch: Partial<BulkJob>) {
    setJobs(prev => prev.map(j => j.id === id ? { ...j, ...patch } : j))
  }

  async function generateOne(job: BulkJob) {
    const char = charactersStore.getAll().find(c => c.id === job.characterId)
    const loraUrl = bulkLoraUrl || char?.loraUrl
    const loraScale = bulkLoraScale || char?.loraScale || 0.8
    const styledPrompt = buildStyledScenePrompt(char, job.prompt)
    const basePrompt = withTriggerWord(styledPrompt, selectedLora?.trigger_word || char?.triggerWord)
    const generationPrompt = carouselMode
      ? buildCarouselBasePrompt(basePrompt, carouselPresetId)
      : basePrompt

    const refOnly = isSeedreamRefOnlyMode()
    if (refOnly && carouselRefImages.length === 0 && !job.sceneRefUrl) {
      toast.error('Upload reference images for Seedream-only mode')
      return
    }

    // Base + every variant slide of this carousel are separate generation
    // calls (own random genId each), so nothing normally ties them together
    // or numbers them for Drive. Sharing one seriesId + this slide's
    // position groups + orders them correctly — see buildArchiveFilename.
    // seriesTotal is the INTENDED count (1 base + carouselExtra), fixed
    // before any variant actually runs, so the base slide can be tagged
    // up front; some positions may end up missing if a variant call fails.
    const seriesId = carouselMode ? crypto.randomUUID() : undefined
    const seriesTotal = carouselMode ? 1 + carouselExtra : undefined

    updateJob(job.id, { status: 'processing', startedAt: new Date().toISOString(), sentPrompt: generationPrompt, sentLoraUrl: loraUrl ?? undefined })
    try {
      let baseUrls: string[]
      if (refOnly) {
        // Character refs first so identity keeps Seedream's primary slot; this
        // job's scene reference (a pin URL) rides along as an extra image.
        const refUrls = [
          ...(await ensureCarouselRefUrls()),
          ...(job.sceneRefUrl ? [job.sceneRefUrl] : []),
        ].slice(0, SEEDREAM_MAX_IMAGES)
        baseUrls = await callSeedreamEdit(generationPrompt, job.dimension, refUrls, {
          characterId: job.characterId || undefined,
          characterName: job.characterName,
          contentFormat: carouselMode ? 'carousels' : contentFormat,
          seriesId,
          seriesIndex: 0,
          seriesTotal,
        })
      } else {
        const res = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: generationPrompt,
            dimension: job.dimension,
            batch: 1,
            loraUrl,
            loraScale,
            characterId: job.characterId,
            characterName: job.characterName,
            userId: user?.id,
            contentFormat: carouselMode ? 'carousels' : contentFormat,
            seriesId,
            seriesIndex: 0,
            seriesTotal,
          }),
        })
        const data = await res.json()
        if (!res.ok || data.error) throw new Error(data.error ?? 'API error')
        baseUrls = data.urls ?? []
      }

      let outputUrls = baseUrls
      if (carouselMode && baseUrls.length) {
        let variantPrompts: string[] = []

        if (carouselGrokSmart) {
          try {
            const imgRes = await fetch(baseUrls[0])
            const blob = await imgRes.blob()
            const fd = new FormData()
            fd.append('file', blob, 'base.jpg')
            fd.append('count', String(carouselExtra))
            fd.append('mode', 'carousel')
            fd.append('style', getCarouselGrokStyle(carouselPresetId))
            fd.append('hint', getCarouselGrokHint(carouselPresetId))
            const poseRes = await fetch('/api/grok/analyze-poses', { method: 'POST', body: fd })
            const poseData = await poseRes.json()
            if (poseRes.ok) {
              variantPrompts = (poseData.prompts as string[] ?? []).map(p => p.trim()).filter(Boolean).slice(0, carouselExtra)
            }
          } catch {
            // fall through to preset
          }
        }

        if (!variantPrompts.length) {
          variantPrompts = getCarouselVariantPrompts(carouselPresetId, carouselExtra, generationPrompt)
        }

        // The base slide occupies one of Seedream's image slots, so refs are capped one below the max.
        const refUrls = [
          ...(carouselRefImages.length ? await ensureCarouselRefUrls() : []),
          ...(job.sceneRefUrl ? [job.sceneRefUrl] : []),
        ].slice(0, SEEDREAM_MAX_IMAGES - 1)

        const results = await Promise.allSettled(variantPrompts.map(async (variantPrompt, vi) => {
          const editUrls = await callSeedreamEdit(
            variantPrompt,
            job.dimension,
            [baseUrls[0], ...refUrls],
            {
              characterId: job.characterId || undefined,
              characterName: job.characterName,
              contentFormat: 'carousels',
              seriesId,
              seriesIndex: vi + 1,
              seriesTotal,
            },
          )
          return editUrls[0]
        }))
        const variantUrls = results.filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled').map(r => r.value)
        outputUrls = [...baseUrls, ...variantUrls]
      }

      updateJob(job.id, { status: 'done', outputUrls, finishedAt: new Date().toISOString() })
      generationsStore.add({
        id: job.id,
        kind: refOnly ? 'wan_edit' : 'text2img',
        characterId: job.characterId,
        characterName: job.characterName,
        prompt: generationPrompt,
        dimension: job.dimension,
        batch: 1,
        status: 'done',
        outputUrls,
        createdAt: job.startedAt ?? new Date().toISOString(),
        userId: user?.id ?? '',
      })
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

  async function submitToQueue() {
    if (!jobs.length) { toast.error('No tasks to submit'); return }
    try {
      const refOnly = isSeedreamRefOnlyMode()
      if (refOnly && !carouselMode) {
        toast.error('Seedream-only (refs, no character) — use Run on this page; Queue needs a character/LoRA or Generate carousel')
        return
      }
      let referenceImageUrls: string[] | undefined
      if (carouselMode && carouselRefImages.length) {
        referenceImageUrls = await uploadCarouselRefImages()
      }
      // A per-job scene reference is a valid Seedream base by itself, so
      // uploaded character refs are only required when some job lacks one.
      if (refOnly && !referenceImageUrls?.length && !jobs.every(j => j.sceneRefUrl)) {
        toast.error('Upload reference images for Seedream-only mode')
        return
      }

      const freshCharacters = charactersStore.getAll()
      const queueJobs = jobs.map(job => {
        const char = freshCharacters.find(c => c.id === job.characterId)
        const loraUrl = bulkLoraUrl || char?.loraUrl || null
        const loraScale = bulkLoraScale ?? char?.loraScale ?? 0.8
        const styledPrompt = buildStyledScenePrompt(char, job.prompt)
        const prompt = withTriggerWord(styledPrompt, selectedLora?.trigger_word || char?.triggerWord)
        return {
          prompt, dimension: job.dimension, loraUrl, loraScale,
          characterId: job.characterId, characterName: job.characterName,
          // Sent as a bare URL — the worker hands it to Seedream, which fetches
          // it itself, so pins are never downloaded or re-hosted by us.
          referenceImageUrls: job.sceneRefUrl ? [job.sceneRefUrl] : undefined,
        }
      })

      const body = carouselMode
        ? {
            job_type: 'bulk_carousel',
            input: {
              items: queueJobs,
              variantsExtra: carouselExtra,
              presetId: carouselPresetId,
              grokSmart: carouselGrokSmart,
              referenceImageUrls,
              seedreamOnly: refOnly,
              seedreamResolution,
            },
          }
        : { job_type: 'bulk_image', input: { jobs: queueJobs } }

      const res = await fetch('/api/queue/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      toast.success(`${jobs.length} ${jobs.length === 1 ? (carouselMode ? 'carousel' : 'image') : (carouselMode ? 'carousels' : 'images')} sent to queue`, {
        description: 'Processing continues in the background — you can leave the page',
        action: { label: 'Open Queue', onClick: () => { window.location.href = '/captions?tab=queue' } },
      })
      setJobs([])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Queue submit failed')
    }
  }

  const stats = { total: jobs.length, done: jobs.filter(j => j.status === 'done').length, error: jobs.filter(j => j.status === 'error').length, processing: jobs.filter(j => j.status === 'processing').length, images: jobs.reduce((acc, j) => acc + j.outputUrls.length, 0) }
  const promptCount = cleanPromptLines(promptsRaw).length
  const readyLoras = loras.filter(l => l.status === 'ready')
  const selectedLora = readyLoras.find(l => l.lora_url === bulkLoraUrl)
  const seedreamRefOnly = isSeedreamRefOnlyMode()
  const bulkModelCount = bulkLoraUrl ? 1 : selectedCharIds.length || (seedreamRefOnly ? 1 : 0)

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

      {/* Carousel — full height, no padding wrapper */}
      {tab === 'Carousel' && (
        <div className="flex-1 min-h-0">
          <CarouselTab />
        </div>
      )}

      {/* All other tabs — padded scrollable container */}
      {tab !== 'Image Generate' && tab !== 'Carousel' && (
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
                <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" multiple className="hidden"
                  onChange={e => addRefImages(e.target.files)} />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full border-2 border-dashed border-border rounded-xl p-6 flex flex-col items-center gap-2 hover:border-primary/50 hover:bg-primary/5 transition-colors text-muted-foreground hover:text-foreground">
                  <Upload className="w-6 h-6" />
                  <span className="text-sm">Upload reference photos</span>
                  <span className="text-xs opacity-60">Face + body shots — JPEG, PNG or WebP</span>
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
                    <strong className="text-foreground">{cleanPromptLines(datasetPrompts).length}</strong> prompts →{' '}
                    <strong className="text-primary">{cleanPromptLines(datasetPrompts).length}</strong> dataset images
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
                          setBulkLoraUrl(v === '__none__' || v === null ? '' : v)
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
                  {selectedLora?.trigger_word && (
                    <p className="text-[10px] text-muted-foreground/70">
                      Trigger word <span className="font-mono text-primary">{selectedLora.trigger_word}</span> will be added to every prompt automatically.
                    </p>
                  )}
                  {!bulkLoraUrl && (
                    <>
                      <Separator />
                      <p className="text-xs text-muted-foreground">Or select character(s):</p>
                      <div className="space-y-2">
                        {characters.map(char => {
                          const selected = selectedCharIds.includes(char.id)
                          return (
                            <button key={char.id} onClick={() => {
                              setSelectedCharIds(prev => {
                                const next = prev.includes(char.id)
                                  ? prev.filter(x => x !== char.id)
                                  : [...prev, char.id]
                                if (next.length === 1) {
                                  const only = characters.find(c => c.id === next[0])
                                  if (only) setDriveLabel(only.name)
                                }
                                return next
                              })
                            }}
                              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-all ${selected ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/40 text-muted-foreground hover:text-foreground'}`}>
                              <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 ${selected ? 'border-primary bg-primary' : 'border-muted-foreground/40'}`}>
                                {selected && <CheckCircle2 className="w-3 h-3 text-primary-foreground" />}
                              </div>
                              <p className="font-medium text-sm">{char.name}</p>
                              {char.triggerWord && (
                                <span className="text-[10px] font-mono text-primary/70">{char.triggerWord}</span>
                              )}
                              {selected && <Badge variant="secondary" className="text-xs ml-auto">Selected</Badge>}
                            </button>
                          )
                        })}
                      </div>
                      {selectedCharIds.length > 0 && (
                        <p className="text-[10px] text-muted-foreground/70">
                          {selectedCharIds.every(id => characters.find(c => c.id === id)?.triggerWord)
                            ? 'Each selected character\'s trigger word will be added to its prompts automatically.'
                            : 'One or more selected characters have no trigger word set — add one in Admin → Characters so their LoRA fires reliably.'}
                        </p>
                      )}
                    </>
                  )}
                  <Separator />
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Drive folder (girl)</Label>
                    <Input
                      value={driveLabel}
                      onChange={e => setDriveLabel(e.target.value)}
                      placeholder="e.g. tiana"
                      className="h-8 text-xs"
                    />
                    <p className="text-[10px] text-muted-foreground/70 leading-snug">
                      Reuses this folder on Drive if it exists, otherwise creates it.
                      {selectedCharIds.length > 1 ? ' Multi-select uses each character name.' : ''}
                    </p>
                  </div>
                  <Separator />
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">For (publish format)</Label>
                    <div className="grid grid-cols-3 gap-1.5">
                      {CONTENT_FORMATS.map(f => (
                        <button
                          key={f.id}
                          type="button"
                          title={f.hint}
                          disabled={carouselMode && f.id !== 'carousels'}
                          onClick={() => {
                            setContentFormat(f.id)
                            if (!carouselMode) setDimension(suggestedDimensionForFormat(f.id))
                          }}
                          className={`py-2 rounded-md text-xs font-medium border transition-colors disabled:opacity-40 ${
                            (carouselMode ? 'carousels' : contentFormat) === f.id
                              ? 'bg-primary text-primary-foreground border-primary'
                              : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                    <p className="text-[10px] text-muted-foreground/70 leading-snug">
                      Path:{' '}
                      <span className="font-mono">
                        {(driveLabel.trim() || '{girl}').toLowerCase()}/
                        {driveFormatFolderName(carouselMode ? 'carousels' : contentFormat)}
                        /ready/YYYY-MM-DD/
                      </span>
                    </p>
                  </div>
                  <Separator />
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Dimension</Label>
                    <Select value={dimension} onValueChange={(v) => setDimension(v ?? '')}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Object.entries(DIMENSIONS).map(([ratio, px]) => (
                          <SelectItem key={ratio} value={ratio}>{ratio} — {px}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Separator />
                  <div className="space-y-1.5">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                      <input
                        type="checkbox"
                        checked={carouselMode}
                        onChange={e => {
                          const on = e.target.checked
                          setCarouselMode(on)
                          if (on) {
                            setContentFormat('carousels')
                          }
                        }}
                        className="accent-primary"
                      />
                      Generate carousel
                    </label>
                    {carouselMode && (
                      <div className="space-y-2 pl-6">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground shrink-0">Extra images:</span>
                          <Select value={String(carouselExtra)} onValueChange={v => { if (v) setCarouselExtra(Number(v) as 1 | 2 | 3 | 4) }}>
                            <SelectTrigger className="h-8 w-16 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="1">1</SelectItem>
                              <SelectItem value="2">2</SelectItem>
                              <SelectItem value="3">3</SelectItem>
                              <SelectItem value="4">4</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                          <input
                            type="checkbox"
                            checked={carouselGrokSmart}
                            onChange={e => setCarouselGrokSmart(e.target.checked)}
                            className="accent-primary"
                          />
                          Grok smart mode (catchy hook carousel)
                        </label>
                        {!carouselGrokSmart && (
                          <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">Pose preset</Label>
                            <Select value={carouselPresetId} onValueChange={v => { if (v) setCarouselPresetId(v) }}>
                              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {CAROUSEL_PRESETS.map(p => (
                                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground">Scene reference URLs</Label>
                          <Textarea
                            value={sceneRefUrlsRaw}
                            onChange={e => setSceneRefUrlsRaw(e.target.value)}
                            placeholder={'One URL per line — Pinterest pin, CDN...\nhttps://i.pinimg.com/originals/...'}
                            className="text-xs font-mono min-h-[72px]"
                          />
                          <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
                            {sceneRefUrls.length > 0
                              ? `${sceneRefUrls.length} scene ref${sceneRefUrls.length === 1 ? '' : 's'} — each one becomes its own carousel (× ${cleanPromptLines(promptsRaw).length || 0} prompt${cleanPromptLines(promptsRaw).length === 1 ? '' : 's'}). Not downloaded — Seedream fetches the URL.`
                              : 'Optional. Each URL becomes its own carousel, on top of the uploaded character references.'}
                          </p>
                          {sceneRefUrls.length > 0 && (
                            <div className="grid grid-cols-6 gap-1 pt-1">
                              {sceneRefUrls.slice(0, 12).map(url => (
                                /* eslint-disable-next-line @next/next/no-img-element */
                                <img
                                  key={url}
                                  src={`/api/proxy-image?url=${encodeURIComponent(url)}`}
                                  alt=""
                                  className="aspect-square w-full rounded object-cover border border-border"
                                  onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden' }}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <Label className="text-xs text-muted-foreground shrink-0">Seedream:</Label>
                          <Select value={seedreamResolution} onValueChange={v => { if (v) setSeedreamResolution(v as SeedreamResolution) }}>
                            <SelectTrigger className="h-8 w-20 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="1k">1k</SelectItem>
                              <SelectItem value="2k">2k</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    )}
                    {carouselMode && (
                      <p className="text-[10px] text-muted-foreground/60 pl-6 leading-relaxed">
                        1 base + {carouselExtra} variant{carouselExtra === 1 ? '' : 's'} per prompt ({1 + carouselExtra} total).
                        {carouselGrokSmart
                          ? ' Grok designs variant slides 2+ from the base (hook face or outfit hero).'
                          : carouselPresetId === 'hook-tease'
                            ? ' Slide 1 = face hook. Variants tease with body/mirror — never another face close-up.'
                            : carouselPresetId === 'outfit-tour'
                              ? ' Slide 1 = full outfit. Variants crop legs, boots, waist-up — same look, different zones.'
                              : ' Preset picks varied angles for editorial-style carousels.'}
                        {' '}For large batches, use Queue.
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* Right: Prompts */}
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">2. Prompts (1 per line)</CardTitle>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                        title="Instagram Bundles" onClick={() => setShowBundleDialog(true)}>
                        <Layers className="w-4 h-4" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                        title="Browse prompt library" onClick={() => setShowPromptHelp(true)}>
                        <HelpCircle className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Textarea
                    placeholder={"sitting on a beach, golden hour\nworking in a café, laptop open\nwalking through a market in Bali"}
                    value={promptsRaw}
                    onChange={e => setPromptsRaw(e.target.value)}
                    rows={12}
                    className="resize-none font-mono text-sm field-sizing-fixed max-h-[320px] overflow-y-auto"
                  />
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-secondary/50 border border-border text-sm">
                    <Info className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                    <span className="text-muted-foreground text-xs">
                      <strong className="text-foreground">{promptCount}</strong> prompts ×{' '}
                      <strong className="text-foreground">{bulkModelCount}</strong> model(s) ={' '}
                      <strong className="text-primary">{promptCount * bulkModelCount} images</strong>
                      {seedreamRefOnly && (
                        <span className="block mt-1 text-primary/80">Seedream-only pipeline — Z-image skipped</span>
                      )}
                    </span>
                  </div>
                  {!bulkLoraUrl && selectedCharIds.length === 0 && carouselRefImages.length === 0 && (
                    <p className="text-[10px] text-muted-foreground/70">
                      No character/LoRA — upload Seedream references below to generate without Z-image.
                    </p>
                  )}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Label className="text-xs text-muted-foreground">Seedream reference images</Label>
                      {seedreamRefOnly && (
                        <Badge variant="secondary" className="text-[10px] h-5">Seedream-only — no Z-image</Badge>
                      )}
                    </div>
                    <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
                      {seedreamRefOnly
                        ? carouselMode
                          ? 'Without LoRA, references drive identity — base slide and all variants use Seedream only (consistent hair, skin, outfit).'
                          : 'Without LoRA/character, references drive identity — each prompt runs as Seedream edit only.'
                        : carouselMode
                          ? 'Optional extras sent with each variant edit alongside the Z-image base — improves detail consistency.'
                          : 'Optional. With a character/LoRA selected these are unused for single images; turn on Generate carousel to apply them on variants.'}
                    </p>
                    <input
                      ref={carouselRefInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      multiple
                      className="hidden"
                      onChange={e => { addCarouselRefImages(e.target.files); e.target.value = '' }}
                    />
                    <button
                      type="button"
                      onClick={() => carouselRefInputRef.current?.click()}
                      disabled={carouselRefImages.length >= MAX_CAROUSEL_REF_IMAGES}
                      className="w-full border-2 border-dashed border-border rounded-xl p-4 flex flex-col items-center gap-1.5 hover:border-primary/50 hover:bg-primary/5 transition-colors text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:pointer-events-none"
                    >
                      <Upload className="w-5 h-5" />
                      <span className="text-xs">Upload reference photos</span>
                      <span className="text-[10px] opacity-60">Up to {MAX_CAROUSEL_REF_IMAGES} — face, hair, outfit detail</span>
                    </button>
                    {carouselRefImages.length > 0 && (
                      <div className="grid grid-cols-5 gap-2">
                        {carouselRefImages.map(img => (
                          <div key={img.id} className="relative group aspect-square rounded-lg overflow-hidden border border-border">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={img.url} alt="" className="w-full h-full object-cover" />
                            <button
                              type="button"
                              onClick={() => setCarouselRefImages(prev => prev.filter(i => i.id !== img.id))}
                              className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                            >
                              <X className="w-2.5 h-2.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    {carouselRefImages.length > 0 && (
                      <p className="text-[10px] text-muted-foreground text-center">
                        {carouselRefImages.length} reference image{carouselRefImages.length === 1 ? '' : 's'}
                        {seedreamRefOnly
                          ? carouselMode
                            ? ' — all slides via Seedream edit'
                            : ' — Seedream edit (no Z-image)'
                          : carouselMode
                            ? ' — base slide + refs on each variant'
                            : ' — ready for carousel variants (Generate carousel)'}
                        {carouselMode && !seedreamRefOnly && carouselRefImages.length > SEEDREAM_MAX_IMAGES - 1 && (
                          <span className="block text-amber-400/80">
                            Variants use the first {SEEDREAM_MAX_IMAGES - 1} — the base slide takes one slot of {SEEDREAM_MAX_IMAGES}.
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                  <Button className="w-full" onClick={buildJobs}
                    disabled={promptCount === 0 || bulkModelCount === 0}>
                    <Layers className="w-4 h-4 mr-2" />
                    Create {promptCount * bulkModelCount} tasks
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
                      <Button onClick={submitToQueue} variant="secondary" size="sm" disabled={running} title="Submit to background queue — you can leave the page">
                        <ListTodo className="w-3.5 h-3.5 mr-1.5" />Queue
                      </Button>
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
                    {expandedJobs.has(job.id) && job.sentPrompt && (
                      <div className="px-4 pb-3 space-y-1">
                        <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wide">Actual prompt sent to API</p>
                        <p className="text-xs font-mono bg-secondary/40 rounded-lg p-2 break-all">{job.sentPrompt}</p>
                        {job.sentLoraUrl && (
                          <p className="text-[10px] text-muted-foreground/60 break-all">LoRA: {job.sentLoraUrl}</p>
                        )}
                      </div>
                    )}
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

          </div>
        </div>
      )}

      {showPromptHelp && (
        <Suspense fallback={null}>
          <PromptHelpDialog
            open={showPromptHelp}
            onClose={() => setShowPromptHelp(false)}
            onAdd={prompts => {
              if (tab === 'Bulk Generate') {
                setPromptsRaw(prev => {
                  const existing = prev.trim()
                  return existing ? existing + '\n' + prompts.join('\n') : prompts.join('\n')
                })
              } else {
                setDatasetPrompts(prev => {
                  const existing = prev.trim()
                  return existing ? existing + '\n' + prompts.join('\n') : prompts.join('\n')
                })
              }
              setShowPromptHelp(false)
              toast.success(`Added ${prompts.length} prompt${prompts.length > 1 ? 's' : ''}`)
            }}
          />
        </Suspense>
      )}

      {showBundleDialog && (
        <Suspense fallback={null}>
          <InstagramBundleDialog
            open={showBundleDialog}
            onClose={() => setShowBundleDialog(false)}
            highlightNicheId={selectedCharIds.length === 1 ? characters.find(c => c.id === selectedCharIds[0])?.recommendedNicheId : undefined}
            onApply={(prompts, replace) => {
              setPromptsRaw(prev => {
                if (replace) return prompts.join('\n')
                const existing = prev.trim()
                return existing ? existing + '\n' + prompts.join('\n') : prompts.join('\n')
              })
              toast.success(`Applied ${prompts.length} prompts`)
            }}
          />
        </Suspense>
      )}
    </div>
  )
}

export default function BulkPage() {
  return (
    <Suspense fallback={null}>
      <BulkPageInner />
    </Suspense>
  )
}
