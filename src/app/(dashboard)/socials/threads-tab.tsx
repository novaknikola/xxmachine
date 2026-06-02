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
  MessageSquare,
  Play,
  RefreshCw,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  Trash2,
  ExternalLink,
  Plus,
  Link2,
  AlertTriangle,
  Upload,
  Download,
  Users,
  WifiOff,
  X,
} from 'lucide-react'
import { prettyAccountName } from '@/lib/utils'

const CSV_EXAMPLE = [
  'name,threads_username,threads_password',
  'Nova Nikola,novaknikolaa,MyPassword123',
  'Jane Doe,janedoe_official,Hunter2!',
].join('\n')

function downloadCSVExample() {
  const blob = new Blob([CSV_EXAMPLE], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'threads_accounts_example.csv'
  a.click()
  URL.revokeObjectURL(url)
}

interface ThreadsAccount {
  id: string
  name: string
  threads_username: string | null
  threads_user_id: string | null
  connected: boolean
  token_expires_at: string | null
}

interface ThreadsPost {
  id: string
  content: string
  media_url: string | null
  media_type: 'TEXT' | 'IMAGE' | 'VIDEO'
  status: 'pending' | 'publishing' | 'done' | 'failed'
  threads_media_id: string | null
  error_message: string | null
  scheduled_at: string | null
  published_at: string | null
  created_at: string
}

function StatusBadge({ status }: { status: ThreadsPost['status'] }) {
  const map = {
    pending:    { label: 'Scheduled', icon: Clock },
    publishing: { label: 'Publishing...', icon: Loader2 },
    done:       { label: 'Published', icon: CheckCircle2 },
    failed:     { label: 'Failed', icon: XCircle },
  }
  const { label, icon: Icon } = map[status]
  return (
    <Badge variant={status === 'failed' ? 'destructive' : 'secondary'} className="text-xs gap-1">
      <Icon className={`w-3 h-3 ${status === 'done' ? 'text-green-400' : ''} ${status === 'publishing' ? 'animate-spin' : ''}`} />
      {label}
    </Badge>
  )
}

export function ThreadsTab() {
  const [tab, setTab] = useState<'queue' | 'bulk'>('queue')
  const [accounts, setAccounts] = useState<ThreadsAccount[]>([])
  const [accountId, setAccountId] = useState('')
  const [queue, setQueue] = useState<ThreadsPost[]>([])
  const [newAccountName, setNewAccountName] = useState('')
  const [addingAccount, setAddingAccount] = useState(false)
  const [newContent, setNewContent] = useState('')
  const [newMediaUrl, setNewMediaUrl] = useState('')
  const [newMediaType, setNewMediaType] = useState<'TEXT' | 'IMAGE' | 'VIDEO'>('TEXT')
  const [newScheduledAt, setNewScheduledAt] = useState('')
  const [addingPost, setAddingPost] = useState(false)
  const [publishing, setPublishing] = useState<string | null>(null)
  const [loadingQueue, setLoadingQueue] = useState(false)
  const [refreshingToken, setRefreshingToken] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)
  const csvRef = useRef<HTMLInputElement>(null)

  const loadAccounts = useCallback(async () => {
    const res = await fetch('/api/threads/accounts').catch(() => null)
    if (res?.ok) {
      const data = await res.json()
      const list: ThreadsAccount[] = Array.isArray(data) ? data : []
      setAccounts(list)
      if (list.length && !accountId) setAccountId(list[0].id)
    }
  }, [accountId])

  useEffect(() => { loadAccounts() }, [loadAccounts])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('threads_connected')) {
      toast.success('Threads account connected!')
      loadAccounts()
      window.history.replaceState({}, '', window.location.pathname)
    } else if (params.get('threads_error')) {
      toast.error(`Threads error: ${params.get('threads_error')}`)
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [loadAccounts])

  const loadQueue = useCallback(async () => {
    if (!accountId) return
    setLoadingQueue(true)
    try {
      const res = await fetch(`/api/threads/queue?accountId=${accountId}`)
      const data = await res.json()
      setQueue(Array.isArray(data.items) ? data.items : [])
    } catch { toast.error('Failed to load queue') }
    finally { setLoadingQueue(false) }
  }, [accountId])

  useEffect(() => { loadQueue() }, [loadQueue])

  async function addAccount() {
    if (!newAccountName.trim()) return
    setAddingAccount(true)
    try {
      const res = await fetch('/api/threads/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newAccountName.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setNewAccountName('')
      setAccountId(data.id)
      loadAccounts()
      toast.success('Account added')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to add account')
    } finally { setAddingAccount(false) }
  }

  function connectWithThreads() {
    if (!accountId) return
    toast.error(
      'Threads OAuth requires Meta tester access. Add this account as Tester in developers.facebook.com → App Roles, or wait for app review.',
      { duration: 8000 }
    )
  }

  async function addPost() {
    if (!accountId || !newContent.trim()) return
    setAddingPost(true)
    try {
      const res = await fetch('/api/threads/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId,
          content: newContent.trim(),
          mediaUrl: newMediaType !== 'TEXT' ? (newMediaUrl.trim() || null) : null,
          mediaType: newMediaType,
          scheduledAt: newScheduledAt ? new Date(newScheduledAt).toISOString() : null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setNewContent('')
      setNewMediaUrl('')
      setNewScheduledAt('')
      setNewMediaType('TEXT')
      loadQueue()
      toast.success('Post added to queue')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to add post')
    } finally { setAddingPost(false) }
  }

  async function publishNow(itemId: string) {
    setPublishing(itemId)
    try {
      const res = await fetch('/api/threads/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queueItemId: itemId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success('Post published to Threads!')
      loadQueue()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Publish failed')
    } finally { setPublishing(null) }
  }

  async function deletePost(id: string) {
    await fetch('/api/threads/queue', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    loadQueue()
  }

  async function deleteAllPending() {
    if (!accountId || !confirm('Delete all pending posts?')) return
    await fetch('/api/threads/queue', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, statusFilter: ['pending'] }),
    })
    loadQueue()
    toast.success('Deleted all pending')
  }

  async function deleteAllFailed() {
    if (!accountId || !confirm('Delete all failed posts?')) return
    await fetch('/api/threads/queue', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, statusFilter: ['failed'] }),
    })
    loadQueue()
    toast.success('Deleted all failed')
  }

  async function refreshToken() {
    if (!accountId) return
    setRefreshingToken(true)
    try {
      const res = await fetch('/api/threads/refresh-token', {
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

  function toggleSelect(id: string) {
    setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  async function bulkAction(action: 'disconnect' | 'delete') {
    if (!selectedIds.size) return
    const label = action === 'disconnect' ? 'Disconnect' : 'Delete'
    if (!confirm(`${label} ${selectedIds.size} account(s)?`)) return
    const ids = Array.from(selectedIds)

    if (action === 'disconnect') {
      await fetch('/api/threads/accounts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, clearToken: true }),
      })
    } else {
      for (const id of ids) {
        await fetch('/api/threads/accounts', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        })
      }
      if (ids.includes(accountId)) setAccountId('')
    }
    setSelectedIds(new Set())
    loadAccounts()
    toast.success(`${label}: ${ids.length} accounts`)
  }

  async function importCSV(file: File) {
    setImporting(true)
    try {
      const text = await file.text()
      const lines = text.trim().split('\n')
      const headers = lines[0].split(',').map(h => h.trim().toLowerCase())
      const nameIdx = headers.indexOf('name')
      const usernameIdx = headers.indexOf('threads_username')
      let imported = 0
      for (const line of lines.slice(1)) {
        if (!line.trim()) continue
        const cols = line.split(',').map(c => c.trim())
        const name = nameIdx >= 0 ? cols[nameIdx] : cols[0]
        const username = usernameIdx >= 0 ? cols[usernameIdx] : cols[1]
        if (!name) continue
        const res = await fetch('/api/threads/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, threadsUsername: username || null }),
        })
        if (res.ok) imported++
      }
      toast.success(`Imported ${imported} accounts`)
      loadAccounts()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Import failed')
    } finally { setImporting(false) }
  }

  const selectedAccount = accounts.find(a => a.id === accountId)
  const pending = queue.filter(q => q.status === 'pending')
  const done = queue.filter(q => q.status === 'done')
  const failed = queue.filter(q => q.status === 'failed')
  const tokenExpiresAt = selectedAccount?.token_expires_at ? new Date(selectedAccount.token_expires_at) : null
  const daysUntilExpiry = tokenExpiresAt ? Math.ceil((tokenExpiresAt.getTime() - Date.now()) / 86400000) : null
  const tokenExpiringSoon = daysUntilExpiry !== null && daysUntilExpiry <= 7

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel */}
      <div className="w-80 shrink-0 border-r border-border bg-sidebar/30 flex flex-col overflow-y-auto">
        <div className="px-5 py-5 space-y-4">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-foreground" />
            <p className="font-semibold text-sm">Threads</p>
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
            >Bulk Manage</button>
          </div>

          {tab === 'queue' && (
            <>
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Account</p>
                <Select value={accountId} onValueChange={v => setAccountId(v ?? '')}>
                  <SelectTrigger><SelectValue placeholder="Select account..." /></SelectTrigger>
                  <SelectContent>
                    {accounts.map(a => (
                      <SelectItem key={a.id} value={a.id}>
                        {prettyAccountName(a.threads_username ?? a.name)}
                        {a.connected ? ' ✓' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">New account</p>
                <div className="flex gap-1.5">
                  <Input value={newAccountName} onChange={e => setNewAccountName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && addAccount()}
                    placeholder="Account name..." className="text-xs h-8 flex-1" />
                  <Button size="sm" variant="outline" className="h-8 px-2 shrink-0"
                    onClick={addAccount} disabled={!newAccountName.trim() || addingAccount}>
                    {addingAccount ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                  </Button>
                </div>
              </div>

              {selectedAccount && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">Threads Auth</p>
                  {tokenExpiringSoon && daysUntilExpiry !== null && (
                    <div className="flex items-center gap-1.5 text-xs text-yellow-400 bg-yellow-500/10 rounded-lg px-3 py-2">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                      Token expires in {daysUntilExpiry}d
                    </div>
                  )}
                  <Button variant="outline" className="w-full border-foreground/30 text-foreground hover:bg-foreground/10"
                    onClick={connectWithThreads}>
                    <Link2 className="w-4 h-4 mr-2" />
                    {selectedAccount.connected ? 'Reconnect Threads' : 'Connect Threads'}
                  </Button>
                  {selectedAccount.connected && (
                    <Button size="sm" variant="ghost" className="w-full h-7 text-xs text-muted-foreground"
                      onClick={refreshToken} disabled={refreshingToken}>
                      {refreshingToken
                        ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Refreshing...</>
                        : <><RefreshCw className="w-3 h-3 mr-1.5" />Refresh token</>}
                    </Button>
                  )}
                </div>
              )}

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
                  {pending.length > 0 && (
                    <Button size="sm" variant="outline"
                      className="w-full h-7 text-xs border-destructive/40 text-destructive hover:bg-destructive/10"
                      onClick={deleteAllPending}>
                      <Trash2 className="w-3 h-3 mr-1.5" />Delete all pending ({pending.length})
                    </Button>
                  )}
                  {failed.length > 0 && (
                    <Button size="sm" variant="outline"
                      className="w-full h-7 text-xs border-destructive/40 text-destructive hover:bg-destructive/10"
                      onClick={deleteAllFailed}>
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
                Import multiple Threads accounts via CSV.
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

              {selectedIds.size > 0 && (
                <div className="border-t border-border/50 pt-3 space-y-1.5">
                  <p className="text-xs text-muted-foreground font-medium">Actions for selected ({selectedIds.size})</p>
                  <Button variant="outline" size="sm"
                    className="w-full h-7 text-xs border-yellow-500/40 text-yellow-400 hover:bg-yellow-500/10"
                    onClick={() => bulkAction('disconnect')}>
                    <X className="w-3 h-3 mr-1.5" />Disconnect
                  </Button>
                  <Button variant="destructive" size="sm" className="w-full h-7 text-xs"
                    onClick={() => bulkAction('delete')}>
                    <Trash2 className="w-3 h-3 mr-1.5" />Delete accounts ({selectedIds.size})
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Right panel */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {tab === 'queue' && accountId && (
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <p className="text-sm font-semibold">New Post</p>
            <Textarea value={newContent} onChange={e => setNewContent(e.target.value)}
              placeholder="What's on your mind? (max 500 chars)"
              className="resize-none" rows={3} maxLength={500} />
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Media type</p>
                <Select value={newMediaType} onValueChange={v => setNewMediaType(v as 'TEXT' | 'IMAGE' | 'VIDEO')}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="TEXT">Text only</SelectItem>
                    <SelectItem value="IMAGE">Image</SelectItem>
                    <SelectItem value="VIDEO">Video</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Schedule (optional)</p>
                <Input type="datetime-local" value={newScheduledAt}
                  onChange={e => setNewScheduledAt(e.target.value)} className="text-xs h-8" />
              </div>
            </div>
            {newMediaType !== 'TEXT' && (
              <Input value={newMediaUrl} onChange={e => setNewMediaUrl(e.target.value)}
                placeholder="Public media URL..." className="text-xs h-8 font-mono" />
            )}
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">{newContent.length}/500</span>
              <Button className="bg-foreground text-background hover:bg-foreground/90"
                onClick={addPost} disabled={!newContent.trim() || addingPost}>
                {addingPost ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Adding...</> : <><Plus className="w-4 h-4 mr-2" />Add to queue</>}
              </Button>
            </div>
          </div>
        )}

        {tab === 'bulk' && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-sm font-semibold">Threads Accounts</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {accounts.filter(a => a.connected).length} connected · {accounts.filter(a => !a.connected).length} not connected
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="h-7 text-xs"
                  onClick={() => setSelectedIds(selectedIds.size === accounts.length ? new Set() : new Set(accounts.map(a => a.id)))}>
                  {selectedIds.size === accounts.length ? 'Deselect all' : 'Select all'}
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              {accounts.map(acc => (
                <div key={acc.id}
                  className={`flex items-center gap-3 p-3 rounded-xl border transition-colors ${selectedIds.has(acc.id) ? 'border-primary/50 bg-primary/5' : 'border-border bg-card'}`}>
                  <input type="checkbox" checked={selectedIds.has(acc.id)}
                    onChange={() => toggleSelect(acc.id)}
                    className="w-4 h-4 shrink-0 accent-primary" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium">{prettyAccountName(acc.threads_username ?? acc.name)}</p>
                      {acc.threads_username && <span className="text-xs text-muted-foreground">@{acc.threads_username}</span>}
                      {acc.connected && <span className="text-[10px] bg-green-500/15 text-green-400 rounded px-1">connected</span>}
                    </div>
                  </div>
                  <Badge variant="secondary" className={`text-xs shrink-0 ${acc.connected ? 'text-green-400' : 'text-muted-foreground'}`}>
                    {acc.connected ? 'Connected' : 'Not connected'}
                  </Badge>
                </div>
              ))}
              {accounts.length === 0 && (
                <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                  <Users className="w-12 h-12 opacity-10 mb-3" />
                  <p className="text-sm">No accounts yet</p>
                  <p className="text-xs opacity-60 mt-1">Import a CSV or add manually</p>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'queue' && (
          loadingQueue ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : queue.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
              <MessageSquare className="w-16 h-16 opacity-10 mb-4" />
              <p className="text-sm">No posts in queue</p>
              <p className="text-xs opacity-60 mt-1">
                {accountId ? 'Add a post above to get started' : 'Select or create an account first'}
              </p>
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-semibold">Queue</p>
                <p className="text-xs text-muted-foreground">{queue.length} items</p>
              </div>
              <div className="space-y-3">
                {queue.map(item => (
                  <div key={item.id} className="rounded-xl border border-border bg-card p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm whitespace-pre-wrap line-clamp-3">{item.content}</p>
                        <div className="flex items-center gap-2 mt-2 flex-wrap">
                          <StatusBadge status={item.status} />
                          {item.media_type !== 'TEXT' && <Badge variant="outline" className="text-xs">{item.media_type}</Badge>}
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
                        {item.threads_media_id && (
                          <a href={`https://www.threads.net/t/${item.threads_media_id}`} target="_blank" rel="noopener noreferrer"
                            className="w-7 h-7 rounded-full border border-border flex items-center justify-center hover:border-primary transition-colors">
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                        {(item.status === 'pending' || item.status === 'failed') && (
                          <>
                            <Button size="sm" className="h-7 text-xs bg-foreground text-background hover:bg-foreground/90"
                              onClick={() => publishNow(item.id)} disabled={publishing === item.id}>
                              {publishing === item.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <><Play className="w-3 h-3 mr-1" />Post now</>}
                            </Button>
                            <button onClick={() => deletePost(item.id)}
                              className="w-7 h-7 rounded-full border border-border flex items-center justify-center hover:border-destructive hover:text-destructive transition-colors">
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    {item.media_url && (
                      <a href={item.media_url} target="_blank" rel="noopener noreferrer"
                        className="text-xs text-muted-foreground hover:text-foreground font-mono truncate flex items-center gap-1">
                        <ExternalLink className="w-3 h-3 shrink-0" />{item.media_url}
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )
        )}
      </div>
    </div>
  )
}
