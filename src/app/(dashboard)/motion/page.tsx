'use client'

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from 'sonner'
import {
  Loader2, Plus, Trash2, ScanSearch, Eye, Wand2,
  Video, ExternalLink, RefreshCw, CheckCircle2, Archive,
  RotateCcw, Settings2, ChevronDown, User,
} from 'lucide-react'
import type { ViralReel, TrackedProfile, Character } from '@/lib/types'
import { charactersStore } from '@/lib/store'

// ─── Status config ────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  viral_detected: 'Pending review',
  approved:       'Approved',
  cover_analyzed: 'Analyzed',
  image_generated:'Image ready',
  video_created:  'Video ready',
  archived:       'Archived',
}

const STATUS_COLOR: Record<string, string> = {
  viral_detected:  'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  approved:        'bg-green-500/15 text-green-400 border-green-500/30',
  cover_analyzed:  'bg-blue-500/15 text-blue-400 border-blue-500/30',
  image_generated: 'bg-violet-500/15 text-violet-400 border-violet-500/30',
  video_created:   'bg-primary/15 text-primary border-primary/30',
  archived:        'bg-secondary text-muted-foreground border-border',
}

type FilterTab = 'pending' | 'approved' | 'archived' | 'all'

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: 'pending',  label: 'Pending review' },
  { key: 'approved', label: 'Approved' },
  { key: 'archived', label: 'Archived' },
  { key: 'all',      label: 'All' },
]

function matchesFilter(reel: ViralReel, tab: FilterTab): boolean {
  if (tab === 'all') return true
  if (tab === 'pending')  return reel.status === 'viral_detected'
  if (tab === 'approved') return ['approved', 'cover_analyzed', 'image_generated', 'video_created'].includes(reel.status)
  if (tab === 'archived') return reel.status === 'archived'
  return true
}

// ─── Main page ────────────────────────────────────────────────

export default function MotionPage() {
  const [profiles, setProfiles] = useState<TrackedProfile[]>([])
  const [reels, setReels] = useState<ViralReel[]>([])
  const [characters, setCharacters] = useState<Character[]>([])
  const [selectedCharId, setSelectedCharId] = useState('')
  const [newUsername, setNewUsername] = useState('')
  const [scanning, setScanning] = useState(false)
  const [loadingId, setLoadingId] = useState<number | null>(null)
  const [loadingAction, setLoadingAction] = useState<string | null>(null)
  const [filterTab, setFilterTab] = useState<FilterTab>('pending')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [bulkLoading, setBulkLoading] = useState(false)
  const [showScanSettings, setShowScanSettings] = useState(false)
  const [minViews, setMinViews] = useState(10_000)
  const [daysBack, setDaysBack] = useState(30)
  const [lastScanDebug, setLastScanDebug] = useState<string[] | null>(null)

  const fetchProfiles = useCallback(async () => {
    const res = await fetch('/api/motion/profiles').catch(() => null)
    if (res?.ok) { const d = await res.json(); setProfiles(d.profiles ?? []) }
  }, [])

  const fetchReels = useCallback(async () => {
    const res = await fetch('/api/motion/reels').catch(() => null)
    if (res?.ok) { const d = await res.json(); setReels(d.reels ?? []) }
  }, [])

  useEffect(() => {
    fetchProfiles()
    fetchReels()
    const chars = charactersStore.getAll()
    setCharacters(chars)
    if (chars.length > 0) setSelectedCharId(chars[0].id)
  }, [fetchProfiles, fetchReels])

  async function addProfile() {
    if (!newUsername.trim()) return
    const res = await fetch('/api/motion/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: newUsername }),
    })
    if (res.ok) { setNewUsername(''); fetchProfiles(); toast.success('Profile added') }
    else toast.error('Failed to add profile')
  }

  async function runScan() {
    setScanning(true)
    setLastScanDebug(null)
    try {
      const res = await fetch('/api/motion/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minViews, daysBack }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setLastScanDebug(data.debug ?? null)
      toast.success(
        `Scan complete — ${data.added} new reels`,
        { description: `Scanned: ${data.scanned} | Skipped (views): ${data.skippedViews} | Skipped (date): ${data.skippedDate}` }
      )
      fetchReels()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Scan error')
    } finally {
      setScanning(false)
    }
  }

  async function runAction(
    id: number,
    action: 'analyze' | 'generate-image' | 'generate-video',
    loraOverride?: { loraUrl: string | null; loraScale: number; triggerWord: string }
  ) {
    setLoadingId(id)
    setLoadingAction(action)
    try {
      const fallbackChar = characters.find(c => c.id === selectedCharId)
      const lora = loraOverride ?? (action !== 'analyze' ? {
        loraUrl: fallbackChar?.loraUrl ?? null,
        loraScale: fallbackChar?.loraScale ?? 0.8,
        triggerWord: fallbackChar?.name ?? '',
      } : undefined)

      const res = await fetch(`/api/motion/${action}/${id}`, {
        method: 'POST',
        headers: lora ? { 'Content-Type': 'application/json' } : undefined,
        body: lora ? JSON.stringify(lora) : undefined,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      const labels = { analyze: 'Cover analiziran', 'generate-image': 'Slika generisana', 'generate-video': 'Video kreiran' }
      toast.success(labels[action])
      fetchReels()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error')
    } finally {
      setLoadingId(null); setLoadingAction(null)
    }
  }

  async function singleAction(id: number, action: 'approve' | 'archive' | 'restore' | 'delete') {
    if (action === 'delete' && !confirm('Delete this reel?')) return
    try {
      const res = await fetch('/api/motion/reels/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id], action }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      const labels = { approve: 'Approved', archive: 'Archived', restore: 'Restored', delete: 'Deleted' }
      toast.success(labels[action])
      fetchReels()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error')
    }
  }

  async function bulkAction(action: 'approve' | 'archive' | 'restore' | 'delete') {
    if (!selectedIds.size) return
    const label = { approve: 'Approve', archive: 'Archive', restore: 'Restore', delete: 'Delete' }[action]
    if (action === 'delete' && !confirm(`Delete ${selectedIds.size} reel(s)?`)) return
    setBulkLoading(true)
    try {
      const res = await fetch('/api/motion/reels/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selectedIds), action }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success(`${label}: ${data.affected} reelova`)
      setSelectedIds(new Set())
      fetchReels()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error')
    } finally {
      setBulkLoading(false)
    }
  }

  const activeProfiles = profiles.filter(p => p.active)
  const filtered = reels.filter(r => matchesFilter(r, filterTab))
  const counts: Record<FilterTab, number> = {
    pending:  reels.filter(r => r.status === 'viral_detected').length,
    approved: reels.filter(r => ['approved', 'cover_analyzed', 'image_generated', 'video_created'].includes(r.status)).length,
    archived: reels.filter(r => r.status === 'archived').length,
    all:      reels.length,
  }

  function toggleSelect(id: number) {
    setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  function selectAll() {
    setSelectedIds(new Set(filtered.map(r => r.id)))
  }

  return (
    <div className="flex flex-col gap-6 p-6 max-w-6xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold">Motion</h1>
        <p className="text-muted-foreground text-sm mt-1">Track Instagram Reels, approve viral content and create posts.</p>
      </div>

      {/* Tracked profiles + scan */}
      <div className="border rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Tracked profiles</h2>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setShowScanSettings(v => !v)}>
              <Settings2 className="w-3.5 h-3.5 mr-1.5" />
              Settings
              <ChevronDown className={`w-3 h-3 ml-1 transition-transform ${showScanSettings ? 'rotate-180' : ''}`} />
            </Button>
            <Button size="sm" onClick={runScan} disabled={scanning || activeProfiles.length === 0}>
              {scanning ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <ScanSearch className="w-4 h-4 mr-2" />}
              Scan Now
            </Button>
          </div>
        </div>

        {/* Scan settings */}
        {showScanSettings && (
          <div className="flex gap-4 p-3 rounded-lg bg-secondary/50 border border-border">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Min. pregleda</p>
              <Input type="number" value={minViews} min={0} step={1000}
                onChange={e => setMinViews(Number(e.target.value))}
                className="h-8 text-xs w-32" />
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Vremenski prozor (dana)</p>
              <Input type="number" value={daysBack} min={1} max={365}
                onChange={e => setDaysBack(Number(e.target.value))}
                className="h-8 text-xs w-24" />
            </div>
          </div>
        )}

        {/* Last scan debug */}
        {lastScanDebug && (
          <div className="text-xs text-muted-foreground space-y-0.5 p-3 rounded-lg bg-secondary/30 border border-border">
            {lastScanDebug.map((line, i) => <p key={i}>{line}</p>)}
          </div>
        )}

        <div className="flex gap-2">
          <Input placeholder="@username" value={newUsername}
            onChange={e => setNewUsername(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addProfile()}
            className="max-w-xs" />
          <Button variant="outline" size="icon" onClick={addProfile}>
            <Plus className="w-4 h-4" />
          </Button>
        </div>

        {activeProfiles.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nema aktivnih profila. Dodaj Instagram username iznad.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {activeProfiles.map(p => (
              <div key={p.id} className="flex items-center gap-1.5 bg-secondary rounded-lg px-3 py-1.5 text-sm">
                <span>@{p.username}</span>
                <button onClick={() => fetch('/api/motion/profiles', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: p.username }) }).then(() => fetchProfiles())}
                  className="text-muted-foreground hover:text-destructive transition-colors">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Character selector for image generation */}
      {characters.length > 0 && (
        <div className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card">
          <User className="w-4 h-4 text-muted-foreground shrink-0" />
          <p className="text-sm text-muted-foreground shrink-0">Karakter za generisanje:</p>
          <Select value={selectedCharId} onValueChange={v => setSelectedCharId(v ?? '')}>
            <SelectTrigger className="h-8 text-sm max-w-xs">
              <SelectValue placeholder="Odaberi karakter..." />
            </SelectTrigger>
            <SelectContent>
              {characters.map(c => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {characters.find(c => c.id === selectedCharId)?.loraUrl && (
            <span className="text-xs text-primary">LoRA ✓</span>
          )}
        </div>
      )}

      {/* Filter tabs + bulk actions */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex rounded-lg border border-border overflow-hidden text-sm">
            {FILTER_TABS.map(t => (
              <button key={t.key} onClick={() => { setFilterTab(t.key); setSelectedIds(new Set()) }}
                className={`px-4 py-2 font-medium transition-colors flex items-center gap-1.5 ${filterTab === t.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'}`}>
                {t.label}
                {counts[t.key] > 0 && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${filterTab === t.key ? 'bg-primary-foreground/20' : 'bg-secondary'}`}>
                    {counts[t.key]}
                  </span>
                )}
              </button>
            ))}
          </div>
          <Button variant="ghost" size="icon" onClick={fetchReels}>
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>

        {/* Bulk action bar */}
        {filtered.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={selectedIds.size === filtered.length ? () => setSelectedIds(new Set()) : selectAll}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors">
              {selectedIds.size === filtered.length ? 'Deselect all' : `Select all (${filtered.length})`}
            </button>
            {selectedIds.size > 0 && (
              <>
                <span className="text-xs text-muted-foreground">·</span>
                <span className="text-xs font-medium">{selectedIds.size} odabrano</span>
                {filterTab === 'pending' && (
                  <Button size="sm" variant="outline" className="h-7 text-xs border-green-500/40 text-green-400 hover:bg-green-500/10"
                    onClick={() => bulkAction('approve')} disabled={bulkLoading}>
                    <CheckCircle2 className="w-3 h-3 mr-1" />Approve
                  </Button>
                )}
                {filterTab !== 'archived' && (
                  <Button size="sm" variant="outline" className="h-7 text-xs"
                    onClick={() => bulkAction('archive')} disabled={bulkLoading}>
                    <Archive className="w-3 h-3 mr-1" />Archive
                  </Button>
                )}
                {filterTab === 'archived' && (
                  <Button size="sm" variant="outline" className="h-7 text-xs"
                    onClick={() => bulkAction('restore')} disabled={bulkLoading}>
                    <RotateCcw className="w-3 h-3 mr-1" />Restore
                  </Button>
                )}
                <Button size="sm" variant="outline" className="h-7 text-xs border-destructive/40 text-destructive hover:bg-destructive/10"
                  onClick={() => bulkAction('delete')} disabled={bulkLoading}>
                  <Trash2 className="w-3 h-3 mr-1" />Delete
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Reels list */}
      <div className="border rounded-xl overflow-hidden">
        {filtered.length === 0 ? (
          <div className="px-5 py-10 text-center text-muted-foreground text-sm">
            {filterTab === 'pending' ? 'Nema reelova za pregled. Pokreni scan.' : `Nema reelova u kategoriji "${filterTab}".`}
          </div>
        ) : (
          <div className="divide-y">
            {filtered.map(reel => (
              <ReelRow
                key={reel.id}
                reel={reel}
                selected={selectedIds.has(reel.id)}
                onToggleSelect={() => toggleSelect(reel.id)}
                loading={loadingId === reel.id}
                loadingAction={loadingId === reel.id ? loadingAction : null}
                onAction={action => runAction(reel.id, action)}
                onApprove={() => bulkAction.call(null, 'approve') || fetch('/api/motion/reels/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [reel.id], action: 'approve' }) }).then(() => fetchReels())}
                onArchive={() => fetch('/api/motion/reels/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [reel.id], action: 'archive' }) }).then(() => { toast.success('Archived'); fetchReels() })}
                onDelete={() => { if (confirm('Delete?')) fetch('/api/motion/reels/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [reel.id], action: 'delete' }) }).then(() => { toast.success('Deleted'); fetchReels() }) }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Reel row ─────────────────────────────────────────────────

function ReelRow({
  reel, selected, onToggleSelect, loading, loadingAction, onAction, onApprove, onArchive, onDelete,
}: {
  reel: ViralReel; selected: boolean; onToggleSelect: () => void
  loading: boolean; loadingAction: string | null
  onAction: (a: 'analyze' | 'generate-image' | 'generate-video') => void
  onApprove: () => void; onArchive: () => void; onDelete: () => void
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="px-5 py-4 space-y-3">
      <div className="flex items-start gap-3">
        {/* Checkbox */}
        <input type="checkbox" checked={selected} onChange={onToggleSelect}
          className="mt-1.5 w-4 h-4 accent-primary shrink-0" />

        {/* Status accent bar */}
        <div className={`w-1 self-stretch rounded-full shrink-0 ${
          reel.status === 'viral_detected' ? 'bg-yellow-500/60' :
          reel.status === 'approved' ? 'bg-green-500/60' :
          reel.status === 'cover_analyzed' ? 'bg-blue-500/60' :
          reel.status === 'image_generated' ? 'bg-violet-500/60' :
          reel.status === 'video_created' ? 'bg-primary/60' :
          'bg-border'
        }`} />

        <div className="flex-1 min-w-0 space-y-2">
          {/* Meta row */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">@{reel.profile}</span>
            <span className={`text-[10px] px-2 py-0.5 rounded-full border ${STATUS_COLOR[reel.status] ?? 'bg-secondary text-muted-foreground border-border'}`}>
              {STATUS_LABEL[reel.status] ?? reel.status}
            </span>
            <span className="text-xs text-muted-foreground">{Number(reel.views).toLocaleString()} views</span>
            <span className="text-xs text-muted-foreground">{new Date(reel.posted_at).toLocaleDateString()}</span>
            <a href={reel.reel_url} target="_blank" rel="noopener noreferrer" className="ml-auto">
              <ExternalLink className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
            </a>
          </div>

          {/* Actions row */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {/* Approve/Archive — only for pending */}
            {reel.status === 'viral_detected' && (
              <>
                <Button size="sm" className="h-7 text-xs bg-green-600 hover:bg-green-700" onClick={onApprove}>
                  <CheckCircle2 className="w-3 h-3 mr-1" />Approve
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onArchive}>
                  <Archive className="w-3 h-3 mr-1" />Archive
                </Button>
              </>
            )}

            {/* Pipeline — only for approved */}
            {reel.status === 'approved' && (
              <Button size="sm" variant="outline" className="h-7 text-xs"
                disabled={loading} onClick={() => onAction('analyze')}>
                {loading && loadingAction === 'analyze' ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Eye className="w-3 h-3 mr-1" />}
                Analyze
              </Button>
            )}
            {reel.status === 'cover_analyzed' && (
              <Button size="sm" variant="outline" className="h-7 text-xs"
                disabled={loading} onClick={() => onAction('generate-image')}>
                {loading && loadingAction === 'generate-image' ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Wand2 className="w-3 h-3 mr-1" />}
                Generate Image
              </Button>
            )}
            {reel.status === 'image_generated' && (
              <Button size="sm" variant="outline" className="h-7 text-xs"
                disabled={loading} onClick={() => onAction('generate-video')}>
                {loading && loadingAction === 'generate-video' ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Video className="w-3 h-3 mr-1" />}
                Generate Video
              </Button>
            )}

            {/* Archive for approved+ */}
            {reel.status !== 'viral_detected' && reel.status !== 'archived' && (
              <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground ml-auto" onClick={onArchive}>
                <Archive className="w-3 h-3 mr-1" />Archive
              </Button>
            )}

            {/* Delete */}
            <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground hover:text-destructive" onClick={onDelete}>
              <Trash2 className="w-3 h-3" />
            </Button>

            {/* Expand details */}
            {(reel.gemini_prompt || reel.generated_image_url || reel.kling_video_url) && (
              <button className="text-xs text-muted-foreground hover:text-foreground ml-1" onClick={() => setExpanded(v => !v)}>
                {expanded ? '▲ Hide' : '▼ Details'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="ml-7 pl-4 border-l space-y-3">
          {reel.gemini_prompt && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Gemini Prompt</p>
              <p className="text-xs bg-secondary rounded-lg p-3 leading-relaxed">{reel.gemini_prompt}</p>
            </div>
          )}
          <div className="flex gap-4 flex-wrap">
            {reel.generated_image_url && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Generated image</p>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={reel.generated_image_url} alt="" className="h-40 w-auto rounded-lg object-cover" />
              </div>
            )}
            {reel.kling_video_url && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Kling Video</p>
                <video src={reel.kling_video_url} controls className="h-40 w-auto rounded-lg" />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
