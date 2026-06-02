'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useSearchParams } from 'next/navigation'
import { charactersStore, generationsStore } from '@/lib/store'
import { Character, GenerationRow, ScheduledPost } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'
import {
  Clock,
  Send,
  Loader2,
  ImageIcon,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Trash2,
  ExternalLink,
  CalendarDays,
  X,
} from 'lucide-react'

const STATUS_CONFIG: Record<ScheduledPost['status'], { label: string; icon: React.ReactNode; variant: 'secondary' | 'default' | 'destructive' | 'outline' }> = {
  pending_approval: { label: 'Pending approval', icon: <AlertCircle className="w-3 h-3" />, variant: 'outline' },
  approved:        { label: 'Approved',          icon: <CheckCircle2 className="w-3 h-3 text-green-400" />, variant: 'secondary' },
  published:       { label: 'Published',         icon: <CheckCircle2 className="w-3 h-3 text-primary" />, variant: 'default' },
  rejected:        { label: 'Rejected',          icon: <XCircle className="w-3 h-3" />, variant: 'destructive' },
  failed:          { label: 'Failed',            icon: <XCircle className="w-3 h-3" />, variant: 'destructive' },
}

function toLocalDatetimeInput(iso?: string) {
  const d = iso ? new Date(iso) : new Date(Date.now() + 60 * 60 * 1000)
  d.setSeconds(0, 0)
  return d.toISOString().slice(0, 16)
}

export default function SchedulePage() {
  const { user } = useAuth()
  const searchParams = useSearchParams()
  const [characters, setCharacters] = useState<Character[]>([])
  const [history, setHistory] = useState<GenerationRow[]>([])
  const [posts, setPosts] = useState<ScheduledPost[]>([])
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [prefilled, setPrefilled] = useState(false)

  // Form state
  const [characterId, setCharacterId] = useState('')
  const [imageUrls, setImageUrls] = useState<string[]>([])
  const [manualUrl, setManualUrl] = useState('')
  const [caption, setCaption] = useState('')
  const [platforms, setPlatforms] = useState<('telegram' | 'fanvue')[]>(['telegram', 'fanvue'])
  const [scheduledAt, setScheduledAt] = useState(toLocalDatetimeInput())
  const [pickFromHistory, setPickFromHistory] = useState(false)

  function addUrl(url: string) {
    const trimmed = url.trim()
    if (!trimmed || imageUrls.includes(trimmed)) return
    setImageUrls(prev => [...prev, trimmed])
  }

  function removeUrl(url: string) {
    setImageUrls(prev => prev.filter(u => u !== url))
  }

  function toggleHistoryUrl(url: string) {
    setImageUrls(prev =>
      prev.includes(url) ? prev.filter(u => u !== url) : [...prev, url]
    )
  }

  useEffect(() => {
    const chars = charactersStore.getAll()
    setCharacters(chars)

    const paramCharId = searchParams.get('characterId')
    const paramCaption = searchParams.get('caption')
    const paramDate = searchParams.get('date')
    const paramImageUrl = searchParams.get('imageUrl')

    if (paramCharId && chars.find(c => c.id === paramCharId)) {
      setCharacterId(paramCharId)
      setPrefilled(true)
    } else if (chars.length) {
      setCharacterId(chars[0].id)
    }

    if (paramCaption) {
      setCaption(paramCaption)
      setPrefilled(true)
    }

    if (paramImageUrl) {
      setImageUrls([paramImageUrl])
      setPrefilled(true)
    }

    if (paramDate) {
      const d = new Date(`${paramDate}T12:00:00`)
      d.setSeconds(0, 0)
      setScheduledAt(d.toISOString().slice(0, 16))
      setPrefilled(true)
    }

    const rows = user?.role === 'admin'
      ? generationsStore.getAll().filter(r => r.status === 'done')
      : generationsStore.getByUser(user?.id ?? '').filter(r => r.status === 'done')
    setHistory(rows)
    loadPosts()
  }, [user, searchParams])

  async function loadPosts() {
    setRefreshing(true)
    try {
      const res = await fetch('/api/schedule/list')
      if (res.ok) setPosts(await res.json())
    } catch {}
    setRefreshing(false)
  }

  function togglePlatform(p: 'telegram' | 'fanvue') {
    setPlatforms(prev =>
      prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p],
    )
  }

  async function handleSubmit() {
    if (!imageUrls.length) { toast.error('Add at least one image'); return }
    if (!caption.trim()) { toast.error('Enter a caption'); return }
    if (!platforms.length) { toast.error('Select at least one platform'); return }
    if (!characterId) { toast.error('Select a character'); return }

    const char = characters.find(c => c.id === characterId)
    setLoading(true)
    try {
      const res = await fetch('/api/schedule/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          characterId,
          characterName: char?.name ?? characterId,
          imageUrls,
          caption: caption.trim(),
          platforms,
          scheduledAt: new Date(scheduledAt).toISOString(),
          createdBy: user?.id ?? 'unknown',
        }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success('Post scheduled — approval request sent to Telegram')
      setImageUrls([])
      setManualUrl('')
      setCaption('')
      setScheduledAt(toLocalDatetimeInput())
      await loadPosts()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to schedule post')
    } finally {
      setLoading(false)
    }
  }

  async function cancelPost(id: string) {
    await fetch(`/api/schedule/${id}`, { method: 'DELETE' })
    toast.success('Post cancelled')
    await loadPosts()
  }

  const charHistoryRows = history.filter(r => r.characterId === characterId)

  return (
    <div className="flex h-full">
      {/* Left panel — create */}
      <div className="w-80 shrink-0 border-r border-border bg-card flex flex-col">
        <div className="px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-primary" />
            <h1 className="font-semibold text-base">Schedule Post</h1>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {prefilled && (
            <div className="flex items-start gap-2 rounded-lg bg-primary/10 border border-primary/20 px-3 py-2.5 text-xs text-primary">
              <CalendarDays className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>Pre-filled from calendar — pick an image and confirm the time</span>
            </div>
          )}

          {/* Character */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Character</Label>
            <Select value={characterId} onValueChange={v => { if (v) { setCharacterId(v); setPrefilled(false) }; setImageUrl('') }}>
              <SelectTrigger className="bg-input border-border">
                <SelectValue placeholder="Select character" />
              </SelectTrigger>
              <SelectContent>
                {characters.map(c => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Separator className="bg-border/50" />

          {/* Images */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">
                Images {imageUrls.length > 0 && <span className="text-primary">({imageUrls.length})</span>}
              </Label>
              <button
                className="text-xs text-primary hover:underline"
                onClick={() => setPickFromHistory(p => !p)}
              >
                {pickFromHistory ? 'Enter URL' : 'Pick from history'}
              </button>
            </div>

            {/* Selected images strip */}
            {imageUrls.length > 0 && (
              <div className="flex gap-1.5 flex-wrap">
                {imageUrls.map((url, i) => (
                  <div key={i} className="relative group/img">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={url} alt="" className="w-14 h-14 rounded-lg object-cover border border-border" />
                    <button
                      onClick={() => removeUrl(url)}
                      className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-destructive text-white flex items-center justify-center opacity-0 group-hover/img:opacity-100 transition-opacity"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {pickFromHistory ? (
              <div className="grid grid-cols-2 gap-2 max-h-64 overflow-y-auto pr-0.5">
                {charHistoryRows.length === 0 && (
                  <p className="col-span-2 text-xs text-muted-foreground py-2">No generated images for this character.</p>
                )}
                {charHistoryRows.flatMap(row =>
                  row.outputUrls.map((url, i) => {
                    const selected = imageUrls.includes(url)
                    return (
                      <button
                        key={`${row.id}-${i}`}
                        onClick={() => toggleHistoryUrl(url)}
                        className={`rounded-lg overflow-hidden border-2 transition-colors text-left relative ${selected ? 'border-primary' : 'border-transparent hover:border-border'}`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={url} alt="" className="w-full aspect-square object-cover" />
                        {selected && (
                          <div className="absolute top-1 right-1 w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                            <CheckCircle2 className="w-3 h-3 text-white" />
                          </div>
                        )}
                        <div className="px-1.5 py-1 bg-secondary/50">
                          <p className="text-xs text-muted-foreground/60">{new Date(row.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</p>
                        </div>
                      </button>
                    )
                  })
                )}
              </div>
            ) : (
              <div className="flex gap-1.5">
                <Input
                  placeholder="https://..."
                  value={manualUrl}
                  onChange={e => setManualUrl(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { addUrl(manualUrl); setManualUrl('') } }}
                  className="bg-input border-border text-sm"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0 px-3"
                  onClick={() => { addUrl(manualUrl); setManualUrl('') }}
                >
                  Add
                </Button>
              </div>
            )}
          </div>

          <Separator className="bg-border/50" />

          {/* Caption */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Caption</Label>
            <Textarea
              placeholder="Caption for this post..."
              value={caption}
              onChange={e => setCaption(e.target.value)}
              rows={4}
              className="bg-input border-border resize-none text-sm"
            />
          </div>

          <Separator className="bg-border/50" />

          {/* Platforms */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Platforms</Label>
            <div className="flex gap-2">
              {(['telegram', 'fanvue'] as const).map(p => (
                <button
                  key={p}
                  onClick={() => togglePlatform(p)}
                  className={`flex-1 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                    platforms.includes(p)
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {p === 'telegram' ? '✈️ Telegram' : '🔷 Fanvue'}
                </button>
              ))}
            </div>
          </div>

          <Separator className="bg-border/50" />

          {/* Scheduled at */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">
              <Clock className="w-3 h-3 inline mr-1" />
              Scheduled time
            </Label>
            <Input
              type="datetime-local"
              value={scheduledAt}
              onChange={e => setScheduledAt(e.target.value)}
              className="bg-input border-border text-sm"
            />
          </div>
        </div>

        <div className="px-5 py-4 border-t border-border">
          <Button className="w-full font-semibold" size="lg" onClick={handleSubmit} disabled={loading}>
            {loading ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Scheduling...</>
            ) : (
              <><Send className="w-4 h-4 mr-2" />Schedule &amp; Request Approval</>
            )}
          </Button>
        </div>
      </div>

      {/* Right panel — queue */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-semibold text-base text-foreground">Post Queue</h2>
          <Button variant="ghost" size="sm" className="text-xs h-7" onClick={loadPosts} disabled={refreshing}>
            {refreshing ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Refresh'}
          </Button>
        </div>

        {posts.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <Clock className="w-10 h-10 text-muted-foreground/30 mb-3" />
            <p className="text-muted-foreground text-sm">No scheduled posts yet.</p>
            <p className="text-muted-foreground/60 text-xs mt-1">Create your first post on the left.</p>
          </div>
        )}

        <div className="grid grid-cols-3 gap-3 xl:grid-cols-4">
          {posts.map(post => {
            const cfg = STATUS_CONFIG[post.status]
            return (
              <div key={post.id} className="group relative rounded-xl border border-border/50 bg-card overflow-hidden flex flex-col">
                {/* Image(s) */}
                <div className="relative bg-secondary overflow-hidden">
                  {post.imageUrls?.length > 1 ? (
                    <div className={`grid gap-0.5 aspect-square`} style={{ gridTemplateColumns: `repeat(${Math.min(post.imageUrls.length, 2)}, 1fr)` }}>
                      {post.imageUrls.slice(0, 4).map((url, i) => (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img key={i} src={url} alt="" className="w-full h-full object-cover aspect-square" />
                      ))}
                    </div>
                  ) : post.imageUrls?.[0] ? (
                    <div className="aspect-square">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={post.imageUrls[0]} alt="" className="w-full h-full object-cover" />
                    </div>
                  ) : (
                    <div className="aspect-square flex items-center justify-center">
                      <ImageIcon className="w-8 h-8 text-muted-foreground/30" />
                    </div>
                  )}
                  {/* Count badge */}
                  {post.imageUrls?.length > 1 && (
                    <div className="absolute bottom-2 right-2 bg-black/60 text-white text-xs px-1.5 py-0.5 rounded-md font-medium">
                      {post.imageUrls.length} photos
                    </div>
                  )}
                  {/* Status overlay badge */}
                  <div className="absolute top-2 left-2">
                    <Badge variant={cfg.variant} className="text-xs h-5 px-1.5 gap-1 shadow-sm">
                      {cfg.icon}{cfg.label}
                    </Badge>
                  </div>
                  {/* Delete on hover */}
                  <button
                    className="absolute top-2 right-2 w-6 h-6 rounded-full bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center hover:bg-destructive"
                    onClick={() => cancelPost(post.id)}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>

                {/* Meta */}
                <div className="px-4 py-3 flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-foreground truncate">{post.characterName}</span>
                    <div className="flex gap-1 shrink-0">
                      {post.platforms.map(p => (
                        <Badge key={p} variant="secondary" className="text-xs h-4 px-1.5">
                          {p === 'telegram' ? '✈️' : '🔷'} {p}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">{post.caption}</p>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground/60">
                    <Clock className="w-3 h-3" />
                    {new Date(post.scheduledAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
                  </div>
                  {post.error && (
                    <p className="text-xs text-destructive font-medium">{post.error}</p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
