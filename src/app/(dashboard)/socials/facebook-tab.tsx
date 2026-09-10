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
import {
  Film,
  Play,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  Trash2,
  ExternalLink,
  Upload,
  Tag,
  X,
  CalendarClock,
  Plus,
  ChevronDown,
  FolderSync,
  LogIn,
} from 'lucide-react'

interface FbPage {
  id: string
  name: string
  page_id: string
  google_drive_folder_id: string | null
  published_count: number
  pending_count: number
  failed_count: number
}

interface QueueItem {
  id: string
  drive_file_id: string | null
  filename: string
  status: 'pending' | 'publishing' | 'done' | 'failed'
  caption: string
  category: string | null
  thumbnail_url: string | null
  scheduled_at: string | null
  published_at: string | null
  facebook_video_id: string | null
  error_message: string | null
  created_at: string
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

export function FacebookTab() {
  const [pages, setPages] = useState<FbPage[]>([])
  const [pageId, setPageId] = useState('')
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [categoryFilter, setCategoryFilter] = useState('__all__')
  const [newCategory, setNewCategory] = useState('')
  const [uploadCategory, setUploadCategory] = useState('')
  const [loadingQueue, setLoadingQueue] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState({ done: 0, total: 0 })
  const [publishing, setPublishing] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [showAddPage, setShowAddPage] = useState(false)
  const [addingPage, setAddingPage] = useState(false)
  const [addPageForm, setAddPageForm] = useState({ name: '', pageId: '', accessToken: '', driveFolder: '' })
  const [driveFolderInput, setDriveFolderInput] = useState('')
  const [savingDriveFolder, setSavingDriveFolder] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [massScheduleDate, setMassScheduleDate] = useState('')
  const [massScheduling, setMassScheduling] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const loadPages = useCallback(async () => {
    const res = await fetch('/api/facebook/pages').catch(() => null)
    if (res?.ok) {
      const data: FbPage[] = await res.json()
      setPages(data)
      if (data.length && !pageId) setPageId(data[0].id)
    }
  }, [pageId])

  useEffect(() => { loadPages() }, [loadPages])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('facebook_connected')) {
      const n = params.get('facebook_connected')
      toast.success(`Connected ${n} Facebook Page${n === '1' ? '' : 's'}!`)
      loadPages()
      window.history.replaceState({}, '', window.location.pathname)
    } else if (params.get('facebook_error')) {
      toast.error(`Facebook error: ${params.get('facebook_error')}`)
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [loadPages])

  const loadQueue = useCallback(async () => {
    if (!pageId) return
    setLoadingQueue(true)
    try {
      const params = new URLSearchParams({ pageId })
      if (categoryFilter !== '__all__') params.set('category', categoryFilter)
      const res = await fetch(`/api/facebook/queue?${params}`)
      const data = await res.json()
      setQueue(Array.isArray(data) ? data : (data.items ?? []))
      if (data.categories) setCategories(data.categories)
    } catch { toast.error('Failed to load queue') }
    finally { setLoadingQueue(false) }
  }, [pageId, categoryFilter])

  useEffect(() => { loadQueue() }, [loadQueue])

  async function addPage() {
    if (!addPageForm.name.trim() || !addPageForm.pageId.trim() || !addPageForm.accessToken.trim()) return
    setAddingPage(true)
    try {
      const res = await fetch('/api/facebook/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: addPageForm.name.trim(),
          pageId: addPageForm.pageId.trim(),
          accessToken: addPageForm.accessToken.trim(),
          googleDriveFolderId: addPageForm.driveFolder.match(/[-\w]{25,}/)?.[0] ?? addPageForm.driveFolder.trim() ?? null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success(`Added page "${addPageForm.name}"`)
      setAddPageForm({ name: '', pageId: '', accessToken: '', driveFolder: '' })
      setShowAddPage(false)
      setPageId(data.id)
      loadPages()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to add page')
    } finally {
      setAddingPage(false)
    }
  }

  async function saveDriveFolder(raw: string) {
    if (!pageId) return
    const folderId = raw.match(/[-\w]{25,}/)?.[0] ?? raw.trim()
    if (!folderId) return
    setSavingDriveFolder(true)
    try {
      await fetch('/api/facebook/pages', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: pageId, googleDriveFolderId: folderId }),
      })
      toast.success('Drive folder saved')
      loadPages()
    } finally {
      setSavingDriveFolder(false)
    }
  }

  async function handleUpload(files: FileList | null) {
    if (!files?.length || !pageId) return
    setUploading(true)
    setUploadProgress({ done: 0, total: files.length })
    try {
      const fd = new FormData()
      fd.append('pageId', pageId)
      if (uploadCategory.trim()) fd.append('category', uploadCategory.trim())
      Array.from(files).forEach(f => fd.append('files', f))

      const res = await fetch('/api/facebook/upload', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      const ok = data.results.filter((r: { ok: boolean }) => r.ok).length
      const failed = data.results.length - ok
      toast.success(`Uploaded ${ok} video(s)${failed ? `, ${failed} failed` : ''} — captioned, thumbnailed, and scheduled`)
      setUploadProgress({ done: data.results.length, total: files.length })
      loadQueue()
      loadPages()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  async function updateItem(id: string, patch: { caption?: string; scheduledAt?: string }) {
    await fetch('/api/facebook/queue', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...patch }),
    })
  }

  async function deleteItem(id: string) {
    await fetch('/api/facebook/queue', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n })
    loadQueue()
  }

  async function deleteSelected() {
    if (!selectedIds.size) return
    if (!confirm(`Delete ${selectedIds.size} selected item(s)?`)) return
    await fetch('/api/facebook/queue', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: Array.from(selectedIds) }),
    })
    setSelectedIds(new Set())
    loadQueue()
  }

  async function syncDrive() {
    if (!pageId) return
    setSyncing(true)
    try {
      const res = await fetch('/api/facebook/sync-drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success(data.created > 0 ? `Synced ${data.created} video(s) from Drive` : 'Already up to date — nothing new in Drive')
      loadQueue()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Sync failed')
    } finally {
      setSyncing(false)
    }
  }

  async function publishNow(itemId: string) {
    setPublishing(itemId)
    try {
      const res = await fetch('/api/facebook/publish-reel', {
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

  function toggleSelect(id: string) {
    setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  function toggleSelectAllPending() {
    const pendingIds = queue.filter(q => q.status === 'pending').map(q => q.id)
    setSelectedIds(selectedIds.size === pendingIds.length ? new Set() : new Set(pendingIds))
  }

  async function massSchedule() {
    if (!selectedIds.size) return
    setMassScheduling(true)
    try {
      const res = await fetch('/api/facebook/queue/mass-schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selectedIds), startDate: massScheduleDate || undefined }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success(`Scheduled ${data.scheduled} video(s) across ${Math.ceil(data.scheduled / 3)} day(s)`)
      setSelectedIds(new Set())
      loadQueue()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Mass schedule failed')
    } finally { setMassScheduling(false) }
  }

  const pending = queue.filter(q => q.status === 'pending')
  const done = queue.filter(q => q.status === 'done')
  const failed = queue.filter(q => q.status === 'failed')
  const currentPage = pages.find(p => p.id === pageId)

  // Reset the (editable) Drive folder field whenever the selected page
  // changes — adjusted during render rather than in an effect, since it's
  // deriving local state from a prop change, not synchronizing with an
  // external system.
  const [driveFolderForPageId, setDriveFolderForPageId] = useState<string | null>(null)
  if (currentPage && driveFolderForPageId !== currentPage.id) {
    setDriveFolderForPageId(currentPage.id)
    setDriveFolderInput(currentPage.google_drive_folder_id ?? '')
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel */}
      <div className="w-80 shrink-0 border-r border-border bg-sidebar/30 flex flex-col overflow-y-auto">
        <div className="px-5 py-5 space-y-4">
          <div className="flex items-center gap-2">
            <Film className="w-4 h-4 text-blue-400" />
            <p className="font-semibold text-sm">Facebook Reels</p>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Page</p>
            <Select value={pageId} onValueChange={v => setPageId(v ?? '')}>
              <SelectTrigger>
                <SelectValue placeholder="Select page...">
                  {(value: string) => pages.find(p => p.id === value)?.name ?? 'Select page...'}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {pages.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>

            {currentPage && (
              <div className="space-y-1.5">
                <p className="text-[10px] text-muted-foreground">Drive folder (link or ID)</p>
                <div className="flex gap-1.5">
                  <Input value={driveFolderInput} onChange={e => setDriveFolderInput(e.target.value)}
                    placeholder="Paste Google Drive folder link..." className="text-xs h-8 font-mono" />
                  <Button size="sm" variant="outline" className="h-8 text-xs shrink-0" disabled={savingDriveFolder || !driveFolderInput.trim()}
                    onClick={() => saveDriveFolder(driveFolderInput)}>
                    {savingDriveFolder ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Save'}
                  </Button>
                </div>
                {!currentPage.google_drive_folder_id && (
                  <p className="text-[10px] text-yellow-400">No Drive folder configured for this page yet</p>
                )}
              </div>
            )}
            {currentPage?.google_drive_folder_id && (
              <Button size="sm" variant="outline" className="w-full h-8 text-xs" disabled={syncing} onClick={syncDrive}>
                {syncing ? <Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> : <FolderSync className="w-3 h-3 mr-1.5" />}
                Sync Drive folder
              </Button>
            )}

            {/* Connect another Facebook Page via OAuth */}
            <Button size="sm" className="w-full h-8 text-xs bg-blue-600 hover:bg-blue-700"
              onClick={() => { window.location.href = '/api/facebook/oauth' }}>
              <LogIn className="w-3.5 h-3.5 mr-1.5" />
              Connect with Facebook
            </Button>

            <button
              className="w-full flex items-center gap-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setShowAddPage(p => !p)}
            >
              <Plus className="w-3.5 h-3.5 shrink-0 text-primary" />
              <span className="font-medium text-foreground">Add manually (advanced)</span>
              <ChevronDown className={`w-3.5 h-3.5 ml-auto transition-transform ${showAddPage ? 'rotate-180' : ''}`} />
            </button>
            {showAddPage && (
              <div className="border border-border/50 rounded-lg p-3 space-y-2">
                <Input placeholder="Display name *" value={addPageForm.name}
                  onChange={e => setAddPageForm(p => ({ ...p, name: e.target.value }))}
                  className="h-8 text-xs" />
                <Input placeholder="Facebook Page ID *" value={addPageForm.pageId}
                  onChange={e => setAddPageForm(p => ({ ...p, pageId: e.target.value }))}
                  className="h-8 text-xs font-mono" />
                <Input type="password" placeholder="Page access token *" value={addPageForm.accessToken}
                  onChange={e => setAddPageForm(p => ({ ...p, accessToken: e.target.value }))}
                  className="h-8 text-xs font-mono" />
                <Input placeholder="Drive folder link/ID (optional)" value={addPageForm.driveFolder}
                  onChange={e => setAddPageForm(p => ({ ...p, driveFolder: e.target.value }))}
                  className="h-8 text-xs font-mono" />
                <Button className="w-full h-8 text-xs bg-blue-600 hover:bg-blue-700"
                  disabled={!addPageForm.name.trim() || !addPageForm.pageId.trim() || !addPageForm.accessToken.trim() || addingPage}
                  onClick={addPage}>
                  {addingPage ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Adding...</> : <><Plus className="w-3 h-3 mr-1.5" />Add page</>}
                </Button>
              </div>
            )}
          </div>

          {/* Bulk upload */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Bulk upload</p>
            <Input
              value={uploadCategory}
              onChange={e => setUploadCategory(e.target.value)}
              placeholder="Tag/category (optional)..."
              className="text-xs h-8"
            />
            <input ref={fileRef} type="file" accept="video/*" multiple className="hidden"
              onChange={e => { handleUpload(e.target.files); e.target.value = '' }} />
            <Button className="w-full" onClick={() => fileRef.current?.click()}
              disabled={uploading || !pageId || !currentPage?.google_drive_folder_id}>
              {uploading
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Uploading {uploadProgress.done}/{uploadProgress.total}...</>
                : <><Upload className="w-4 h-4 mr-2" />Upload videos...</>
              }
            </Button>
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              Each video is uploaded to Drive, captioned by Grok Vision, and dropped into the next
              open 3/day slot automatically — nothing left to do, edit caption or time below if needed.
            </p>
          </div>

          {/* Categories */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Tag className="w-3 h-3" />Tags
            </p>
            <div className="flex gap-1.5">
              <Input
                value={newCategory}
                onChange={e => setNewCategory(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && newCategory.trim()) {
                    setCategoryFilter(newCategory.trim())
                    setNewCategory('')
                  }
                }}
                placeholder="Filter by tag..."
                className="text-xs h-8 flex-1"
              />
            </div>
            {(categories.length > 0 || categoryFilter !== '__all__') && (
              <div className="flex flex-wrap gap-1">
                <button
                  onClick={() => setCategoryFilter('__all__')}
                  className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${categoryFilter === '__all__' ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:border-foreground/40'}`}
                >All</button>
                {categories.map(cat => (
                  <button key={cat} onClick={() => setCategoryFilter(cat)}
                    className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${categoryFilter === cat ? 'bg-blue-600 text-white border-blue-600' : 'border-border text-muted-foreground hover:border-blue-500/50'}`}
                  >{cat}</button>
                ))}
              </div>
            )}
          </div>

          {/* Mass schedule */}
          <div className="space-y-2 border-t border-border/50 pt-3">
            <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <CalendarClock className="w-3 h-3" />Mass schedule
            </p>
            <p className="text-[10px] text-muted-foreground">
              Fills morning/afternoon/evening slots, 3/day, starting from the date below, for every
              selected item ({selectedIds.size} selected).
            </p>
            <Input type="date" value={massScheduleDate} onChange={e => setMassScheduleDate(e.target.value)}
              className="text-xs h-8" />
            <Button size="sm" className="w-full h-8 text-xs bg-blue-600 hover:bg-blue-700"
              disabled={!selectedIds.size || massScheduling} onClick={massSchedule}>
              {massScheduling ? <Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> : <CalendarClock className="w-3 h-3 mr-1.5" />}
              Schedule {selectedIds.size} selected
            </Button>
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" className="flex-1 h-7 text-xs" onClick={toggleSelectAllPending}>
                {selectedIds.size === pending.length && pending.length > 0 ? 'Deselect all' : `Select all pending (${pending.length})`}
              </Button>
              {selectedIds.size > 0 && (
                <Button size="sm" variant="outline" className="h-7 text-xs border-destructive/40 text-destructive hover:bg-destructive/10"
                  onClick={deleteSelected}>
                  <Trash2 className="w-3 h-3" />
                </Button>
              )}
            </div>
          </div>

          {queue.length > 0 && (
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
          )}
        </div>
      </div>

      {/* Right panel */}
      <div className="flex-1 overflow-y-auto p-6">
        {loadingQueue ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : queue.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
            <Film className="w-16 h-16 opacity-10 mb-4" />
            <p className="text-sm">No videos in queue</p>
            <p className="text-xs opacity-60 mt-1">Upload videos to get started</p>
          </div>
        ) : (
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold flex items-center gap-2">
                Queue
                {categoryFilter !== '__all__' && (
                  <span className="text-xs font-normal bg-blue-500/15 text-blue-400 px-2 py-0.5 rounded-full flex items-center gap-1">
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
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      {item.status === 'pending' && (
                        <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleSelect(item.id)}
                          className="w-4 h-4 mt-0.5 shrink-0 accent-blue-500" />
                      )}
                      {item.thumbnail_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={item.thumbnail_url} alt="" className="w-12 h-[85px] rounded-md object-cover shrink-0 border border-border" />
                      ) : (
                        <div className="w-12 h-[85px] rounded-md bg-secondary/50 border border-border flex items-center justify-center shrink-0">
                          <Film className="w-4 h-4 text-muted-foreground opacity-40" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{item.filename}</p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <StatusBadge status={item.status} />
                          {item.category && (
                            <button onClick={() => setCategoryFilter(item.category!)}
                              className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 transition-colors flex items-center gap-0.5">
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
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {item.facebook_video_id && (
                        <a href={`https://facebook.com/reel/${item.facebook_video_id}/`}
                          target="_blank" rel="noopener noreferrer"
                          className="w-7 h-7 rounded-full border border-border flex items-center justify-center hover:border-primary transition-colors">
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                      {item.status === 'pending' && (
                        <>
                          <Button size="sm" className="h-7 text-xs bg-blue-600 hover:bg-blue-700"
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
                        <p className="text-xs text-muted-foreground">Caption (Grok-generated, editable)</p>
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
                        <p className="text-[10px] text-muted-foreground">Empty = manual post, or use Mass schedule</p>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
