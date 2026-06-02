'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
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
import { prettyAccountName } from '@/lib/utils'
import {
  Clapperboard,
  HardDrive,
  Play,
  RefreshCw,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  Trash2,
  ExternalLink,
  Plus,
  Upload,
  Users,
  Wifi,
  WifiOff,
  Download,
  Monitor,
  X,
  Tag,
  Link2,
  AlertTriangle,
  ChevronDown,
} from 'lucide-react'

const CSV_EXAMPLE = [
  'name,ig_username,ig_password,ig_totp_secret,proxy_url',
  'Sophia Model,sophia.model,P@ssword123,JBSWY3DPEHPK3PXP,http://user:pass@1.2.3.4:8080',
  'Emma Official,emma_official,Hunter2!,,http://user:pass@5.6.7.8:8080',
  'Mia Content,mia.content,Secret#99,KRUGKIDROVUWG2ZA,',
].join('\n')

function downloadCSVExample() {
  const blob = new Blob([CSV_EXAMPLE], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'instagram_accounts_example.csv'
  a.click()
  URL.revokeObjectURL(url)
}

interface IgAccount {
  id: string
  name: string
  ig_username: string | null
  connected: boolean
  proxy_url: string | null
  google_drive_folder_id: string | null
  token_expires_at: string | null
  has_password: boolean
}

interface QueueItem {
  id: string
  drive_file_id: string | null
  filename: string
  status: 'pending' | 'publishing' | 'done' | 'failed'
  caption: string
  category: string | null
  scheduled_at: string | null
  published_at: string | null
  instagram_media_id: string | null
  error_message: string | null
  created_at: string
}

interface DriveFile {
  id: string
  name: string
  createdTime: string
  size: string
}

interface BulkStatus {
  [accountId: string]: 'idle' | 'connecting' | 'login' | 'connected' | 'error'
}

function StatusBadge({ status }: { status: QueueItem['status'] }) {
  const map = {
    pending:    { label: 'Scheduled', color: 'secondary' as const, icon: Clock },
    publishing: { label: 'Publishing...', color: 'default' as const, icon: Loader2 },
    done:       { label: 'Published', color: 'secondary' as const, icon: CheckCircle2 },
    failed:     { label: 'Failed', color: 'destructive' as const, icon: XCircle },
  }
  const { label, color, icon: Icon } = map[status]
  return (
    <Badge variant={color} className="text-xs gap-1">
      <Icon className={`w-3 h-3 ${status === 'done' ? 'text-green-400' : ''} ${status === 'publishing' ? 'animate-spin' : ''}`} />
      {label}
    </Badge>
  )
}

export function InstagramTab() {
  const [tab, setTab] = useState<'queue' | 'bulk'>('queue')

  const [accounts, setAccounts] = useState<IgAccount[]>([])
  const [accountId, setAccountId] = useState('')
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [driveFiles, setDriveFiles] = useState<DriveFile[]>([])
  const [loadingQueue, setLoadingQueue] = useState(false)
  const [loadingDrive, setLoadingDrive] = useState(false)
  const [publishing, setPublishing] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [refreshingToken, setRefreshingToken] = useState(false)
  const [driveFolderInput, setDriveFolderInput] = useState('')
  const [categories, setCategories] = useState<string[]>([])
  const [categoryFilter, setCategoryFilter] = useState<string>('__all__')
  const [newCategory, setNewCategory] = useState('')
  const [pendingCategory, setPendingCategory] = useState<string>('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkStatus, setBulkStatus] = useState<BulkStatus>({})
  const [bulkMessages, setBulkMessages] = useState<Record<string, string>>({})
  const [bulkRunning, setBulkRunning] = useState(false)
  const [bulkMode, setBulkMode] = useState<'api' | 'browser'>('api')
  const [bulkProgress, setBulkProgress] = useState({ done: 0, total: 0 })
  const [showAddForm, setShowAddForm] = useState(false)
  const [addForm, setAddForm] = useState({ name: '', username: '', password: '', totp: '', proxy: '' })
  const [addingAccount, setAddingAccount] = useState(false)
  const [openBrowserRunning, setOpenBrowserRunning] = useState(false)
  const [importing, setImporting] = useState(false)
  const csvRef = useRef<HTMLInputElement>(null)

  const loadAccounts = useCallback(async () => {
    const res = await fetch('/api/instagram/accounts').catch(() => null)
    if (res?.ok) {
      const data = await res.json()
      const list: IgAccount[] = Array.isArray(data) ? data : []
      setAccounts(list)
      if (list.length && !accountId) setAccountId(list[0].id ?? '')
    }
  }, [accountId])

  useEffect(() => { loadAccounts() }, [loadAccounts])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('instagram_connected')) {
      toast.success('Instagram connected!')
      loadAccounts()
      window.history.replaceState({}, '', window.location.pathname)
    } else if (params.get('instagram_error')) {
      toast.error(`Instagram error: ${params.get('instagram_error')}`)
      window.history.replaceState({}, '', window.location.pathname)
    } else if (params.get('google_connected')) {
      toast.success('Google Drive connected!')
      loadAccounts()
      window.history.replaceState({}, '', window.location.pathname)
    } else if (params.get('google_error')) {
      toast.error(`Google error: ${params.get('google_error')}`)
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [loadAccounts])

  const loadQueue = useCallback(async () => {
    if (!accountId) return
    setLoadingQueue(true)
    try {
      const params = new URLSearchParams({ accountId })
      if (categoryFilter !== '__all__') params.set('category', categoryFilter)
      const res = await fetch(`/api/instagram/queue?${params}`)
      const data = await res.json()
      setQueue(Array.isArray(data) ? data : (data.items ?? []))
      if (data.categories) setCategories(data.categories)
    } catch { toast.error('Failed to load queue') }
    finally { setLoadingQueue(false) }
  }, [accountId, categoryFilter])

  useEffect(() => { loadQueue() }, [loadQueue])

  useEffect(() => {
    const acc = accounts.find(a => a.id === accountId)
    setDriveFolderInput(acc?.google_drive_folder_id ?? '')
  }, [accountId, accounts])

  async function connectWithInstagram() {
    if (!accountId) return
    const acc = accounts.find(a => a.id === accountId)

    if (acc?.has_password) {
      // Private API — no OAuth needed
      setConnecting(true)
      try {
        const res = await fetch('/api/instagram/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error)
        toast.success(`Connected @${data.username}`)
        loadAccounts()
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : 'Connect failed')
      } finally {
        setConnecting(false)
      }
      return
    }

    // No password — trigger browser connect for this single account
    setConnecting(true)
    toast.info('Opening Chrome browser... log in to Instagram, then close the window.', { duration: 10000 })
    try {
      const res = await fetch('/api/instagram/bulk-browser-connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountIds: [accountId] }),
      })
      if (!res.body) throw new Error('No stream')
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const events = buf.split('\n\n')
        buf = events.pop() ?? ''
        for (const ev of events) {
          const line = ev.replace(/^data: /, '').trim()
          if (!line) continue
          try {
            const msg = JSON.parse(line)
            if (msg.type === 'connected') { toast.success('Connected!'); loadAccounts() }
            else if (msg.type === 'error') toast.error(msg.message ?? 'Browser connect failed')
          } catch {}
        }
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Browser connect failed')
    } finally {
      setConnecting(false)
    }
  }

  async function refreshToken() {
    if (!accountId) return
    setRefreshingToken(true)
    try {
      const res = await fetch('/api/instagram/refresh-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success('Token refreshed (valid 60 more days)')
      loadAccounts()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Refresh failed')
    } finally { setRefreshingToken(false) }
  }

  async function saveDriveFolder(raw: string) {
    if (!accountId) return
    const folderId = raw.match(/[-\w]{25,}/)?.[0] ?? raw.trim()
    if (!folderId) return
    await fetch('/api/instagram/accounts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: accountId, driveFolderId: folderId }),
    })
    setDriveFolderInput(folderId)
    loadAccounts()
    toast.success('Drive folder saved')
  }

  async function scanDrive() {
    if (!accountId) return
    setLoadingDrive(true)
    setDriveFiles([])
    try {
      const res = await fetch(`/api/google/drive-files?accountId=${accountId}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setDriveFiles(data.files ?? [])
      if (!data.files?.length) toast.info('No new videos found in Drive folder')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Drive scan failed')
    } finally { setLoadingDrive(false) }
  }

  async function addToQueue(file: DriveFile) {
    const cat = pendingCategory.trim() || null
    const res = await fetch('/api/instagram/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, category: cat, items: [{ driveFileId: file.id, filename: file.name }] }),
    })
    const data = await res.json()
    if (!res.ok) { toast.error(data.error); return }
    toast.success(`Added "${file.name}"${cat ? ` → ${cat}` : ''}`)
    setDriveFiles(prev => prev.filter(f => f.id !== file.id))
    loadQueue()
  }

  async function addAllToQueue() {
    if (!driveFiles.length) return
    const cat = pendingCategory.trim() || null
    const res = await fetch('/api/instagram/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, category: cat, items: driveFiles.map(f => ({ driveFileId: f.id, filename: f.name })) }),
    })
    const data = await res.json()
    if (!res.ok) { toast.error(data.error); return }
    toast.success(`Added ${data.inserted} videos${cat ? ` → ${cat}` : ''}`)
    setDriveFiles([])
    loadQueue()
  }

  async function deleteAllQueue(category?: string) {
    if (!accountId) return
    const label = category ? `category "${category}"` : 'all pending'
    if (!confirm(`Delete ${label} items from queue?`)) return
    const res = await fetch('/api/instagram/queue', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, ...(category ? { category } : {}) }),
    })
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return }
    toast.success(`Deleted ${label}`)
    loadQueue()
  }

  async function deleteAllFailed() {
    if (!accountId) return
    if (!confirm(`Delete all failed items from queue?`)) return
    const res = await fetch('/api/instagram/queue', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, statusFilter: ['failed'] }),
    })
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return }
    toast.success('Deleted all failed')
    loadQueue()
  }

  async function publishNow(itemId: string) {
    setPublishing(itemId)
    try {
      const res = await fetch('/api/instagram/publish-reel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queueItemId: itemId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success('Reel published!')
      loadQueue()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Publish failed')
    } finally { setPublishing(null) }
  }

  async function updateItem(id: string, patch: { caption?: string; scheduledAt?: string }) {
    await fetch('/api/instagram/queue', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...patch }),
    })
  }

  async function deleteItem(id: string) {
    await fetch('/api/instagram/queue', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    loadQueue()
  }

  function toggleSelect(id: string) {
    setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  function toggleSelectAll() {
    const unconnected = accounts.filter(a => !a.connected).map(a => a.id)
    setSelectedIds(selectedIds.size === unconnected.length ? new Set() : new Set(unconnected))
  }

  function selectAll() {
    setSelectedIds(new Set(accounts.map(a => a.id)))
  }

  async function bulkAction(action: 'disconnect' | 'clear-proxy' | 'disconnect-and-clear-proxy' | 'delete') {
    if (!selectedIds.size) return
    const label = action === 'disconnect' ? 'Disconnect' : action === 'clear-proxy' ? 'Clear proxy' : action === 'delete' ? 'Delete' : 'Disconnect + Clear proxy'
    if (!confirm(`${label} for ${selectedIds.size} selected account(s)?`)) return
    const res = await fetch('/api/instagram/bulk-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountIds: Array.from(selectedIds), action }),
    })
    const data = await res.json()
    if (!res.ok) { toast.error(data.error); return }
    toast.success(`${label}: ${data.affected} accounts updated`)
    setSelectedIds(new Set())
    loadAccounts()
  }

  async function startBulkConnect() {
    if (!selectedIds.size || bulkRunning) return
    const ids = Array.from(selectedIds)
    setBulkRunning(true)
    setBulkProgress({ done: 0, total: ids.length })
    const init: BulkStatus = {}
    ids.forEach(id => { init[id] = 'idle' })
    setBulkStatus(init)

    try {
      const res = await fetch('/api/instagram/bulk-connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountIds: ids }),
      })
      if (!res.body) throw new Error('No response stream')

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const events = buf.split('\n\n')
        buf = events.pop() ?? ''
        for (const ev of events) {
          const line = ev.replace(/^data: /, '').trim()
          if (!line) continue
          try {
            const msg = JSON.parse(line)
            if (msg.type === 'connecting') setBulkStatus(p => ({ ...p, [msg.accountId]: 'connecting' }))
            else if (msg.type === 'progress') setBulkStatus(p => ({ ...p, [msg.accountId]: 'login' }))
            else if (msg.type === 'connected') {
              setBulkStatus(p => ({ ...p, [msg.accountId]: 'connected' }))
              setBulkProgress(p => ({ ...p, done: p.done + 1 }))
              setSelectedIds(p => { const n = new Set(p); n.delete(msg.accountId); return n })
            } else if (msg.type === 'error') {
              setBulkStatus(p => ({ ...p, [msg.accountId]: 'error' }))
              setBulkMessages(p => ({ ...p, [msg.accountId]: msg.message }))
              setBulkProgress(p => ({ ...p, done: p.done + 1 }))
            } else if (msg.type === 'done') {
              toast.success(`Done: ${msg.connected} connected, ${msg.failed} failed`)
              loadAccounts()
            }
          } catch {}
        }
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Bulk connect failed')
    } finally { setBulkRunning(false) }
  }

  async function startBulkBrowserConnect() {
    if (!selectedIds.size || bulkRunning) return
    const ids = Array.from(selectedIds)
    setBulkRunning(true)
    setBulkMode('browser')
    setBulkProgress({ done: 0, total: ids.length })
    const init: BulkStatus = {}
    ids.forEach(id => { init[id] = 'idle' })
    setBulkStatus(init)

    try {
      const res = await fetch('/api/instagram/bulk-browser-connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountIds: ids }),
      })
      if (!res.body) throw new Error('No response stream')

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const events = buf.split('\n\n')
        buf = events.pop() ?? ''
        for (const ev of events) {
          const line = ev.replace(/^data: /, '').trim()
          if (!line) continue
          try {
            const msg = JSON.parse(line)
            if (msg.type === 'opening') setBulkStatus(p => ({ ...p, [msg.accountId]: 'connecting' }))
            else if (msg.type === 'waiting') setBulkStatus(p => ({ ...p, [msg.accountId]: 'login' }))
            else if (msg.type === 'connected') {
              setBulkStatus(p => ({ ...p, [msg.accountId]: 'connected' }))
              setBulkProgress(p => ({ ...p, done: p.done + 1 }))
              setSelectedIds(p => { const n = new Set(p); n.delete(msg.accountId); return n })
            } else if (msg.type === 'error') {
              setBulkStatus(p => ({ ...p, [msg.accountId]: 'error' }))
              setBulkMessages(p => ({ ...p, [msg.accountId]: msg.message }))
              setBulkProgress(p => ({ ...p, done: p.done + 1 }))
            } else if (msg.type === 'done') {
              toast.success(`Done: ${msg.connected} connected, ${msg.failed} failed`)
              loadAccounts()
            }
          } catch {}
        }
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Bulk browser connect failed')
    } finally { setBulkRunning(false) }
  }

  async function importCSV(file: File) {
    setImporting(true)
    const fd = new FormData()
    fd.append('file', file)
    try {
      const res = await fetch('/api/instagram/import-csv', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success(`Imported: ${data.imported} new, ${data.updated} updated`)
      if (data.errors?.length) toast.error(`Skipped: ${data.errors[0]}`)
      loadAccounts()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Import failed')
    } finally { setImporting(false) }
  }

  const pending = queue.filter(q => q.status === 'pending')
  const done = queue.filter(q => q.status === 'done')
  const failed = queue.filter(q => q.status === 'failed')
  const unconnected = accounts.filter(a => !a.connected)

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel */}
      <div className="w-80 shrink-0 border-r border-border bg-sidebar/30 flex flex-col overflow-y-auto">
        <div className="px-5 py-5 space-y-4">
          <div className="flex items-center gap-2">
            <Clapperboard className="w-4 h-4 text-pink-400" />
            <p className="font-semibold text-sm">Instagram Reels</p>
          </div>

          {/* Tabs */}
          <div className="flex rounded-lg border border-border overflow-hidden text-xs">
            <button
              className={`flex-1 py-1.5 font-medium transition-colors ${tab === 'queue' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => setTab('queue')}
            >Queue</button>
            <button
              className={`flex-1 py-1.5 font-medium transition-colors ${tab === 'bulk' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => setTab('bulk')}
            >Bulk Connect</button>
          </div>

          {tab === 'queue' && (
            <>
              {/* Connect new account via browser — always accessible */}
              <Button
                variant="outline"
                className="w-full border-pink-500/40 text-pink-400 hover:bg-pink-500/10 text-xs"
                disabled={openBrowserRunning}
                onClick={async () => {
                  setOpenBrowserRunning(true)
                  toast.info('Opening Chrome... log in to Instagram, window closes automatically.', { duration: 15000 })
                  try {
                    await fetch('/api/instagram/open-browser', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
                    const poll = setInterval(async () => {
                      const s = await fetch('/api/instagram/open-browser').then(r => r.json())
                      if (!s.active) {
                        clearInterval(poll)
                        setOpenBrowserRunning(false)
                        if (s.done) { toast.success('Account connected!'); loadAccounts() }
                        else if (s.error) toast.error(s.error)
                        else toast.info('Browser closed without login')
                      }
                    }, 3000)
                  } catch { setOpenBrowserRunning(false) }
                }}
              >
                {openBrowserRunning
                  ? <><Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />Browser open — log in...</>
                  : <><Monitor className="w-3.5 h-3.5 mr-2" />Connect new account via Browser</>
                }
              </Button>

              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Account</p>
                <Select value={accountId} onValueChange={v => setAccountId(v ?? '')}>
                  <SelectTrigger><SelectValue placeholder="Select account..." /></SelectTrigger>
                  <SelectContent>
                    {accounts.map(a => (
                      <SelectItem key={a.id} value={a.id}>
                        {prettyAccountName(a.ig_username ?? a.name)}
                        {a.connected ? ' ✓' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {(() => {
                const acc = accounts.find(a => a.id === accountId)
                const tokenExpiresAt = acc?.token_expires_at ? new Date(acc.token_expires_at) : null
                const daysLeft = tokenExpiresAt ? Math.ceil((tokenExpiresAt.getTime() - Date.now()) / 86400000) : null
                return (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">Instagram Auth</p>
                    {daysLeft !== null && daysLeft <= 7 && (
                      <div className="flex items-center gap-1.5 text-xs text-yellow-400 bg-yellow-500/10 rounded-lg px-3 py-2">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                        Token expires in {daysLeft}d
                      </div>
                    )}
                    <Button
                      variant="outline"
                      className="w-full border-pink-500/30 text-pink-400 hover:bg-pink-500/10 hover:border-pink-500/50"
                      onClick={connectWithInstagram}
                      disabled={!accountId || connecting}
                    >
                      {connecting
                        ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Connecting...</>
                        : <><Link2 className="w-4 h-4 mr-2" />{acc?.connected ? 'Reconnect' : acc?.has_password ? 'Connect (Private API)' : 'Open Browser & Log In'}</>
                      }
                    </Button>
                    {acc?.connected && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="w-full h-7 text-xs text-muted-foreground"
                        onClick={refreshToken}
                        disabled={refreshingToken}
                      >
                        {refreshingToken
                          ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Refreshing...</>
                          : <><RefreshCw className="w-3 h-3 mr-1.5" />Refresh token</>
                        }
                      </Button>
                    )}
                  </div>
                )
              })()}

              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">Google Drive</p>
                <Input
                  value={driveFolderInput}
                  onChange={e => setDriveFolderInput(e.target.value)}
                  onBlur={e => saveDriveFolder(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && saveDriveFolder(driveFolderInput)}
                  placeholder="Folder URL ili ID..."
                  className="text-xs h-8 font-mono"
                  disabled={!accountId}
                />
                <Button className="w-full" onClick={scanDrive} disabled={loadingDrive || !accountId || !driveFolderInput}>
                  {loadingDrive
                    ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Scanning...</>
                    : <><RefreshCw className="w-4 h-4 mr-2" />Scan Drive for videos</>
                  }
                </Button>
              </div>

              {/* Categories */}
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                  <Tag className="w-3 h-3" />Kategorije
                </p>
                <div className="flex gap-1.5">
                  <Input
                    value={newCategory}
                    onChange={e => setNewCategory(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && newCategory.trim()) {
                        const cat = newCategory.trim()
                        setCategories(prev => prev.includes(cat) ? prev : [...prev, cat])
                        setPendingCategory(cat)
                        setCategoryFilter(cat)
                        setNewCategory('')
                      }
                    }}
                    placeholder="Nova kategorija..."
                    className="text-xs h-8 flex-1"
                    disabled={!accountId}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 px-2 shrink-0"
                    disabled={!newCategory.trim()}
                    onClick={() => {
                      const cat = newCategory.trim()
                      setCategories(prev => prev.includes(cat) ? prev : [...prev, cat])
                      setPendingCategory(cat)
                      setCategoryFilter(cat)
                      setNewCategory('')
                    }}
                  >
                    <Plus className="w-3 h-3" />
                  </Button>
                </div>
                {(categories.length > 0 || categoryFilter !== '__all__') && (
                  <div className="flex flex-wrap gap-1">
                    <button
                      onClick={() => setCategoryFilter('__all__')}
                      className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${categoryFilter === '__all__' ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:border-foreground/40'}`}
                    >
                      All
                    </button>
                    {categories.map(cat => (
                      <button
                        key={cat}
                        onClick={() => { setCategoryFilter(cat); setPendingCategory(cat) }}
                        className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors flex items-center gap-1 ${categoryFilter === cat ? 'bg-pink-600 text-white border-pink-600' : 'border-border text-muted-foreground hover:border-pink-500/50'}`}
                      >
                        {cat}
                      </button>
                    ))}
                  </div>
                )}
                {categoryFilter !== '__all__' && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full h-7 text-xs border-destructive/40 text-destructive hover:bg-destructive/10"
                    onClick={() => deleteAllQueue(categoryFilter)}
                    disabled={!accountId}
                  >
                    <Trash2 className="w-3 h-3 mr-1.5" />
                    Delete all &quot;{categoryFilter}&quot;
                  </Button>
                )}
              </div>

              {queue.length > 0 && (
                <div className="space-y-2">
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-lg bg-secondary/50 px-2 py-2">
                      <p className="text-lg font-bold">{pending.length}</p>
                      <p className="text-[10px] text-muted-foreground">Pending</p>
                    </div>
                    <div className="rounded-lg bg-green-500/10 px-2 py-2">
                      <p className="text-lg font-bold text-green-400">{done.length}</p>
                      <p className="text-[10px] text-muted-foreground">Published</p>
                    </div>
                    <div className="rounded-lg bg-destructive/10 px-2 py-2">
                      <p className="text-lg font-bold text-destructive">{failed.length}</p>
                      <p className="text-[10px] text-muted-foreground">Failed</p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full h-7 text-xs border-destructive/40 text-destructive hover:bg-destructive/10"
                    onClick={() => deleteAllQueue()}
                    disabled={!accountId || pending.length === 0}
                  >
                    <Trash2 className="w-3 h-3 mr-1.5" />Delete all pending ({pending.length})
                  </Button>
                  {failed.length > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full h-7 text-xs border-destructive/40 text-destructive hover:bg-destructive/10"
                      onClick={deleteAllFailed}
                      disabled={!accountId}
                    >
                      <Trash2 className="w-3 h-3 mr-1.5" />Delete all failed ({failed.length})
                    </Button>
                  )}
                </div>
              )}
            </>
          )}

          {tab === 'bulk' && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground leading-relaxed">
                Import accounts via CSV, then bulk-authenticate all at once.
              </p>
              <input ref={csvRef} type="file" accept=".csv" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) importCSV(f); e.target.value = '' }} />
              <Button variant="outline" className="w-full" onClick={() => csvRef.current?.click()} disabled={importing}>
                {importing ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Importing...</> : <><Upload className="w-4 h-4 mr-2" />Import CSV</>}
              </Button>
              <Button variant="ghost" size="sm" className="w-full h-7 text-xs text-muted-foreground justify-start"
                onClick={downloadCSVExample}>
                <Download className="w-3 h-3 mr-1.5" />Download CSV example
              </Button>

              {/* Manual add */}
              <button
                className="w-full flex items-center gap-2 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setShowAddForm(p => !p)}
              >
                <Plus className="w-3.5 h-3.5 shrink-0 text-primary" />
                <span className="font-medium text-foreground">Add manually</span>
                <ChevronDown className={`w-3.5 h-3.5 ml-auto transition-transform ${showAddForm ? 'rotate-180' : ''}`} />
              </button>
              {showAddForm && (
                <div className="border border-border/50 rounded-lg p-3 space-y-2">
                  <Input placeholder="Display name *" value={addForm.name}
                    onChange={e => setAddForm(p => ({ ...p, name: e.target.value }))}
                    className="h-8 text-xs" />
                  <Input placeholder="Instagram username" value={addForm.username}
                    onChange={e => setAddForm(p => ({ ...p, username: e.target.value }))}
                    className="h-8 text-xs font-mono" />
                  <Input type="password" placeholder="Password" value={addForm.password}
                    onChange={e => setAddForm(p => ({ ...p, password: e.target.value }))}
                    className="h-8 text-xs" />
                  <Input placeholder="2FA secret (optional)" value={addForm.totp}
                    onChange={e => setAddForm(p => ({ ...p, totp: e.target.value }))}
                    className="h-8 text-xs font-mono" />
                  <Input placeholder="Proxy URL (optional)" value={addForm.proxy}
                    onChange={e => setAddForm(p => ({ ...p, proxy: e.target.value }))}
                    className="h-8 text-xs font-mono" />
                  <Button className="w-full h-8 text-xs bg-pink-600 hover:bg-pink-700"
                    disabled={!addForm.name.trim() || addingAccount}
                    onClick={async () => {
                      setAddingAccount(true)
                      try {
                        const res = await fetch('/api/instagram/accounts', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            name: addForm.name.trim(),
                            igUsername: addForm.username.trim() || null,
                            igPassword: addForm.password || null,
                            igTotpSecret: addForm.totp.trim() || null,
                            proxyUrl: addForm.proxy.trim() || null,
                          }),
                        })
                        const data = await res.json()
                        if (!res.ok) throw new Error(data.error)
                        toast.success(`Added @${addForm.username || addForm.name}`)
                        setAddForm({ name: '', username: '', password: '', totp: '', proxy: '' })
                        setShowAddForm(false)
                        loadAccounts()
                      } catch (e: unknown) {
                        toast.error(e instanceof Error ? e.message : 'Failed to add account')
                      } finally { setAddingAccount(false) }
                    }}>
                    {addingAccount ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Adding...</> : <><Plus className="w-3 h-3 mr-1.5" />Add account</>}
                  </Button>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <Button className="bg-pink-600 hover:bg-pink-700 text-xs"
                  onClick={startBulkConnect} disabled={!selectedIds.size || bulkRunning}>
                  {bulkRunning && bulkMode === 'api'
                    ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" />{bulkProgress.done}/{bulkProgress.total}</>
                    : <><Users className="w-3 h-3 mr-1" />API ({selectedIds.size})</>
                  }
                </Button>
                <Button variant="outline" className="border-blue-500/40 text-blue-400 hover:bg-blue-500/10 text-xs"
                  onClick={startBulkBrowserConnect} disabled={!selectedIds.size || bulkRunning}>
                  {bulkRunning && bulkMode === 'browser'
                    ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" />{bulkProgress.done}/{bulkProgress.total}</>
                    : <><Monitor className="w-3 h-3 mr-1" />Browser ({selectedIds.size})</>
                  }
                </Button>
              </div>

              {selectedIds.size > 0 && !bulkRunning && (
                <div className="border-t border-border/50 pt-3 space-y-1.5">
                  <p className="text-xs text-muted-foreground font-medium">Actions for selected ({selectedIds.size})</p>
                  <Button variant="outline" size="sm"
                    className="w-full h-7 text-xs border-orange-500/40 text-orange-400 hover:bg-orange-500/10"
                    onClick={() => bulkAction('clear-proxy')}>
                    <WifiOff className="w-3 h-3 mr-1.5" />Clear proxy
                  </Button>
                  <Button variant="outline" size="sm"
                    className="w-full h-7 text-xs border-yellow-500/40 text-yellow-400 hover:bg-yellow-500/10"
                    onClick={() => bulkAction('disconnect')}>
                    <X className="w-3 h-3 mr-1.5" />Disconnect
                  </Button>
                  <Button variant="outline" size="sm"
                    className="w-full h-7 text-xs border-destructive/40 text-destructive hover:bg-destructive/10"
                    onClick={() => bulkAction('disconnect-and-clear-proxy')}>
                    <Trash2 className="w-3 h-3 mr-1.5" />Disconnect + Clear proxy
                  </Button>
                  <Button variant="destructive" size="sm"
                    className="w-full h-7 text-xs mt-1"
                    onClick={() => bulkAction('delete')}>
                    <Trash2 className="w-3 h-3 mr-1.5" />Delete accounts ({selectedIds.size})
                  </Button>
                </div>
              )}
              {(bulkRunning || bulkProgress.total > 0) && (
                <div className="space-y-1">
                  <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
                    <div className="h-full bg-pink-500 transition-all duration-500"
                      style={{ width: `${bulkProgress.total ? (bulkProgress.done / bulkProgress.total) * 100 : 0}%` }} />
                  </div>
                  <p className="text-xs text-muted-foreground text-center">{bulkProgress.done} / {bulkProgress.total}</p>
                </div>
              )}
              {!bulkRunning && Object.values(bulkStatus).some(s => s === 'error') && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full h-7 text-xs border-yellow-500/40 text-yellow-400 hover:bg-yellow-500/10"
                  onClick={() => {
                    const failedIds = Object.entries(bulkStatus)
                      .filter(([, s]) => s === 'error')
                      .map(([id]) => id)
                    setSelectedIds(new Set(failedIds))
                    startBulkBrowserConnect()
                  }}
                >
                  <Monitor className="w-3 h-3 mr-1.5" />
                  Retry {Object.values(bulkStatus).filter(s => s === 'error').length} failed with Browser
                </Button>
              )}
            </div>
          )}

        </div>
      </div>

      {/* Right panel */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {tab === 'queue' && (
          <>
            {driveFiles.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-sm font-semibold flex items-center gap-2">
                    <HardDrive className="w-4 h-4 text-muted-foreground" />
                    New videos ({driveFiles.length})
                  </p>
                  <div className="flex items-center gap-2">
                    <Select value={pendingCategory || '__none__'} onValueChange={(v) => setPendingCategory((v ?? '__none__') === '__none__' ? '' : (v ?? ''))}>
                      <SelectTrigger className="h-7 text-xs w-36">
                        <SelectValue placeholder="Kategorija..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Bez kategorije</SelectItem>
                        {categories.map(cat => <SelectItem key={cat} value={cat}>{cat}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={addAllToQueue}>
                      <Plus className="w-3 h-3 mr-1" />Add all
                    </Button>
                  </div>
                </div>
                <div className="space-y-2">
                  {driveFiles.map(file => (
                    <div key={file.id} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{file.name}</p>
                        <p className="text-xs text-muted-foreground">{(Number(file.size) / 1024 / 1024).toFixed(1)} MB</p>
                      </div>
                      <Button size="sm" variant="outline" className="h-7 text-xs shrink-0" onClick={() => addToQueue(file)}>
                        <Plus className="w-3 h-3 mr-1" />Add
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {loadingQueue ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : queue.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
                <Clapperboard className="w-16 h-16 opacity-10 mb-4" />
                <p className="text-sm">No videos in queue</p>
                <p className="text-xs opacity-60 mt-1">Connect an account, scan Drive, add videos</p>
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-sm font-semibold flex items-center gap-2">
                    Queue
                    {categoryFilter !== '__all__' && (
                      <span className="text-xs font-normal bg-pink-500/15 text-pink-400 px-2 py-0.5 rounded-full flex items-center gap-1">
                        <Tag className="w-3 h-3" />{categoryFilter}
                        <button onClick={() => setCategoryFilter('__all__')} className="ml-0.5 hover:text-white"><X className="w-2.5 h-2.5" /></button>
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">{queue.length} items</p>
                </div>
                <div className="space-y-3">
                  {queue.map(item => (
                    <div key={item.id} className="rounded-xl border border-border bg-card p-4 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{item.filename}</p>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            <StatusBadge status={item.status} />
                            {item.category && (
                              <button
                                onClick={() => setCategoryFilter(item.category!)}
                                className="text-[10px] px-1.5 py-0.5 rounded bg-pink-500/15 text-pink-400 hover:bg-pink-500/25 transition-colors flex items-center gap-0.5"
                              >
                                <Tag className="w-2.5 h-2.5" />{item.category}
                              </button>
                            )}
                            {item.scheduled_at && (
                              <span className="text-xs text-muted-foreground">
                                {new Date(item.scheduled_at).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })}
                              </span>
                            )}
                            {item.published_at && (
                              <span className="text-xs text-green-400">
                                {new Date(item.published_at).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })}
                              </span>
                            )}
                          </div>
                          {item.error_message && (
                            <p className="text-xs text-destructive mt-1 line-clamp-2">{item.error_message}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {item.instagram_media_id && (
                            <a href={`https://www.instagram.com/p/${item.instagram_media_id}`}
                              target="_blank" rel="noopener noreferrer"
                              className="w-7 h-7 rounded-full border border-border flex items-center justify-center hover:border-primary transition-colors">
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                          {item.status === 'pending' && (
                            <>
                              <Button size="sm" className="h-7 text-xs bg-pink-600 hover:bg-pink-700"
                                onClick={() => publishNow(item.id)} disabled={publishing === item.id}>
                                {publishing === item.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <><Play className="w-3 h-3 mr-1" />Post now</>}
                              </Button>
                              <button onClick={() => deleteItem(item.id)}
                                className="w-7 h-7 rounded-full border border-border flex items-center justify-center hover:border-destructive hover:text-destructive transition-colors">
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      {item.status === 'pending' && (
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <p className="text-xs text-muted-foreground">Caption</p>
                            <Textarea rows={2} defaultValue={item.caption} placeholder="Caption..."
                              className="text-xs resize-none"
                              onBlur={e => updateItem(item.id, { caption: e.target.value })} />
                          </div>
                          <div className="space-y-1">
                            <p className="text-xs text-muted-foreground">Schedule</p>
                            <Input type="datetime-local"
                              defaultValue={item.scheduled_at ? item.scheduled_at.slice(0, 16) : ''}
                              className="text-xs h-8"
                              onBlur={e => updateItem(item.id, { scheduledAt: e.target.value ? new Date(e.target.value).toISOString() : undefined })} />
                            <p className="text-[10px] text-muted-foreground">Empty = manual post</p>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {tab === 'bulk' && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-sm font-semibold">Instagram Accounts</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {accounts.filter(a => a.connected).length} connected · {unconnected.length} not connected
                </p>
              </div>
              <div className="flex items-center gap-2">
                {unconnected.length > 0 && (
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={toggleSelectAll}>
                    {selectedIds.size === unconnected.length ? 'Deselect all' : 'Select unconnected'}
                  </Button>
                )}
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={selectedIds.size === accounts.length ? () => setSelectedIds(new Set()) : selectAll}>
                  {selectedIds.size === accounts.length ? 'Deselect all' : 'Select all'}
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              {accounts.map(acc => {
                const selected = selectedIds.has(acc.id)
                const status = bulkStatus[acc.id]
                return (
                  <div key={acc.id}
                    className={`flex items-center gap-3 p-3 rounded-xl border transition-colors ${selected ? 'border-primary/50 bg-primary/5' : 'border-border bg-card'}`}>
                    {acc.connected
                      ? <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
                      : <input type="checkbox" checked={selected} onChange={() => toggleSelect(acc.id)}
                          className="w-4 h-4 shrink-0 accent-pink-500" disabled={bulkRunning} />
                    }
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium">{prettyAccountName(acc.ig_username ?? acc.name)}</p>
                        {acc.ig_username && <span className="text-xs text-pink-400">@{acc.ig_username}</span>}
                        {acc.connected && <span className="text-[10px] bg-green-500/15 text-green-400 rounded px-1">connected</span>}
                        {acc.google_drive_folder_id && <span className="text-[10px] bg-yellow-500/15 text-yellow-400 rounded px-1">drive</span>}
                      </div>
                      <div className="flex items-center gap-3 mt-0.5">
                        {acc.proxy_url
                          ? <span className="text-xs text-muted-foreground font-mono flex items-center gap-1">
                              <Wifi className="w-2.5 h-2.5" />{acc.proxy_url.replace(/^https?:\/\/[^@]+@/, '')}
                            </span>
                          : <span className="text-xs text-muted-foreground flex items-center gap-1">
                              <WifiOff className="w-2.5 h-2.5" />No proxy
                            </span>
                        }
                      </div>
                      {status && status !== 'idle' && (
                        <p className={`text-xs mt-0.5 flex items-center gap-1 ${status === 'error' ? 'text-destructive' : status === 'connected' ? 'text-green-400' : 'text-yellow-400'}`}>
                          {(status === 'connecting' || status === 'login') && <Loader2 className="w-3 h-3 animate-spin" />}
                          {status === 'connected' && <CheckCircle2 className="w-3 h-3" />}
                          {status === 'error' && <XCircle className="w-3 h-3" />}
                          {status === 'connecting' && 'Connecting...'}
                          {status === 'login' && 'Logging in...'}
                          {status === 'connected' && 'Connected'}
                          {status === 'error' && (bulkMessages[acc.id] ?? 'Error')}
                        </p>
                      )}
                    </div>
                    <Badge variant="secondary" className={`text-xs shrink-0 ${acc.connected ? 'text-green-400' : 'text-muted-foreground'}`}>
                      {acc.connected ? 'Connected' : 'Not connected'}
                    </Badge>
                  </div>
                )
              })}

              {accounts.length === 0 && (
                <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                  <Users className="w-12 h-12 opacity-10 mb-3" />
                  <p className="text-sm">No accounts yet</p>
                  <p className="text-xs opacity-60 mt-1">Import a CSV to add accounts</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
