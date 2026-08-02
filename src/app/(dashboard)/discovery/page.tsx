'use client'

import { useState, useEffect, useCallback, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { IgDownloaderTab } from './ig-downloader-tab'
import {
  Telescope,
  Plus,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  Trash2,
  Play,
  Zap,
  Users,
  Eye,
  TrendingUp,
  Music,
} from 'lucide-react'

// ─── Types ──────────────────────────────────────────────────────────

interface Profile {
  id: string
  platform: 'Instagram' | 'TikTok'
  username: string
  min_score: number
  max_age_days: number
  status: 'ACTIVE' | 'PAUSED'
  autopilot: boolean
  character_id: string | null
  reels_found: number
  last_scanned_at: string | null
}

interface DiscoveryItem {
  id: string
  platform: string
  profile: string
  content_url: string
  content_id: string
  views: number
  likes: number
  comments: number
  followers: number
  score: number
  velocity: number
  hook: string | null
  audio_name: string | null
  category: string | null
  posted_at: string | null
  discovered_at: string
  admin_status: 'PENDING' | 'APPROVED' | 'REJECTED'
  notes: string | null
  pipeline_job_id: string | null
}

// ─── Helpers ────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

function scoreColor(score: number): string {
  if (score >= 30) return 'text-emerald-400'
  if (score >= 15) return 'text-amber-400'
  return 'text-muted-foreground'
}

// ─── Profile Card ──────────────────────────────────────────────────

function ProfileCard({
  profile,
  onScan,
  onDelete,
  scanning,
}: {
  profile: Profile
  onScan: (id: string) => void
  onDelete: (id: string) => void
  scanning: boolean
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-secondary/30 border border-border/50">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">@{profile.username}</span>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">{profile.platform}</Badge>
          {profile.autopilot && (
            <Badge className="text-[10px] px-1.5 py-0 bg-primary/15 text-primary border-primary/20">Autopilot</Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          Score ≥ {profile.min_score} · max {profile.max_age_days}d old
          {profile.last_scanned_at && ` · last scan: ${new Date(profile.last_scanned_at).toLocaleDateString()}`}
          {profile.reels_found > 0 && ` · ${profile.reels_found} found`}
        </p>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2.5 text-xs"
        onClick={() => onScan(profile.id)}
        disabled={scanning}
      >
        {scanning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
      </Button>
      <button
        onClick={() => onDelete(profile.id)}
        className="text-muted-foreground hover:text-destructive transition-colors"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

// ─── Discovery Item Card ────────────────────────────────────────────

function DiscoveryCard({
  item,
  selected,
  onToggle,
  onApprove,
  onReject,
}: {
  item: DiscoveryItem
  selected: boolean
  onToggle: () => void
  onApprove: (id: string) => void
  onReject: (id: string) => void
}) {
  const statusStyle = {
    PENDING:  'bg-amber-500/15 text-amber-400',
    APPROVED: 'bg-emerald-500/15 text-emerald-400',
    REJECTED: 'bg-secondary text-muted-foreground',
  }[item.admin_status]

  return (
    <div
      className={`rounded-xl border transition-colors cursor-pointer ${
        selected ? 'border-primary/40 bg-primary/5' : 'border-border/50 bg-secondary/20 hover:bg-secondary/40'
      }`}
      onClick={onToggle}
    >
      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggle}
              onClick={e => e.stopPropagation()}
              className="accent-primary"
            />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-sm font-medium">@{item.profile}</span>
                <Badge variant="outline" className="text-[10px] px-1.5 py-0">{item.platform}</Badge>
                {item.category && (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0 capitalize">{item.category}</Badge>
                )}
              </div>
              {item.hook && (
                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1 italic">"{item.hook}"</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className={`text-sm font-bold tabular-nums ${scoreColor(item.score)}`}>
              {item.score.toFixed(1)}
            </span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${statusStyle}`}>
              {item.admin_status}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1"><Eye className="w-3 h-3" />{fmt(item.views)}</span>
          <span className="flex items-center gap-1"><TrendingUp className="w-3 h-3" />{fmt(item.velocity)}/h</span>
          <span className="flex items-center gap-1"><Users className="w-3 h-3" />{fmt(item.followers)}</span>
          {item.audio_name && (
            <span className="flex items-center gap-1 truncate max-w-[140px]">
              <Music className="w-3 h-3 shrink-0" />{item.audio_name}
            </span>
          )}
        </div>

        {item.admin_status === 'PENDING' && (
          <div className="flex gap-2 pt-1" onClick={e => e.stopPropagation()}>
            <Button
              size="sm"
              className="h-7 px-3 text-xs flex-1 bg-emerald-600 hover:bg-emerald-700"
              onClick={() => onApprove(item.id)}
            >
              <CheckCircle2 className="w-3 h-3 mr-1" /> Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-3 text-xs flex-1"
              onClick={() => onReject(item.id)}
            >
              <XCircle className="w-3 h-3 mr-1" /> Reject
            </Button>
            <a
              href={item.content_url}
              target="_blank"
              rel="noopener noreferrer"
              className="h-7 px-2.5 flex items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground transition-colors"
              onClick={e => e.stopPropagation()}
            >
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Add Profile Dialog ────────────────────────────────────────────

function AddProfilePanel({ onAdd }: { onAdd: (p: Profile) => void }) {
  const [platform, setPlatform] = useState<'Instagram' | 'TikTok'>('Instagram')
  const [username, setUsername]  = useState('')
  const [minScore, setMinScore]  = useState('5')
  const [maxAge, setMaxAge]      = useState('7')
  const [autopilot, setAutopilot]= useState(true)
  const [characterId, setCharacterId] = useState('')
  const [characters, setCharacters] = useState<{ id: string; name: string; loraUrl?: string }[]>([])
  const [saving, setSaving]      = useState(false)

  useEffect(() => {
    fetch('/api/characters')
      .then(r => r.ok ? r.json() : [])
      .then(data => setCharacters(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [])

  async function submit() {
    if (!username.trim()) return
    if (autopilot && !characterId) {
      toast.error('Pick your character for autopilot replication')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/runpod/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform,
          username: username.trim().replace('@', ''),
          min_score: parseFloat(minScore) || 5,
          max_age_days: parseInt(maxAge) || 7,
          autopilot,
          character_id: characterId || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      onAdd(data.profile)
      setUsername('')
      toast.success(`@${username.trim().replace('@', '')} added`)
    } catch (e) {
      toast.error(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="glass-card rounded-2xl p-5 space-y-3">
      <h3 className="text-sm font-semibold">Add a profile to track</h3>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Platform</label>
          <select
            value={platform}
            onChange={e => setPlatform(e.target.value as 'Instagram' | 'TikTok')}
            className="w-full h-9 rounded-md border border-border bg-secondary/50 text-sm px-3"
          >
            <option>Instagram</option>
            <option>TikTok</option>
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Username</label>
          <Input
            value={username}
            onChange={e => setUsername(e.target.value)}
            placeholder="@username"
            className="bg-secondary/50"
            onKeyDown={e => e.key === 'Enter' && submit()}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Min virality score</label>
          <Input value={minScore} onChange={e => setMinScore(e.target.value)} className="bg-secondary/50" type="number" min="1" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Max starost (dana)</label>
          <Input value={maxAge} onChange={e => setMaxAge(e.target.value)} className="bg-secondary/50" type="number" min="1" />
        </div>
        <div className="space-y-1 col-span-2">
          <label className="text-xs text-muted-foreground">Your character (LoRA for replication)</label>
          <select
            value={characterId}
            onChange={e => setCharacterId(e.target.value)}
            className="w-full h-9 rounded-md border border-border bg-secondary/50 text-sm px-3"
          >
            <option value="">— select character —</option>
            {characters.map(c => (
              <option key={c.id} value={c.id}>{c.name}{c.loraUrl ? '' : ' (no LoRA)'}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={autopilot}
            onChange={e => setAutopilot(e.target.checked)}
            className="accent-primary"
          />
          <span>Autopilot (scan → classify → replicate)</span>
          <Badge className="text-[10px] px-1.5 py-0 bg-primary/15 text-primary border-primary/20"><Zap className="w-2.5 h-2.5 mr-0.5" />Pro</Badge>
        </label>
        <Button size="sm" className="h-8" onClick={submit} disabled={saving || !username.trim()}>
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Plus className="w-3.5 h-3.5 mr-1.5" />}
          Add
        </Button>
      </div>
    </div>
  )
}

// ─── Viral Feed Tab ─────────────────────────────────────────────────

type ViewTab = 'pending' | 'approved' | 'rejected'

/**
 * Approving here is what moves a reel into Copy-Paste, but the two pages are
 * otherwise unconnected — without this the items look like they vanished.
 */
const OPEN_COPY_PASTE = {
  label: 'Open',
  onClick: () => { window.location.href = '/copy-paste' },
}

function ViralFeedTab() {
  const [profiles, setProfiles]       = useState<Profile[]>([])
  const [items, setItems]             = useState<DiscoveryItem[]>([])
  const [viewTab, setViewTab]         = useState<ViewTab>('pending')
  const [selected, setSelected]       = useState<Set<string>>(new Set())
  const [scanning, setScanning]       = useState<string | null>(null)
  const [loadingItems, setLoadingItems] = useState(false)
  const [batchWorking, setBatchWorking] = useState(false)

  const fetchProfiles = useCallback(async () => {
    const res = await fetch('/api/runpod/profiles')
    const data = await res.json()
    setProfiles(data.profiles ?? [])
  }, [])

  const fetchItems = useCallback(async (status: string) => {
    setLoadingItems(true)
    try {
      const res = await fetch(`/api/runpod/discovery?status=${status.toUpperCase()}&limit=50`)
      const data = await res.json()
      setItems(data.items ?? [])
    } finally {
      setLoadingItems(false)
    }
  }, [])

  useEffect(() => { fetchProfiles() }, [fetchProfiles])
  useEffect(() => { fetchItems(viewTab); setSelected(new Set()) }, [viewTab, fetchItems])

  async function scanProfile(profileId: string) {
    setScanning(profileId)
    try {
      const res = await fetch('/api/monitor/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_id: profileId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      const listed = data.listed ?? data.scanned ?? 0
      const source = data.source ? ` via ${data.source}` : ''
      if (listed === 0) {
        toast.warning(
          `No reels found for this profile${source}. Apify may be over quota, or the account has no Reels tab items.`,
        )
      } else if (data.added === 0) {
        const parts = [
          data.skippedDuplicate ? `${data.skippedDuplicate} already saved` : null,
          data.skippedAge ? `${data.skippedAge} too old` : null,
          data.skippedScore ? `${data.skippedScore} below min score` : null,
        ].filter(Boolean)
        toast.message(
          `Scan complete${source}: 0 new of ${listed} listed` +
            (parts.length ? ` (${parts.join(', ')})` : ''),
        )
      } else {
        toast.success(
          `Scan complete${source}: ${data.added} new of ${listed} listed` +
            (data.processed ? `, ${data.processed} replicated` : ''),
        )
      }
      fetchProfiles()
      if (viewTab === 'pending') fetchItems('pending')
    } catch (e) {
      toast.error(String(e))
    } finally {
      setScanning(null)
    }
  }

  async function deleteProfile(id: string) {
    await fetch('/api/runpod/profiles', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    setProfiles(prev => prev.filter(p => p.id !== id))
    toast.success('Profile removed')
  }

  async function updateStatus(id: string, status: 'APPROVED' | 'REJECTED') {
    await fetch('/api/runpod/discovery', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, admin_status: status }),
    })
    setItems(prev => prev.filter(i => i.id !== id))
    if (status === 'APPROVED') {
      toast.success('Approved — waiting in Copy-Paste Studio', { action: OPEN_COPY_PASTE })
    } else {
      toast.success('Rejected')
    }
  }

  async function batchUpdate(status: 'APPROVED' | 'REJECTED') {
    if (!selected.size) return
    setBatchWorking(true)
    try {
      await fetch('/api/runpod/discovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selected], admin_status: status }),
      })
      setItems(prev => prev.filter(i => !selected.has(i.id)))
      const n = selected.size
      setSelected(new Set())
      if (status === 'APPROVED') {
        toast.success(`${n} approved — waiting in Copy-Paste Studio`, { action: OPEN_COPY_PASTE })
      } else {
        toast.success(`${n} rejected`)
      }
    } finally {
      setBatchWorking(false)
    }
  }

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const tabStyle = (t: ViewTab) => `px-4 py-2 text-sm font-medium rounded-xl transition-colors ${
    viewTab === t
      ? 'bg-primary/10 text-primary border border-primary/20'
      : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
  }`

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Track viral content on Instagram and TikTok profiles
        </p>
        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0"
          onClick={() => fetchItems(viewTab)}
        >
          <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Refresh
        </Button>
      </div>

      {/* Profiles */}
      <AddProfilePanel onAdd={p => setProfiles(prev => [p, ...prev])} />

      {profiles.length > 0 && (
        <div className="space-y-2">
          {profiles.map(p => (
            <ProfileCard
              key={p.id}
              profile={p}
              onScan={scanProfile}
              onDelete={deleteProfile}
              scanning={scanning === p.id}
            />
          ))}
        </div>
      )}

      {/* Discovery feed */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          <button className={tabStyle('pending')} onClick={() => setViewTab('pending')}>Pending</button>
          <button className={tabStyle('approved')} onClick={() => setViewTab('approved')}>Approved</button>
          <button className={tabStyle('rejected')} onClick={() => setViewTab('rejected')}>Rejected</button>

          {viewTab === 'approved' && items.length > 0 && (
            <a
              href="/copy-paste"
              className="text-xs text-primary hover:underline ml-1 flex items-center gap-1"
            >
              {items.length} waiting in Copy-Paste Studio →
            </a>
          )}

          {selected.size > 0 && (
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-xs text-muted-foreground">{selected.size} selected</span>
              <Button
                size="sm"
                className="h-7 px-3 text-xs bg-emerald-600 hover:bg-emerald-700"
                disabled={batchWorking}
                onClick={() => batchUpdate('APPROVED')}
              >
                Approve sve
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-3 text-xs"
                disabled={batchWorking}
                onClick={() => batchUpdate('REJECTED')}
              >
                Reject sve
              </Button>
            </div>
          )}
        </div>

        {loadingItems ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-12">
            <Telescope className="w-8 h-8 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              {viewTab === 'pending'
                ? 'No pending items. Add a profile and run a scan.'
                : `No ${viewTab === 'approved' ? 'approved' : 'rejected'} items.`
              }
            </p>
          </div>
        ) : (
          <div className="grid gap-3">
            {items.map(item => (
              <DiscoveryCard
                key={item.id}
                item={item}
                selected={selected.has(item.id)}
                onToggle={() => toggleSelect(item.id)}
                onApprove={id => updateStatus(id, 'APPROVED')}
                onReject={id => updateStatus(id, 'REJECTED')}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Main Page ──────────────────────────────────────────────────────

const TAB_LABELS = ['Viral Feed', 'IG Downloader'] as const
type PageTab = typeof TAB_LABELS[number]

function DiscoveryPageInner() {
  const params = useSearchParams()
  const initialTab: PageTab = params.get('tab') === 'downloader' ? 'IG Downloader' : 'Viral Feed'
  const [tab, setTab] = useState<PageTab>(initialTab)

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-6 pt-5">
        <Telescope className="w-5 h-5 text-primary" />
        <h1 className="text-lg font-bold">Discovery</h1>
      </div>

      <div className="flex border-b border-border shrink-0 px-6 pt-3 gap-1 bg-background">
        {TAB_LABELS.map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${tab === t ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {tab === 'Viral Feed' && <ViralFeedTab />}
        {tab === 'IG Downloader' && <IgDownloaderTab />}
      </div>
    </div>
  )
}

export default function DiscoveryPage() {
  return (
    <Suspense fallback={null}>
      <DiscoveryPageInner />
    </Suspense>
  )
}
