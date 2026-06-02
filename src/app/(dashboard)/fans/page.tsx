'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { usersStore, charactersStore } from '@/lib/store'
import { fanAssignmentStore } from '@/lib/fanvue-store'
import { FanAssignment, FanPriority } from '@/lib/fanvue-types'
import { Fan, AiSummary, Character } from '@/lib/types'
import { User } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  MessageSquare,
  Loader2,
  Send,
  Search,
  UserPlus,
  X,
  Sparkles,
  MapPin,
  Clock,
  Star,
  Plus,
  Brain,
  TrendingUp,
  Zap,
} from 'lucide-react'

interface Message {
  id: string
  fanId: string
  text: string
  isCreator: boolean
  chatterId?: string | null
  createdAt: string
}

// ─── Helpers ──────────────────────────────────────────────────

function Avatar({ name, url, color, size = 'md' }: { name: string; url?: string; color?: string; size?: 'sm' | 'md' | 'lg' }) {
  const s = { sm: 'w-7 h-7 text-xs', md: 'w-9 h-9 text-sm', lg: 'w-12 h-12 text-base' }[size]
  if (url) return <img src={url} alt={name} className={`${s} rounded-full object-cover shrink-0`} />
  return (
    <div className={`${s} rounded-full flex items-center justify-center font-bold shrink-0`} style={{ background: color ?? '#6366f1', color: '#fff' }}>
      {name[0]}
    </div>
  )
}

function PriorityBadge({ p }: { p: FanPriority }) {
  const map: Record<FanPriority, [string, string]> = {
    low: ['Low', 'bg-secondary text-muted-foreground'],
    medium: ['Mid', 'bg-blue-500/20 text-blue-400'],
    high: ['High', 'bg-orange-500/20 text-orange-400'],
    whale: ['🐳 Whale', 'bg-purple-500/20 text-purple-400'],
  }
  const [label, cls] = map[p]
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cls}`}>{label}</span>
}

const CREATOR_COLORS: Record<string, string> = {}
const PALETTE = ['#a78bfa', '#f472b6', '#34d399', '#60a5fa', '#fb923c', '#e879f9']

function creatorColor(id: string): string {
  if (!CREATOR_COLORS[id]) {
    const idx = Object.keys(CREATOR_COLORS).length % PALETTE.length
    CREATOR_COLORS[id] = PALETTE[idx]
  }
  return CREATOR_COLORS[id]
}

// ─── Add Fan Form (module-level to prevent focus loss) ────────

function AddFanForm({
  form,
  onChange,
}: {
  form: {
    name: string; handle: string; location: string;
    occupation: string; age: string; totalSpendCents: string; notes: string
  }
  onChange: (f: typeof form) => void
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1 col-span-2">
          <p className="text-xs font-medium text-muted-foreground">Name *</p>
          <Input value={form.name} onChange={e => onChange({ ...form, name: e.target.value })} placeholder="James K." />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Handle</p>
          <Input value={form.handle} onChange={e => onChange({ ...form, handle: e.target.value })} placeholder="jamesk92" />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Total spend ($)</p>
          <Input type="number" min="0" value={form.totalSpendCents} onChange={e => onChange({ ...form, totalSpendCents: e.target.value })} placeholder="0" />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Location</p>
          <Input value={form.location} onChange={e => onChange({ ...form, location: e.target.value })} placeholder="New York, USA" />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Age</p>
          <Input type="number" min="18" max="99" value={form.age} onChange={e => onChange({ ...form, age: e.target.value })} placeholder="30" />
        </div>
        <div className="space-y-1 col-span-2">
          <p className="text-xs font-medium text-muted-foreground">Occupation</p>
          <Input value={form.occupation} onChange={e => onChange({ ...form, occupation: e.target.value })} placeholder="Software Engineer" />
        </div>
        <div className="space-y-1 col-span-2">
          <p className="text-xs font-medium text-muted-foreground">Notes</p>
          <Input value={form.notes} onChange={e => onChange({ ...form, notes: e.target.value })} placeholder="Quick notes about the fan..." />
        </div>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────

const EMPTY_ADD_FORM = { name: '', handle: '', location: '', occupation: '', age: '', totalSpendCents: '', notes: '' }

export default function FansPage() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const [characters, setCharacters] = useState<Character[]>([])
  const [chatters, setChatters] = useState<User[]>([])
  const [assignments, setAssignments] = useState<FanAssignment[]>([])

  const [selectedCreatorId, setSelectedCreatorId] = useState('')
  const [fans, setFans] = useState<Fan[]>([])
  const [loadingFans, setLoadingFans] = useState(false)
  const [selectedFan, setSelectedFan] = useState<Fan | null>(null)

  const [messages, setMessages] = useState<Message[]>([])
  const [loadingMessages, setLoadingMessages] = useState(false)

  const [search, setSearch] = useState('')
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [generatingSummary, setGeneratingSummary] = useState(false)

  const [assignModal, setAssignModal] = useState<Fan | null>(null)
  const [assignChatter, setAssignChatter] = useState('')
  const [assignPriority, setAssignPriority] = useState<FanPriority>('medium')

  const [addModal, setAddModal] = useState(false)
  const [addForm, setAddForm] = useState(EMPTY_ADD_FORM)
  const [addSaving, setAddSaving] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const chars = charactersStore.getAll()
    setCharacters(chars)
    if (chars.length) setSelectedCreatorId(chars[0].id)
    setChatters(usersStore.getAll().filter(u => u.active))
    setAssignments(fanAssignmentStore.getAll())
  }, [])

  const loadFans = useCallback(async (creatorId: string) => {
    setLoadingFans(true)
    try {
      const res = await fetch(`/api/fans?creatorId=${encodeURIComponent(creatorId)}`)
      const data = await res.json()
      setFans(Array.isArray(data) ? data : [])
    } catch {
      toast.error('Failed to load fans')
    } finally {
      setLoadingFans(false)
    }
  }, [])

  useEffect(() => {
    if (selectedCreatorId) loadFans(selectedCreatorId)
  }, [selectedCreatorId, loadFans])

  useEffect(() => {
    if (!selectedFan) return
    setLoadingMessages(true)
    setMessages([])
    fetch(`/api/fans/${selectedFan.id}/messages`)
      .then(r => r.json())
      .then(data => {
        setMessages(Array.isArray(data) ? data : [])
        setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
      })
      .catch(() => toast.error('Failed to load messages'))
      .finally(() => setLoadingMessages(false))
  }, [selectedFan])

  const selectedCreator = characters.find(c => c.id === selectedCreatorId)
  const color = selectedCreatorId ? creatorColor(selectedCreatorId) : '#6366f1'

  const visibleFans = fans.filter(f => {
    if (search && !f.displayName.toLowerCase().includes(search.toLowerCase()) &&
      !(f.fanvueHandle ?? '').toLowerCase().includes(search.toLowerCase())) return false
    if (!isAdmin) {
      return assignments.some(a => a.fanUuid === f.id && a.chatterId === user?.id)
    }
    return true
  })

  function getAssignment(fanId: string) {
    return assignments.find(a => a.fanUuid === fanId && a.creatorUuid === selectedCreatorId)
  }

  function handleAssign() {
    if (!assignModal || !assignChatter) return
    const chatter = chatters.find(c => c.id === assignChatter)
    if (!chatter) return

    const assignment: FanAssignment = {
      id: crypto.randomUUID(),
      fanUuid: assignModal.id,
      fanName: assignModal.displayName,
      fanAvatarUrl: '',
      creatorUuid: selectedCreatorId,
      creatorName: selectedCreator?.name ?? '',
      chatterId: chatter.id,
      chatterName: chatter.name,
      priority: assignPriority,
      status: 'active',
      totalSpend: (assignModal.lifetimeGrossCents ?? 0) / 100,
      notes: '',
      assignedAt: new Date().toISOString(),
      lastMessageAt: null,
    }
    fanAssignmentStore.assign(assignment)
    setAssignments(fanAssignmentStore.getAll())
    setAssignModal(null)
    toast.success(`${assignModal.displayName} → ${chatter.name}`)
  }

  function handleUnassign(fanId: string) {
    fanAssignmentStore.unassign(fanId, selectedCreatorId)
    setAssignments(fanAssignmentStore.getAll())
    toast.success('Fan unassignovan')
  }

  async function handleSend() {
    if (!reply.trim() || !selectedFan) return
    setSending(true)
    try {
      const res = await fetch(`/api/fans/${selectedFan.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: reply.trim(), isCreator: true, chatterId: user?.id }),
      })
      const msg = await res.json()
      setMessages(prev => [...prev, msg])
      setReply('')
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
    } catch {
      toast.error('Failed to send message')
    } finally {
      setSending(false)
    }
  }

  async function generateSummary() {
    if (!selectedFan) return
    setGeneratingSummary(true)
    try {
      const res = await fetch(`/api/fans/${selectedFan.id}/summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characterStory: selectedCreator?.story ?? '' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Unknown error')
      const updatedFan: Fan = { ...selectedFan, aiSummary: data.aiSummary, aiSummaryAt: new Date().toISOString() }
      setSelectedFan(updatedFan)
      setFans(prev => prev.map(f => f.id === updatedFan.id ? updatedFan : f))
      toast.success('AI summary generisan!')
    } catch (e: unknown) {
      toast.error('Error: ' + (e instanceof Error ? e.message : 'Unknown'))
    } finally {
      setGeneratingSummary(false)
    }
  }

  async function handleAddFan() {
    if (!addForm.name.trim()) return
    setAddSaving(true)
    try {
      const res = await fetch('/api/fans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          creatorId: selectedCreatorId,
          name: addForm.name.trim(),
          handle: addForm.handle.trim() || null,
          location: addForm.location.trim() || null,
          occupation: addForm.occupation.trim() || null,
          age: addForm.age ? parseInt(addForm.age) : null,
          totalSpendCents: addForm.totalSpendCents ? Math.round(parseFloat(addForm.totalSpendCents) * 100) : 0,
          notes: addForm.notes.trim() || '',
        }),
      })
      if (!res.ok) throw new Error('Failed')
      const newFan = await res.json()
      // API returns snake_case-mapped object; normalize to Fan shape
      const fan: Fan = {
        id: newFan.id,
        displayName: newFan.name,
        fanvueHandle: newFan.handle,
        payday: newFan.payday ?? { kind: 'none' },
        weeklySchedule: newFan.weeklySchedule ?? {},
        importantDates: newFan.importantDates ?? [],
        manualSpendEntries: newFan.manualSpendEntries ?? [],
        notes: newFan.notes ?? '',
        tags: newFan.tags ?? [],
        createdAt: newFan.createdAt,
      }
      setFans(prev => [...prev, fan])
      setAddModal(false)
      setAddForm(EMPTY_ADD_FORM)
      toast.success(`${fan.displayName} dodat!`)
    } catch {
      toast.error('Failed to add fan')
    } finally {
      setAddSaving(false)
    }
  }

  const summary: AiSummary | undefined = selectedFan?.aiSummary

  return (
    <div className="flex h-full overflow-hidden bg-background">

      {/* ── Creator switcher ── */}
      <div className="w-16 flex flex-col items-center py-5 gap-4 border-r border-border bg-sidebar shrink-0">
        <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground [writing-mode:vertical-lr] rotate-180 mb-2">Models</p>
        {characters.map(c => {
          const col = creatorColor(c.id)
          return (
            <button
              key={c.id}
              onClick={() => { setSelectedCreatorId(c.id); setSelectedFan(null) }}
              title={c.name}
              className="relative group"
            >
              <div className={`w-10 h-10 rounded-2xl flex items-center justify-center font-bold text-white text-sm transition-all ${
                selectedCreatorId === c.id ? 'scale-110 ring-2 ring-white/30' : 'opacity-50 hover:opacity-80'
              }`} style={{ background: col }}>
                {c.name[0]}
              </div>
              <span className="absolute left-14 top-1/2 -translate-y-1/2 bg-popover text-popover-foreground text-xs px-2 py-1 rounded shadow-lg opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50 border border-border">
                {c.name}
              </span>
            </button>
          )
        })}
      </div>

      {/* ── Fan list ── */}
      <div className="w-80 flex flex-col border-r border-border shrink-0">
        <div className="px-4 py-3 border-b border-border space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-bold text-sm">{selectedCreator?.name ?? '—'}</p>
              <p className="text-xs text-muted-foreground">{visibleFans.length} fans</p>
            </div>
            {isAdmin && (
              <Button size="sm" variant="outline" onClick={() => { setAddModal(true); setAddForm(EMPTY_ADD_FORM) }}>
                <Plus className="w-3.5 h-3.5 mr-1" />Add fan
              </Button>
            )}
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-muted-foreground" />
            <Input placeholder="Search fans..." value={search} onChange={e => setSearch(e.target.value)} className="pl-8 h-8 text-sm" />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-border/50">
          {loadingFans ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : visibleFans.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground text-sm space-y-2">
              <MessageSquare className="w-8 h-8 mx-auto opacity-20" />
              <p>{isAdmin ? 'No fans — click "Add fan"' : 'You have no assigned fans'}</p>
            </div>
          ) : visibleFans.map(fan => {
            const assignment = getAssignment(fan.id)
            const isActive = selectedFan?.id === fan.id
            const spend = fan.lifetimeGrossCents ?? 0
            return (
              <button
                key={fan.id}
                onClick={() => setSelectedFan(fan)}
                className={`w-full flex items-start gap-3 px-4 py-3.5 text-left hover:bg-secondary/30 transition-colors ${isActive ? 'bg-primary/10 border-l-2 border-primary' : ''}`}
              >
                <Avatar name={fan.displayName} size="md" color={color} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <p className="text-sm font-semibold truncate">{fan.displayName}</p>
                  </div>
                  {fan.fanvueHandle && (
                    <p className="text-xs text-muted-foreground truncate mb-1">@{fan.fanvueHandle}</p>
                  )}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {assignment ? (
                      <>
                        <span className="text-[10px] bg-secondary px-1.5 py-0.5 rounded text-muted-foreground">{assignment.chatterName}</span>
                        <PriorityBadge p={assignment.priority} />
                      </>
                    ) : isAdmin ? (
                      <span className="text-[10px] text-orange-400">Unassigned</span>
                    ) : null}
                    {spend > 0 && (
                      <span className="text-[10px] text-green-400 font-semibold ml-auto">${(spend / 100).toFixed(0)}</span>
                    )}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* ── Main area ── */}
      {selectedFan ? (
        <div className="flex flex-1 min-w-0">

          {/* Chat column */}
          <div className="flex flex-col flex-1 min-w-0 border-r border-border">
            <div className="flex items-center gap-3 px-5 py-3 border-b border-border shrink-0">
              <Avatar name={selectedFan.displayName} color={color} size="md" />
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm">{selectedFan.displayName}</p>
                {selectedFan.fanvueHandle && (
                  <p className="text-xs text-muted-foreground">@{selectedFan.fanvueHandle}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {(selectedFan.lifetimeGrossCents ?? 0) > 50000 && (
                  <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/30 text-xs">🐳 Whale</Badge>
                )}
                {(selectedFan.lifetimeGrossCents ?? 0) > 0 && (
                  <span className="text-sm font-semibold text-green-400">${((selectedFan.lifetimeGrossCents ?? 0) / 100).toFixed(0)}</span>
                )}
                {isAdmin && (
                  <Button size="sm" variant="outline" onClick={() => { setAssignModal(selectedFan); setAssignChatter(''); setAssignPriority('medium') }}>
                    <UserPlus className="w-3.5 h-3.5 mr-1.5" />Assign
                  </Button>
                )}
                {isAdmin && getAssignment(selectedFan.id) && (
                  <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => handleUnassign(selectedFan.id)}>
                    <X className="w-3.5 h-3.5 mr-1.5" />Unassign
                  </Button>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
              {loadingMessages ? (
                <div className="flex items-center justify-center h-full">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : messages.length === 0 ? (
                <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                  No messages yet
                </div>
              ) : messages.map(msg => (
                <div key={msg.id} className={`flex ${msg.isCreator ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-xs lg:max-w-sm px-4 py-2.5 rounded-2xl text-sm ${
                    msg.isCreator
                      ? 'bg-primary text-primary-foreground rounded-br-sm'
                      : 'bg-secondary text-foreground rounded-bl-sm'
                  }`}>
                    <p>{msg.text}</p>
                    <p className={`text-[10px] mt-1 ${msg.isCreator ? 'text-primary-foreground/50' : 'text-muted-foreground'}`}>
                      {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            <div className="px-4 py-3 border-t border-border shrink-0">
              <div className="flex gap-2">
                <Input
                  placeholder={`Write as ${selectedCreator?.name ?? 'Creator'}...`}
                  value={reply}
                  onChange={e => setReply(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
                  className="flex-1"
                />
                <Button onClick={handleSend} disabled={sending || !reply.trim()} size="icon">
                  {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                </Button>
              </div>
            </div>
          </div>

          {/* Sidebar */}
          <div className="w-80 flex flex-col overflow-y-auto shrink-0 bg-sidebar/50">

            {/* Profile */}
            <div className="px-5 py-5 border-b border-border space-y-4">
              <div className="flex items-center gap-3">
                <Avatar name={selectedFan.displayName} color={color} size="lg" />
                <div>
                  <p className="font-bold">{selectedFan.displayName}</p>
                  {selectedFan.fanvueHandle && (
                    <p className="text-xs text-muted-foreground">@{selectedFan.fanvueHandle}</p>
                  )}
                </div>
              </div>

              {(selectedFan.location || selectedFan.age || selectedFan.occupation) && (
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {selectedFan.location && (
                    <div className="flex items-center gap-1.5 text-muted-foreground col-span-2">
                      <MapPin className="w-3 h-3" />{selectedFan.location}
                    </div>
                  )}
                  {selectedFan.age && (
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Clock className="w-3 h-3" />{selectedFan.age} yrs
                    </div>
                  )}
                  {selectedFan.occupation && (
                    <div className="flex items-center gap-1.5 text-muted-foreground col-span-2">
                      <Star className="w-3 h-3" />{selectedFan.occupation}
                    </div>
                  )}
                </div>
              )}

              {(selectedFan.lifetimeGrossCents ?? 0) > 0 && (
                <div className="flex items-center justify-between p-3 rounded-xl bg-green-500/10 border border-green-500/20">
                  <span className="text-xs text-muted-foreground">Total spent</span>
                  <span className="font-bold text-green-400 text-lg">${((selectedFan.lifetimeGrossCents ?? 0) / 100).toFixed(0)}</span>
                </div>
              )}

              {selectedFan.notes && (
                <p className="text-xs text-muted-foreground leading-relaxed">{selectedFan.notes}</p>
              )}

              {(() => {
                const a = getAssignment(selectedFan.id)
                return a ? (
                  <div className="p-3 rounded-xl bg-secondary/50 border border-border space-y-1">
                    <p className="text-xs text-muted-foreground">Assigned to chatter</p>
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold">{a.chatterName}</p>
                      <PriorityBadge p={a.priority} />
                    </div>
                  </div>
                ) : isAdmin ? (
                  <button onClick={() => { setAssignModal(selectedFan); setAssignChatter(''); setAssignPriority('medium') }}
                    className="w-full p-3 rounded-xl border border-dashed border-border text-xs text-muted-foreground hover:border-primary hover:text-primary transition-colors flex items-center justify-center gap-2">
                    <UserPlus className="w-3.5 h-3.5" /> Assign to chatter
                  </button>
                ) : null
              })()}
            </div>

            {/* AI Summary */}
            <div className="px-5 py-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
                  <Brain className="w-3.5 h-3.5" />AI Summary
                </p>
                <button
                  onClick={generateSummary}
                  disabled={generatingSummary}
                  className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors"
                >
                  {generatingSummary
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <Sparkles className="w-3 h-3" />
                  }
                  {generatingSummary ? 'Generating...' : summary ? 'Refresh' : 'Generate'}
                </button>
              </div>

              {summary ? (
                <div className="space-y-3">
                  {summary.mood && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Mood</span>
                      <Badge variant="outline" className="text-xs">{summary.mood}</Badge>
                    </div>
                  )}
                  {summary.conversationTone && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Tone</span>
                      <span className="text-xs text-foreground/80">{summary.conversationTone}</span>
                    </div>
                  )}
                  {summary.preferences?.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Preferences</p>
                      <div className="flex flex-wrap gap-1">
                        {summary.preferences.map((p, i) => (
                          <span key={i} className="text-[10px] bg-secondary px-2 py-0.5 rounded-full">{p}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {summary.keyFacts?.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Key facts</p>
                      <ul className="space-y-0.5">
                        {summary.keyFacts.map((f, i) => (
                          <li key={i} className="text-xs text-foreground/80 flex gap-1.5"><span className="text-muted-foreground">·</span>{f}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {summary.dailyHooks?.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-xs text-muted-foreground flex items-center gap-1"><Zap className="w-3 h-3" />Daily openers</p>
                      <div className="space-y-1.5">
                        {summary.dailyHooks.map((h, i) => (
                          <div key={i} className="p-2.5 rounded-lg bg-primary/5 border border-primary/15 text-xs text-foreground/80">{h}</div>
                        ))}
                      </div>
                    </div>
                  )}
                  {summary.weeklyStrategy && (
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground flex items-center gap-1"><TrendingUp className="w-3 h-3" />Weekly strategy</p>
                      <p className="text-xs text-foreground/80 leading-relaxed">{summary.weeklyStrategy}</p>
                    </div>
                  )}
                  {summary.lastOfferResponse && (
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Last offer response</p>
                      <p className="text-xs text-foreground/80">{summary.lastOfferResponse}</p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-4 rounded-xl border border-dashed border-border text-center text-xs text-muted-foreground space-y-2">
                  <Brain className="w-6 h-6 mx-auto opacity-20" />
                  <p>No summary yet. Click Generate to analyze this fan's chat history.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="text-center space-y-3">
            <MessageSquare className="w-12 h-12 mx-auto opacity-10" />
            <p className="text-sm">Select a fan to chat</p>
          </div>
        </div>
      )}

      {/* ── Assign Modal ── */}
      <Dialog open={!!assignModal} onOpenChange={() => setAssignModal(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign fan to chatter</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            {assignModal && (
              <div className="flex items-center gap-3 p-3 rounded-xl bg-secondary/50">
                <Avatar name={assignModal.displayName} color={color} />
                <div>
                  <p className="font-semibold text-sm">{assignModal.displayName}</p>
                </div>
              </div>
            )}
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Chatter</p>
              <Select value={assignChatter} onValueChange={v => setAssignChatter(v ?? '')}>
                <SelectTrigger><SelectValue placeholder="Select chatter..." /></SelectTrigger>
                <SelectContent>
                  {chatters.map(c => (
                    <SelectItem key={c.id} value={c.id}>{c.name} <span className="text-muted-foreground ml-1">({c.role})</span></SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Priority</p>
              <Select value={assignPriority} onValueChange={v => setAssignPriority((v ?? 'medium') as FanPriority)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low — Low spender</SelectItem>
                  <SelectItem value="medium">Mid — Medium spender</SelectItem>
                  <SelectItem value="high">High — Active spender</SelectItem>
                  <SelectItem value="whale">🐳 Whale — VIP fan</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2 pt-1">
              <Button className="flex-1" onClick={handleAssign} disabled={!assignChatter}>
                <UserPlus className="w-4 h-4 mr-2" />Assign
              </Button>
              <Button variant="outline" onClick={() => setAssignModal(null)}>Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Add Fan Modal ── */}
      <Dialog open={addModal} onOpenChange={setAddModal}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add new fan</DialogTitle>
          </DialogHeader>
          <div className="pt-2">
            <AddFanForm form={addForm} onChange={setAddForm} />
            <div className="flex gap-2 pt-4">
              <Button className="flex-1" onClick={handleAddFan} disabled={addSaving || !addForm.name.trim()}>
                {addSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
                Add fan
              </Button>
              <Button variant="outline" onClick={() => setAddModal(false)}>Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
