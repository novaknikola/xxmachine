'use client'

import { useState, useEffect, useCallback, useRef, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { toast } from 'sonner'
import {
  Loader2, Heart, Plug, RefreshCw, Unplug,
  Sparkles, CalendarClock, Images, Upload, Link2, X, Users, MessageCircle,
  HelpCircle, Trash2, CheckSquare, Square, Pencil, RotateCw,
} from 'lucide-react'

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

interface Creator {
  uuid: string
  handle?: string
  displayName?: string
}

interface BulkItem {
  id: string
  /** 1 image = a normal post; 2+ (via "Spoji u carousel") = one Fanvue multi-media post. */
  urls: string[]
  caption: string
  price: string // dollars, as typed; empty = no PPV
  generating: boolean
}

interface QueueItem {
  id: string
  creatorUuid: string
  creatorDisplayName: string | null
  imageUrl: string
  extraImageUrls: string[] | null
  caption: string
  scheduledAt: string
  status: 'scheduled' | 'failed' | 'pending' | 'published'
  error: string | null
  publishedAt: string | null
  postUuid: string | null
  priceCents: number | null
  createdAt: string
}

interface LibraryCaption {
  id: string
  caption: string
  category: string | null
  structure: string | null
  contentLevel: string | null
  priceCents: number | null
  sourceImageUrl: string | null
  createdAt: string
}

interface ChatterRow {
  chatterUuid: string
  chatterName: string
  messages: number
  ppvsSent: number
  ppvsUnlocked: number
  revenue: number // cents
  unlockRatio: number // 0-1
  activeHours: number
  eph: number // cents/hour
  avgResponseMs: number
  avatarUrl: string | null
}

function formatMoney(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatResponseTime(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** Local (not UTC) YYYY-MM-DDTHH:mm for a <input type="datetime-local"> default value. */
function toLocalDatetimeValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function priceToCents(dollars: string): number | undefined {
  const trimmed = dollars.trim()
  if (!trimmed) return undefined
  const n = Math.round(parseFloat(trimmed) * 100)
  return Number.isFinite(n) ? n : undefined
}

function statusBadge(status: QueueItem['status']) {
  if (status === 'scheduled') return <Badge>Scheduled on Fanvue</Badge>
  if (status === 'published') return <Badge>Published</Badge>
  if (status === 'failed') return <Badge variant="destructive">Failed</Badge>
  return <Badge variant="secondary">Pending</Badge>
}

export default function FanvuePage() {
  return (
    <Suspense fallback={null}>
      <FanvuePageInner />
    </Suspense>
  )
}

function FanvuePageInner() {
  const { user } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const tab = searchParams.get('tab') ?? 'poster'

  const [connected, setConnected] = useState<boolean | null>(null)
  const [creators, setCreators] = useState<Creator[]>([])
  const [disconnecting, setDisconnecting] = useState(false)

  // Bulk poster
  const [pickerMode, setPickerMode] = useState<'history' | 'upload' | 'link'>('history')
  const [bulkCreatorUuid, setBulkCreatorUuid] = useState('')
  const [historyUrls, setHistoryUrls] = useState<string[]>([])
  const [bulkUrlsText, setBulkUrlsText] = useState('')
  const [bulkItems, setBulkItems] = useState<BulkItem[]>([])
  const [selectedBulkIds, setSelectedBulkIds] = useState<Set<string>>(new Set())
  const [uploading, setUploading] = useState(false)
  const [captioning, setCaptioning] = useState(false)
  const [startAt, setStartAt] = useState(() => toLocalDatetimeValue(new Date(Date.now() + 10 * 60_000)))
  const [staggerMinutes, setStaggerMinutes] = useState(45)
  const [scheduling, setScheduling] = useState(false)
  const [scheduleResult, setScheduleResult] = useState<string | null>(null)
  const [confirmScheduleOpen, setConfirmScheduleOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const captionCancelRef = useRef(false)
  const captionAbortRef = useRef<AbortController | null>(null)

  // Caption library — reuse a previously Grok-written caption without paying for a new call
  const [libraryOpenFor, setLibraryOpenFor] = useState<number | null>(null)
  const [libraryItems, setLibraryItems] = useState<LibraryCaption[]>([])
  const [libraryLoading, setLibraryLoading] = useState(false)
  const [librarySearch, setLibrarySearch] = useState('')

  // Fans & Chatteri — leaderboard
  const [leaderboard, setLeaderboard] = useState<ChatterRow[]>([])
  const [leaderboardLoading, setLeaderboardLoading] = useState(false)
  const [leaderboardPeriod, setLeaderboardPeriod] = useState<'7' | '30' | '90' | 'all'>('30')

  // Scheduled queue — paginated, since a real batch can be hundreds/thousands of rows
  const QUEUE_PAGE_SIZE = 50
  const [queueItems, setQueueItems] = useState<QueueItem[]>([])
  const [queueTotal, setQueueTotal] = useState(0)
  const [queueLoading, setQueueLoading] = useState(false)
  const [queueLoadingMore, setQueueLoadingMore] = useState(false)
  const [selectedQueueIds, setSelectedQueueIds] = useState<Set<string>>(new Set())
  const [confirmDeleteIds, setConfirmDeleteIds] = useState<string[] | null>(null)
  const [deletingQueue, setDeletingQueue] = useState(false)

  // Edit + retry for stuck 'failed'/'pending' rows — the only rows that never made it to
  // Fanvue at all, so re-attempting in place (optionally with edited fields) makes sense.
  // 'scheduled'/'published' rows already exist on Fanvue's side and aren't editable here.
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<{ caption: string; price: string; scheduledAt: string } | null>(null)
  const [retryingQueueId, setRetryingQueueId] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/fanvue/sync')
      const data = await res.json()
      setConnected(!!data.connected)
    } catch {
      setConnected(false)
    }
  }, [])

  const loadQueue = useCallback(async () => {
    setQueueLoading(true)
    try {
      const res = await fetch(`/api/fanvue/schedule?limit=${QUEUE_PAGE_SIZE}&offset=0`)
      if (res.ok) {
        const data = await res.json() as { items: QueueItem[]; total: number }
        setQueueItems(data.items)
        setQueueTotal(data.total)
        setSelectedQueueIds(new Set())
      }
    } finally {
      setQueueLoading(false)
    }
  }, [])

  const loadMoreQueue = useCallback(async () => {
    setQueueLoadingMore(true)
    try {
      const res = await fetch(`/api/fanvue/schedule?limit=${QUEUE_PAGE_SIZE}&offset=${queueItems.length}`)
      if (res.ok) {
        const data = await res.json() as { items: QueueItem[]; total: number }
        setQueueItems(prev => [...prev, ...data.items])
        setQueueTotal(data.total)
      }
    } finally {
      setQueueLoadingMore(false)
    }
  }, [queueItems.length])

  async function deleteQueueItems(ids: string[]) {
    if (!ids.length) return
    setDeletingQueue(true)
    try {
      const res = await fetch('/api/fanvue/schedule', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      if (!res.ok) {
        toast.error('Brisanje nije uspelo')
        return
      }
      setQueueItems(prev => prev.filter(it => !ids.includes(it.id)))
      setQueueTotal(prev => Math.max(0, prev - ids.length))
      setSelectedQueueIds(prev => {
        const next = new Set(prev)
        ids.forEach(id => next.delete(id))
        return next
      })
      toast.success(ids.length === 1 ? 'Obrisano' : `Obrisano ${ids.length} stavki`)
    } finally {
      setDeletingQueue(false)
      setConfirmDeleteIds(null)
    }
  }

  function toggleQueueSelected(id: string) {
    setSelectedQueueIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAllQueue() {
    setSelectedQueueIds(prev =>
      prev.size === queueItems.length ? new Set() : new Set(queueItems.map(it => it.id)),
    )
  }

  function startEditQueueItem(item: QueueItem) {
    setEditingQueueId(item.id)
    setEditDraft({
      caption: item.caption,
      price: typeof item.priceCents === 'number' ? (item.priceCents / 100).toFixed(2) : '',
      scheduledAt: toLocalDatetimeValue(new Date(item.scheduledAt)),
    })
  }

  function cancelEditQueueItem() {
    setEditingQueueId(null)
    setEditDraft(null)
  }

  async function retryQueueItem(id: string, draft: { caption: string; price: string; scheduledAt: string } | null) {
    setRetryingQueueId(id)
    try {
      const body = draft
        ? {
            caption: draft.caption,
            price: priceToCents(draft.price),
            scheduledAt: new Date(draft.scheduledAt).toISOString(),
          }
        : {}
      const res = await fetch(`/api/fanvue/schedule/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.detail || data.error || 'Retry nije uspeo')
        loadQueue()
        return
      }
      toast.success('Zakazano na Fanvue-u')
      setEditingQueueId(null)
      setEditDraft(null)
      loadQueue()
    } finally {
      setRetryingQueueId(null)
    }
  }

  async function openCaptionLibrary(index: number) {
    setLibraryOpenFor(index)
    setLibrarySearch('')
    setLibraryLoading(true)
    try {
      const res = await fetch('/api/fanvue/caption-library?limit=100')
      if (res.ok) setLibraryItems(await res.json())
    } finally {
      setLibraryLoading(false)
    }
  }

  async function searchCaptionLibrary(q: string) {
    setLibrarySearch(q)
    setLibraryLoading(true)
    try {
      const params = new URLSearchParams({ limit: '100' })
      if (q.trim()) params.set('q', q.trim())
      const res = await fetch(`/api/fanvue/caption-library?${params}`)
      if (res.ok) setLibraryItems(await res.json())
    } finally {
      setLibraryLoading(false)
    }
  }

  function applyLibraryCaption(item: LibraryCaption) {
    if (libraryOpenFor === null) return
    updateItem(libraryOpenFor, {
      caption: item.caption,
      price: typeof item.priceCents === 'number' ? (item.priceCents / 100).toFixed(2) : '',
    })
    setLibraryOpenFor(null)
  }

  const loadLeaderboard = useCallback(async (period: typeof leaderboardPeriod) => {
    setLeaderboardLoading(true)
    try {
      const params = new URLSearchParams({ action: 'leaderboard' })
      if (period !== 'all') {
        const days = Number(period)
        params.set('startDate', new Date(Date.now() - days * 86_400_000).toISOString())
      }
      const res = await fetch(`/api/fanvue/creators?${params}`)
      if (res.ok) {
        const data = await res.json()
        setLeaderboard(data?.data ?? [])
      }
    } finally {
      setLeaderboardLoading(false)
    }
  }, [])

  // Real, server-backed generation history (same endpoint /history uses) — NOT the
  // client-only localStorage generationsStore the /schedule page uses, which is empty
  // unless something added to it in this exact browser.
  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/generations?limit=100')
      if (!res.ok) return
      const data = await res.json() as { generations?: { image_urls?: string[] }[] }
      const urls = (data.generations ?? []).flatMap(g => g.image_urls ?? []).filter(Boolean)
      setHistoryUrls(Array.from(new Set(urls)).slice(0, 100))
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    if (user && !user.isOwner) router.push('/generate')
  }, [user, router])

  useEffect(() => {
    if (!user?.isOwner) return
    loadStatus()
    loadHistory()
    loadQueue()
  }, [user, loadStatus, loadHistory, loadQueue])

  useEffect(() => {
    if (!connected) return
    fetch('/api/fanvue/creators?action=creators')
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        const list: Creator[] = data?.data ?? data ?? []
        setCreators(Array.isArray(list) ? list : [])
      })
      .catch(() => {})
  }, [connected])

  useEffect(() => {
    if (!connected || tab !== 'fans') return
    loadLeaderboard(leaderboardPeriod)
  }, [connected, tab, leaderboardPeriod, loadLeaderboard])

  async function disconnect() {
    setDisconnecting(true)
    try {
      await fetch('/api/fanvue/sync', { method: 'DELETE' })
      toast.success('Disconnected')
      setConnected(false)
      setCreators([])
    } finally {
      setDisconnecting(false)
    }
  }

  function addBulkUrls(urls: string[]) {
    setBulkItems(prev => {
      const existing = new Set(prev.flatMap(it => it.urls))
      const additions = urls.filter(u => u && !existing.has(u))
        .map(url => ({ id: crypto.randomUUID(), urls: [url], caption: '', price: '', generating: false }))
      return [...prev, ...additions]
    })
  }

  function removeBulkItem(id: string) {
    setBulkItems(prev => prev.filter(it => it.id !== id))
    setSelectedBulkIds(prev => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  function toggleBulkSelected(id: string) {
    setSelectedBulkIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** Combines the selected items into one — their urls concatenated in list order, becoming a
   *  single Fanvue post (a carousel) instead of one post per image. Keeps the first non-empty
   *  caption/price found among them; the rest are discarded along with their own list rows. */
  function mergeSelectedBulkItems() {
    if (selectedBulkIds.size < 2) return
    setBulkItems(prev => {
      const selected = prev.filter(it => selectedBulkIds.has(it.id))
      const firstIndex = prev.findIndex(it => selectedBulkIds.has(it.id))
      const merged: BulkItem = {
        id: crypto.randomUUID(),
        urls: selected.flatMap(it => it.urls),
        caption: selected.find(it => it.caption.trim())?.caption ?? '',
        price: selected.find(it => it.price.trim())?.price ?? '',
        generating: false,
      }
      const rest = prev.filter(it => !selectedBulkIds.has(it.id))
      rest.splice(firstIndex, 0, merged)
      return rest
    })
    setSelectedBulkIds(new Set())
  }

  function addLinkUrls() {
    const urls = bulkUrlsText.split('\n').map(s => s.trim()).filter(Boolean)
    addBulkUrls(urls)
    setBulkUrlsText('')
  }

  async function handleFileUpload(files: FileList | null) {
    if (!files?.length) return
    setUploading(true)
    try {
      const { uploadQueueInput } = await import('@/lib/upload-queue-input')
      for (const file of Array.from(files)) {
        try {
          const { videoUrl } = await uploadQueueInput(file)
          addBulkUrls([videoUrl])
        } catch (err) {
          toast.error(`${file.name}: ${err instanceof Error ? err.message : 'upload failed'}`)
        }
      }
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function generateCaptions() {
    captionCancelRef.current = false
    setCaptioning(true)
    // Each caption call is an independent model call with no memory of the last one — left to
    // itself the model gravitates to near-identical phrasing across a batch, on TWO axes: what
    // the question is about, and how the sentence opens (it kept defaulting to "What would you
    // [...] while/if [detail]?" regardless of topic). Rotate both, independently and shuffled
    // once per run, so neither axis can repeat back to back.
    const categories = [
      'feeling', 'want_from_her', 'want_to_do', 'discovery',
      'first_thought', 'forgiveness', 'one_wish',
    ]
    const structures = ['lead_detail', 'command_tease', 'statement_then_question', 'direct_plain']
    for (const arr of [categories, structures]) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[arr[i], arr[j]] = [arr[j], arr[i]]
      }
    }
    try {
      for (let i = 0; i < bulkItems.length; i++) {
        if (captionCancelRef.current) break
        setBulkItems(prev => prev.map((it, idx) => idx === i ? { ...it, generating: true } : it))
        const controller = new AbortController()
        captionAbortRef.current = controller
        try {
          const res = await fetch('/api/fanvue/caption', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              imageUrl: bulkItems[i].urls[0],
              category: categories[i % categories.length],
              structure: structures[i % structures.length],
            }),
            signal: controller.signal,
          })
          const data = await res.json()
          setBulkItems(prev => prev.map((it, idx) => {
            if (idx !== i) return it
            if (!res.ok) return { ...it, caption: `[error: ${data.detail || data.error}]`, generating: false }
            // Suggested price from content-level classification — pre-filled, still editable.
            const suggestedPrice = typeof data.priceCents === 'number' ? (data.priceCents / 100).toFixed(2) : it.price
            return { ...it, caption: data.caption, price: suggestedPrice, generating: false }
          }))
        } catch (err) {
          setBulkItems(prev => prev.map((it, idx) => idx === i ? { ...it, generating: false } : it))
          if (err instanceof DOMException && err.name === 'AbortError') break
        }
      }
    } finally {
      setCaptioning(false)
      captionAbortRef.current = null
    }
  }

  function stopCaptioning() {
    captionCancelRef.current = true
    captionAbortRef.current?.abort()
  }

  function updateItem(index: number, patch: Partial<BulkItem>) {
    setBulkItems(prev => prev.map((it, idx) => idx === index ? { ...it, ...patch } : it))
  }

  function scheduledAtFor(index: number): Date {
    return new Date(new Date(startAt).getTime() + index * staggerMinutes * 60_000)
  }

  const LARGE_BATCH_THRESHOLD = 20

  function requestScheduleAll() {
    const creator = creators.find(c => c.uuid === bulkCreatorUuid)
    if (!creator) {
      toast.error('Izaberi Fanvue nalog')
      return
    }
    if (!bulkItems.length || bulkItems.some(it => !it.caption.trim())) {
      toast.error('Svaka slika mora imati caption')
      return
    }
    for (const it of bulkItems) {
      if (it.price.trim() && parseFloat(it.price) < 3) {
        toast.error(`Cena mora biti bar $3.00 (${it.urls[0].slice(-30)})`)
        return
      }
    }
    if (bulkItems.length >= LARGE_BATCH_THRESHOLD) {
      setConfirmScheduleOpen(true)
      return
    }
    scheduleAll()
  }

  // One real Fanvue post attempt, with a single automatic retry if the attempt itself failed
  // for a transient reason (network blip or a 502 from create_post) — not for validation/auth
  // failures, which will just fail the same way again.
  async function scheduleOne(creator: Creator, item: BulkItem, index: number): Promise<{ ok: boolean; message: string }> {
    const scheduledAt = scheduledAtFor(index).toISOString()
    const payload = JSON.stringify({
      creatorUuid: creator.uuid,
      creatorDisplayName: creator.displayName || creator.handle,
      imageUrls: item.urls,
      caption: item.caption,
      scheduledAt,
      price: priceToCents(item.price),
    })
    const attempt = () => fetch('/api/fanvue/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    })

    let res: Response
    let data: { ok?: boolean; postUuid?: string; error?: string; detail?: string } = {}
    let transient = false
    try {
      res = await attempt()
      data = await res.json().catch(() => ({}))
      transient = res.status === 502
    } catch {
      transient = true
    }

    if (transient) {
      await sleep(1500)
      try {
        res = await attempt()
        data = await res.json().catch(() => ({}))
      } catch {
        return { ok: false, message: `#${index + 1} FAILED: network error (posle retry-a)` }
      }
    }

    return res!.ok
      ? { ok: true, message: `#${index + 1} OK @ ${scheduledAtFor(index).toLocaleString()} (Fanvue post ${data.postUuid})` }
      : { ok: false, message: `#${index + 1} FAILED: ${data.detail || data.error}` }
  }

  async function scheduleAll() {
    setConfirmScheduleOpen(false)
    const creator = creators.find(c => c.uuid === bulkCreatorUuid)
    if (!creator) return
    setScheduling(true)
    setScheduleResult(null)
    const results: string[] = []
    try {
      for (let i = 0; i < bulkItems.length; i++) {
        // Small pacing gap between real API calls to Fanvue — matters most on large batches,
        // where firing hundreds of posts back-to-back with zero delay looks automated/abusive.
        if (i > 0) await sleep(400 + Math.random() * 400)
        const { message } = await scheduleOne(creator, bulkItems[i], i)
        results.push(message)
      }
      const failedCount = results.filter(r => r.includes('FAILED')).length
      if (failedCount === 0) toast.success(`Zakazano ${bulkItems.length} postova na Fanvue-u`)
      else toast.error(`${failedCount}/${bulkItems.length} nije uspelo — proveri listu ispod`)
      setScheduleResult(results.join('\n'))
      setBulkItems([])
      setSelectedBulkIds(new Set())
      loadQueue()
    } finally {
      setScheduling(false)
    }
  }

  if (!user?.isOwner) return null

  const connectionBar = (
    <div className="flex items-center gap-3">
      <Heart className="w-6 h-6 text-primary" />
      <h1 className="text-xl font-bold flex-1">Fanvue</h1>
      {connected === null && <Badge variant="secondary">…</Badge>}
      {connected === true && <Badge>Connected</Badge>}
      {connected === false && <Badge variant="secondary">Not connected</Badge>}
      {connected && (
        <>
          <a href="/api/fanvue/auth">
            <Button variant="ghost" size="sm">
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
              Reconnect
            </Button>
          </a>
          <Button variant="ghost" size="sm" disabled={disconnecting} onClick={disconnect}>
            <Unplug className="w-3.5 h-3.5 mr-1.5" />
            Disconnect
          </Button>
        </>
      )}
    </div>
  )

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      {connectionBar}

      {connected === false && (
        <a href="/api/fanvue/auth">
          <Button>
            <Plug className="w-4 h-4 mr-2" />
            Connect Fanvue agency account
          </Button>
        </a>
      )}

      {connected && tab === 'poster' && (
        <>
          <div className="space-y-4 rounded-xl border border-border p-5">
            <p className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <CalendarClock className="w-4 h-4" /> Bulk scheduler
            </p>

            <Select value={bulkCreatorUuid} onValueChange={(v) => setBulkCreatorUuid(v ?? '')}>
              <SelectTrigger>
                <SelectValue placeholder={creators.length ? 'Izaberi Fanvue nalog' : 'Učitavanje naloga…'} />
              </SelectTrigger>
              <SelectContent>
                {creators.map(c => (
                  <SelectItem key={c.uuid} value={c.uuid}>
                    {c.displayName || c.handle || c.uuid}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="flex gap-2">
              <Button size="sm" variant={pickerMode === 'history' ? 'default' : 'secondary'} onClick={() => setPickerMode('history')}>
                <Images className="w-3.5 h-3.5 mr-1.5" /> Istorija
              </Button>
              <Button size="sm" variant={pickerMode === 'upload' ? 'default' : 'secondary'} onClick={() => setPickerMode('upload')}>
                <Upload className="w-3.5 h-3.5 mr-1.5" /> Upload
              </Button>
              <Button size="sm" variant={pickerMode === 'link' ? 'default' : 'secondary'} onClick={() => setPickerMode('link')}>
                <Link2 className="w-3.5 h-3.5 mr-1.5" /> Link
              </Button>
            </div>

            {pickerMode === 'history' && (
              historyUrls.length === 0
                ? <p className="text-sm text-muted-foreground">Nema gotovih generacija u istoriji ovog browsera.</p>
                : (
                  <div className="grid grid-cols-4 gap-2 max-h-64 overflow-y-auto">
                    {historyUrls.map(url => {
                      const owner = bulkItems.find(it => it.urls.includes(url))
                      return (
                        <button
                          key={url}
                          type="button"
                          onClick={() => owner ? removeBulkItem(owner.id) : addBulkUrls([url])}
                          className={`relative aspect-square rounded-lg overflow-hidden border-2 ${owner ? 'border-primary' : 'border-transparent'}`}
                        >
                          <img src={url} alt="" className="w-full h-full object-cover" />
                          {owner && (
                            <div className="absolute inset-0 bg-primary/30 flex items-center justify-center text-primary-foreground text-lg">✓</div>
                          )}
                        </button>
                      )
                    })}
                  </div>
                )
            )}

            {pickerMode === 'upload' && (
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={e => handleFileUpload(e.target.files)}
                  disabled={uploading}
                  className="text-sm"
                />
                {uploading && <Loader2 className="w-4 h-4 animate-spin mt-2" />}
              </div>
            )}

            {pickerMode === 'link' && (
              <div className="space-y-2">
                <Textarea
                  placeholder={'Image URL po liniji, npr:\nhttps://...jpg\nhttps://...jpg'}
                  value={bulkUrlsText}
                  onChange={e => setBulkUrlsText(e.target.value)}
                  rows={4}
                />
                <Button variant="secondary" size="sm" onClick={addLinkUrls}>Dodaj</Button>
              </div>
            )}

            {bulkItems.length > 0 && (
              <>
                <div className="flex gap-2 items-center flex-wrap">
                  <Button size="sm" disabled={captioning} onClick={generateCaptions}>
                    {captioning ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
                    Generiši captions (Grok)
                  </Button>
                  {captioning && (
                    <Button size="sm" variant="destructive" onClick={stopCaptioning}>
                      <X className="w-4 h-4 mr-2" />
                      Stop
                    </Button>
                  )}
                  {selectedBulkIds.size >= 2 && (
                    <Button size="sm" variant="secondary" onClick={mergeSelectedBulkItems}>
                      <Images className="w-3.5 h-3.5 mr-1.5" />
                      Spoji u carousel ({selectedBulkIds.size})
                    </Button>
                  )}
                </div>

                <div className="flex gap-3 items-center text-sm flex-wrap">
                  <label className="flex items-center gap-2">
                    Prvi post
                    <Input type="datetime-local" className="w-auto" value={startAt}
                      onChange={e => setStartAt(e.target.value)} />
                  </label>
                  <label className="flex items-center gap-2">
                    razmak
                    <Input type="number" className="w-20" value={staggerMinutes}
                      onChange={e => setStaggerMinutes(Number(e.target.value) || 0)} /> min
                  </label>
                </div>

                <div className="space-y-3">
                  {bulkItems.map((it, i) => (
                    <div key={it.id} className="flex gap-3 items-start border border-border/60 rounded-lg p-3">
                      <button
                        type="button"
                        onClick={() => toggleBulkSelected(it.id)}
                        className="mt-1 shrink-0 text-muted-foreground hover:text-foreground"
                        title="Izaberi za spajanje u carousel"
                      >
                        {selectedBulkIds.has(it.id) ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                      </button>
                      {it.urls.length > 1 ? (
                        <div className="relative w-16 h-16 shrink-0">
                          {it.urls.slice(0, 3).map((u, ui) => (
                            <img
                              key={u}
                              src={u}
                              alt=""
                              className="absolute w-14 h-14 object-cover rounded border-2 border-background"
                              style={{ left: ui * 6, top: ui * 6, zIndex: 3 - ui }}
                            />
                          ))}
                          <span className="absolute -bottom-1 -right-1 z-10 text-[10px] bg-primary text-primary-foreground rounded-full w-4 h-4 flex items-center justify-center">
                            {it.urls.length}
                          </span>
                        </div>
                      ) : (
                        <img src={it.urls[0]} alt="" className="w-16 h-16 object-cover rounded shrink-0" />
                      )}
                      <div className="flex-1 space-y-1.5">
                        <div className="flex items-center justify-between">
                          <p className="text-xs text-muted-foreground">
                            {scheduledAtFor(i).toLocaleString()}
                            {it.urls.length > 1 && <span className="ml-1.5 text-primary">· carousel ({it.urls.length})</span>}
                          </p>
                          <button onClick={() => removeBulkItem(it.id)} className="text-muted-foreground hover:text-destructive">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        {it.generating
                          ? <Loader2 className="w-4 h-4 animate-spin" />
                          : (
                            <div className="flex gap-1.5 items-start">
                              <Textarea value={it.caption} onChange={e => updateItem(i, { caption: e.target.value })} rows={2} className="flex-1" />
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                title="Iskoristi sačuvani caption iz biblioteke"
                                onClick={() => openCaptionLibrary(i)}
                              >
                                <HelpCircle className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                          )}
                        <Input
                          placeholder="PPV cena u $ (opciono)"
                          className="h-8 text-xs"
                          value={it.price}
                          onChange={e => updateItem(i, { price: e.target.value })}
                        />
                      </div>
                    </div>
                  ))}
                </div>

                <Button disabled={scheduling} onClick={requestScheduleAll}>
                  {scheduling ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CalendarClock className="w-4 h-4 mr-2" />}
                  Zakaži svih {bulkItems.length}
                </Button>

                {scheduleResult && (
                  <pre className="text-xs bg-secondary/50 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">{scheduleResult}</pre>
                )}
              </>
            )}
          </div>

          <div className="space-y-3 rounded-xl border border-border p-5">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <CalendarClock className="w-4 h-4" /> Zakazano {queueTotal > 0 && `(${queueTotal})`}
              </p>
              <div className="flex items-center gap-1">
                {queueItems.length > 0 && (
                  <Button variant="ghost" size="sm" onClick={toggleSelectAllQueue}>
                    {selectedQueueIds.size === queueItems.length
                      ? <CheckSquare className="w-3.5 h-3.5 mr-1.5" />
                      : <Square className="w-3.5 h-3.5 mr-1.5" />}
                    Sve na strani
                  </Button>
                )}
                {selectedQueueIds.size > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() => setConfirmDeleteIds(Array.from(selectedQueueIds))}
                  >
                    <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                    Obriši ({selectedQueueIds.size})
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={loadQueue} disabled={queueLoading}>
                  {queueLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                </Button>
              </div>
            </div>

            {queueItems.length === 0 && <p className="text-sm text-muted-foreground">Ništa nije zakazano.</p>}

            <div className="space-y-3 max-h-[480px] overflow-y-auto pr-1">
              {queueItems.map(item => {
                const retryable = item.status === 'failed' || item.status === 'pending'
                const editing = editingQueueId === item.id
                return (
                  <div key={item.id} className="border-b border-border/40 pb-3 last:border-0 last:pb-0">
                    <div className="flex gap-3 items-center">
                      <button type="button" onClick={() => toggleQueueSelected(item.id)} className="shrink-0 text-muted-foreground hover:text-foreground">
                        {selectedQueueIds.has(item.id) ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                      </button>
                      <div className="relative shrink-0">
                        <img src={item.imageUrl} alt="" className="w-12 h-12 object-cover rounded" />
                        {!!item.extraImageUrls?.length && (
                          <span className="absolute -bottom-1 -right-1 text-[10px] bg-primary text-primary-foreground rounded-full w-4 h-4 flex items-center justify-center">
                            {item.extraImageUrls.length + 1}
                          </span>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm truncate">{item.creatorDisplayName || item.creatorUuid}</p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(item.scheduledAt).toLocaleString()}
                          {item.priceCents ? ` · $${(item.priceCents / 100).toFixed(2)}` : ''}
                          {!!item.extraImageUrls?.length && ' · carousel'}
                        </p>
                        {item.error && <p className="text-xs text-destructive truncate">{item.error}</p>}
                      </div>
                      {statusBadge(item.status)}
                      {retryable && (
                        <button
                          type="button"
                          title="Uredi"
                          onClick={() => editing ? cancelEditQueueItem() : startEditQueueItem(item)}
                          className="shrink-0 text-muted-foreground hover:text-foreground"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {retryable && (
                        <button
                          type="button"
                          title="Pokušaj ponovo"
                          disabled={retryingQueueId === item.id}
                          onClick={() => retryQueueItem(item.id, null)}
                          className="shrink-0 text-muted-foreground hover:text-primary disabled:opacity-50"
                        >
                          {retryingQueueId === item.id
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <RotateCw className="w-3.5 h-3.5" />}
                        </button>
                      )}
                      <button
                        type="button"
                        title="Obriši"
                        onClick={() => setConfirmDeleteIds([item.id])}
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {editing && editDraft && (
                      <div className="mt-3 ml-7 space-y-2 rounded-lg border border-border/60 p-3">
                        <Textarea
                          value={editDraft.caption}
                          onChange={e => setEditDraft(d => d && { ...d, caption: e.target.value })}
                          rows={2}
                        />
                        <div className="flex gap-2 items-center flex-wrap">
                          <Input
                            placeholder="PPV cena u $ (opciono)"
                            className="h-8 text-xs w-40"
                            value={editDraft.price}
                            onChange={e => setEditDraft(d => d && { ...d, price: e.target.value })}
                          />
                          <Input
                            type="datetime-local"
                            className="h-8 text-xs w-auto"
                            value={editDraft.scheduledAt}
                            onChange={e => setEditDraft(d => d && { ...d, scheduledAt: e.target.value })}
                          />
                        </div>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            disabled={retryingQueueId === item.id}
                            onClick={() => retryQueueItem(item.id, editDraft)}
                          >
                            {retryingQueueId === item.id
                              ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                              : <RotateCw className="w-3.5 h-3.5 mr-1.5" />}
                            Sačuvaj i pokušaj ponovo
                          </Button>
                          <Button size="sm" variant="ghost" onClick={cancelEditQueueItem}>Otkaži</Button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {queueItems.length < queueTotal && (
              <Button variant="secondary" size="sm" className="w-full" disabled={queueLoadingMore} onClick={loadMoreQueue}>
                {queueLoadingMore ? <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> : null}
                Učitaj još ({queueTotal - queueItems.length})
              </Button>
            )}
          </div>
        </>
      )}

      {connected && tab === 'fans' && (
        <div className="space-y-3 rounded-xl border border-border p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium flex items-center gap-2">
              <Users className="w-4 h-4" /> Chatter leaderboard
            </p>
            <div className="flex items-center gap-2">
              <Select value={leaderboardPeriod} onValueChange={(v) => setLeaderboardPeriod((v as typeof leaderboardPeriod) ?? '30')}>
                <SelectTrigger className="w-32 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">7 dana</SelectItem>
                  <SelectItem value="30">30 dana</SelectItem>
                  <SelectItem value="90">90 dana</SelectItem>
                  <SelectItem value="all">Sve vreme</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="ghost" size="sm" onClick={() => loadLeaderboard(leaderboardPeriod)} disabled={leaderboardLoading}>
                {leaderboardLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              </Button>
            </div>
          </div>

          {leaderboard.length === 0 && !leaderboardLoading && (
            <p className="text-sm text-muted-foreground">Nema podataka za ovaj period.</p>
          )}

          {leaderboard.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-border/50">
                    <th className="text-left py-2 pr-3">Chatter</th>
                    <th className="text-right py-2 px-2">Revenue</th>
                    <th className="text-right py-2 px-2">Poruke</th>
                    <th className="text-right py-2 px-2">PPV (sent/unlocked)</th>
                    <th className="text-right py-2 px-2">Unlock %</th>
                    <th className="text-right py-2 px-2">Active h</th>
                    <th className="text-right py-2 px-2">$/h</th>
                    <th className="text-right py-2 pl-2">Avg response</th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.map(c => (
                    <tr key={c.chatterUuid} className="border-b border-border/30 last:border-0">
                      <td className="py-2 pr-3 font-medium">{c.chatterName}</td>
                      <td className="py-2 px-2 text-right">{formatMoney(c.revenue)}</td>
                      <td className="py-2 px-2 text-right">{c.messages.toLocaleString()}</td>
                      <td className="py-2 px-2 text-right">{c.ppvsSent} / {c.ppvsUnlocked}</td>
                      <td className="py-2 px-2 text-right">{(c.unlockRatio * 100).toFixed(0)}%</td>
                      <td className="py-2 px-2 text-right">{c.activeHours.toFixed(1)}</td>
                      <td className="py-2 px-2 text-right">{formatMoney(c.eph)}</td>
                      <td className="py-2 pl-2 text-right">{formatResponseTime(c.avgResponseMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-sm text-muted-foreground pt-2 border-t border-border/40">Sledeće na redu, još nije izgrađeno:</p>
          <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1">
            <li>Predložene poruke po fanu, direktno u chat compose box</li>
            <li>Sortiranje inbox-a po vrednosti fana (top spenderi na vrhu)</li>
          </ul>
        </div>
      )}

      {connected && tab === 'autochat' && (
        <div className="space-y-3 rounded-xl border border-border p-5">
          <p className="text-sm font-medium flex items-center gap-2">
            <MessageCircle className="w-4 h-4" /> Sistem 3 — Auto-chat
          </p>
          <p className="text-sm text-muted-foreground">Sledeće na redu, još nije izgrađeno. Dogovoreni dizajn:</p>
          <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1">
            <li>Stanja po razgovoru: AI_ACTIVE → HANDED_OFF → CHATTER_ACTIVE</li>
            <li>AI strukturno nema alat za cenu/PPV — čim fan pita za cenu, ide chatteru</li>
            <li>Backstop na broj poruka/vreme, i bypass pravo na chattera za poznate top-spendere</li>
          </ul>
        </div>
      )}

      <AlertDialog open={!!confirmDeleteIds} onOpenChange={(open) => { if (!open) setConfirmDeleteIds(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Obriši {confirmDeleteIds?.length === 1 ? 'zakazan post' : `${confirmDeleteIds?.length} zakazanih postova`}?</AlertDialogTitle>
            <AlertDialogDescription>
              Ovo briše samo iz xxmachine liste. Ako je post već zakazan na Fanvue-u, on ostaje tamo — obriši ga posebno na Fanvue-u ako ne treba da izađe.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Otkaži</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/80"
              disabled={deletingQueue}
              onClick={() => confirmDeleteIds && deleteQueueItems(confirmDeleteIds)}
            >
              {deletingQueue ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Obriši
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmScheduleOpen} onOpenChange={setConfirmScheduleOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Zakazati {bulkItems.length} postova na Fanvue-u?</AlertDialogTitle>
            <AlertDialogDescription>
              Ovo je {bulkItems.length} pravih poziva ka Fanvue API-ju (upload + create post po slici) — nije test.
              Postovi idu u Fanvue-ov sopstveni scheduled-post queue, ne mogu se masovno povući odavde ako se predomisliš.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Otkaži</AlertDialogCancel>
            <AlertDialogAction onClick={scheduleAll}>Zakaži svih {bulkItems.length}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={libraryOpenFor !== null} onOpenChange={(open) => { if (!open) setLibraryOpenFor(null) }}>
        <DialogContent className="max-w-lg h-[500px] flex flex-col gap-0 p-0">
          <DialogHeader className="px-5 pt-5 pb-3 shrink-0">
            <DialogTitle className="text-base">Sačuvani captions</DialogTitle>
          </DialogHeader>
          <div className="px-5 pb-3 shrink-0">
            <Input
              placeholder="Pretraga…"
              value={librarySearch}
              onChange={e => searchCaptionLibrary(e.target.value)}
            />
          </div>
          <div className="flex-1 overflow-y-auto px-5 pb-5 space-y-2">
            {libraryLoading && <Loader2 className="w-4 h-4 animate-spin mx-auto" />}
            {!libraryLoading && libraryItems.length === 0 && (
              <p className="text-sm text-muted-foreground text-center pt-8">Nema sačuvanih caption-a još.</p>
            )}
            {!libraryLoading && libraryItems.map(item => (
              <button
                key={item.id}
                type="button"
                onClick={() => applyLibraryCaption(item)}
                className="w-full text-left rounded-lg border border-border/60 p-3 hover:border-primary hover:bg-secondary/40 transition-colors"
              >
                <p className="text-sm">{item.caption}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {[item.category, item.structure, item.contentLevel].filter(Boolean).join(' · ')}
                  {typeof item.priceCents === 'number' ? ` · $${(item.priceCents / 100).toFixed(2)}` : ''}
                </p>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
