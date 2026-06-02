'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { charactersStore, calendarStore } from '@/lib/store'
import { Character, CalendarDay } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
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
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'
import {
  CalendarDays,
  Loader2,
  Sparkles,
  CheckCircle2,
  Circle,
  RefreshCw,
  Copy,
  Clock,
  Wand2,
} from 'lucide-react'

const WEEK_LABELS = ['Week 1 (1–7)', 'Week 2 (8–14)', 'Week 3 (15–21)', 'Week 4 (22–28)']
const MODES = ['SFW', 'NSFW']

const PROMPT_KEYS = ['front_selfie', 'mirror_selfie', 'pov', 'closeup', 'self_timer'] as const
const PROMPT_LABELS = [
  'Front camera selfie',
  'Full body mirror selfie',
  'POV shot',
  'Close-up selfie',
  'Self-timer photo',
]

function buildDayId(characterId: string, date: string) {
  return `${characterId}__${date}`
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('en-US', {
    weekday: 'short', day: '2-digit', month: '2-digit',
  })
}

function getDaysForCharacter(character: Character): CalendarDay[] {
  const start = character.startDate ? new Date(character.startDate) : new Date()
  return Array.from({ length: 28 }, (_, i) => {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    const dateStr = d.toISOString().split('T')[0]
    return {
      id: buildDayId(character.id, dateStr),
      characterId: character.id,
      characterName: character.name,
      date: dateStr,
      notes: '',
      topic: '',
      keywords: '',
      description: '',
      fanvueDescription: '',
      prompts: {},
      status: 'empty' as const,
      createdAt: '',
    }
  })
}

interface DayCardProps {
  day: CalendarDay
  onOpen: (day: CalendarDay) => void
  onGenerate: (day: CalendarDay) => void
  generating: boolean
  onSchedule: (day: CalendarDay) => void
}

function DayCard({ day, onOpen, onGenerate, generating, onSchedule }: DayCardProps) {
  const hasContent = day.status === 'generated'
  return (
    <div
      className={`relative rounded-xl border p-3 transition-all cursor-pointer group ${
        hasContent
          ? 'border-primary/30 bg-primary/5 hover:border-primary/50'
          : 'border-border/50 bg-card hover:border-border'
      }`}
      onClick={() => onOpen(day)}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div>
          <p className="text-xs font-semibold text-foreground">{formatDate(day.date)}</p>
          {hasContent && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{day.topic}</p>
          )}
          {day.notes && !hasContent && (
            <p className="text-xs text-primary/60 mt-0.5 line-clamp-1 italic">{day.notes}</p>
          )}
        </div>
        {hasContent
          ? <CheckCircle2 className="w-4 h-4 text-primary shrink-0 mt-0.5" />
          : <Circle className="w-4 h-4 text-muted-foreground/40 shrink-0 mt-0.5" />
        }
      </div>

      {hasContent && (
        <p className="text-xs text-muted-foreground line-clamp-2 mb-2">{day.description}</p>
      )}

      <div className="flex gap-1.5 mt-auto">
        {hasContent && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs text-muted-foreground hover:text-primary"
            onClick={e => { e.stopPropagation(); onSchedule(day) }}
          >
            <Clock className="w-3 h-3 mr-1" />
            Schedule
          </Button>
        )}
        <Button
          size="sm"
          variant={hasContent ? 'outline' : 'default'}
          className="h-6 px-2 text-xs ml-auto"
          disabled={generating}
          onClick={e => { e.stopPropagation(); onGenerate(day) }}
        >
          {generating ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <>
              <RefreshCw className="w-3 h-3 mr-1" />
              {hasContent ? 'Regen' : 'Generate'}
            </>
          )}
        </Button>
      </div>
    </div>
  )
}

interface CharacterConfig {
  name: string
  mode: string
  basePromptStyle: string
  story: string
}

interface DayDialogProps {
  day: CalendarDay | null
  open: boolean
  onClose: () => void
  onSave: (day: CalendarDay) => void
  onGenerateContext: (day: CalendarDay) => Promise<void>
  generatingContext: boolean
  character: CharacterConfig | undefined
  contentMode: string
  onSchedule: (day: CalendarDay) => void
}

function DayDialog({ day, open, onClose, onSave, onGenerateContext, generatingContext, character, contentMode, onSchedule }: DayDialogProps) {
  const [editing, setEditing] = useState<CalendarDay | null>(null)
  const [generatingPrompts, setGeneratingPrompts] = useState(false)

  useEffect(() => {
    if (day) setEditing({ ...day, prompts: { ...(day.prompts ?? {}) } })
  }, [day])

  if (!editing) return null

  function updatePrompt(key: string, val: string) {
    setEditing(prev => {
      if (!prev) return prev
      return { ...prev, prompts: { ...prev.prompts, [key]: val } }
    })
  }

  async function generatePrompts() {
    if (!character || !editing) return
    setGeneratingPrompts(true)
    try {
      const results = await Promise.allSettled(
        PROMPT_KEYS.map(key =>
          fetch('/api/calendar/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mode: 'prompt',
              character,
              day: {
                date: editing.date,
                notes: editing.notes ?? '',
                topic: editing.topic,
                keywords: editing.keywords,
              },
              promptTypeId: key,
            }),
          }).then(r => r.json())
        )
      )
      const updated: Record<string, string> = { ...editing.prompts }
      results.forEach((result, i) => {
        if (result.status === 'fulfilled' && result.value.prompt) {
          updated[PROMPT_KEYS[i]] = result.value.prompt
        }
      })
      setEditing(prev => prev ? { ...prev, prompts: updated } : prev)
      toast.success('Image prompts generated!')
    } catch {
      toast.error('Failed to generate prompts')
    } finally {
      setGeneratingPrompts(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="w-[92vw] max-w-[1100px] bg-card border-border p-0 gap-0">
        {/* Header */}
        <DialogHeader className="px-6 py-4 border-b border-border">
          <DialogTitle className="flex items-center gap-2">
            <CalendarDays className="w-4 h-4 text-primary" />
            {formatDate(editing.date)} — {editing.topic || 'New day'}
          </DialogTitle>
        </DialogHeader>

        {/* Two-column body */}
        <div className="grid grid-cols-2 divide-x divide-border">

          {/* Left — content */}
          <div className="px-6 py-5 space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Creative brief</Label>
              <Textarea
                placeholder="e.g. beach day, spa morning, night out with friends…"
                value={editing.notes ?? ''}
                onChange={e => setEditing(p => p ? { ...p, notes: e.target.value } : p)}
                rows={2}
                className="bg-input border-border text-sm resize-none"
              />
              <p className="text-xs text-muted-foreground/50">AI uses this as source of truth when generating.</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Topic</Label>
                <Input
                  value={editing.topic}
                  onChange={e => setEditing(p => p ? { ...p, topic: e.target.value } : p)}
                  className="bg-input border-border text-sm h-8"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Keywords</Label>
                <Input
                  value={editing.keywords}
                  onChange={e => setEditing(p => p ? { ...p, keywords: e.target.value } : p)}
                  className="bg-input border-border text-sm h-8"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Description</Label>
              <Textarea
                value={editing.description}
                onChange={e => setEditing(p => p ? { ...p, description: e.target.value } : p)}
                rows={4}
                className="bg-input border-border text-sm resize-none"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Fanvue caption</Label>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 px-1.5 text-xs text-muted-foreground"
                  onClick={() => { navigator.clipboard.writeText(editing.fanvueDescription); toast.success('Copied!') }}
                >
                  <Copy className="w-3 h-3 mr-1" />Copy
                </Button>
              </div>
              <Textarea
                value={editing.fanvueDescription}
                onChange={e => setEditing(p => p ? { ...p, fanvueDescription: e.target.value } : p)}
                rows={2}
                className="bg-input border-border text-sm resize-none"
              />
            </div>
          </div>

          {/* Right — image prompts */}
          <div className="px-6 py-5 space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground uppercase tracking-wider">Image Prompts</Label>
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-xs gap-1.5"
                disabled={!editing.topic || generatingPrompts || !character}
                onClick={generatePrompts}
              >
                {generatingPrompts
                  ? <><Loader2 className="w-3 h-3 animate-spin" />Generating…</>
                  : <><Wand2 className="w-3 h-3" />Generate all</>
                }
              </Button>
            </div>

            {PROMPT_KEYS.map((key, i) => (
              <div key={key} className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground font-medium">{i + 1}. {PROMPT_LABELS[i]}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 px-1.5 text-xs text-muted-foreground"
                    onClick={() => { navigator.clipboard.writeText(editing.prompts[key] ?? ''); toast.success('Copied!') }}
                  >
                    <Copy className="w-3 h-3" />
                  </Button>
                </div>
                <Textarea
                  value={editing.prompts[key] ?? ''}
                  onChange={e => updatePrompt(key, e.target.value)}
                  rows={2}
                  className="bg-input border-border text-xs resize-none"
                />
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-border">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          {editing.fanvueDescription && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => { onSave(editing); onSchedule(editing); onClose() }}
            >
              <Clock className="w-3 h-3 mr-1.5" />Schedule
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            disabled={generatingContext || !character}
            onClick={() => onGenerateContext(editing)}
          >
            {generatingContext
              ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Generating…</>
              : <><Sparkles className="w-3 h-3 mr-1.5" />Generate content</>
            }
          </Button>
          <Button size="sm" onClick={() => { onSave(editing); onClose() }}>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default function CalendarPage() {
  const router = useRouter()
  const [characters, setCharacters] = useState<Character[]>([])
  const [characterId, setCharacterId] = useState('')
  const [mode, setMode] = useState<'SFW' | 'NSFW'>('SFW')
  const [days, setDays] = useState<CalendarDay[]>([])
  const [generatingIds, setGeneratingIds] = useState<Set<string>>(new Set())
  const [generatingWeek, setGeneratingWeek] = useState<number | null>(null)
  const [viewDay, setViewDay] = useState<CalendarDay | null>(null)

  useEffect(() => {
    const chars = charactersStore.getAll()
    setCharacters(chars)
    if (chars.length > 0) {
      setCharacterId(chars[0].id)
      setMode(chars[0].defaultMode)
    }
  }, [])

  useEffect(() => {
    if (!characterId) return
    const char = characters.find(c => c.id === characterId)
    if (!char) return
    const template = getDaysForCharacter(char)
    const saved = calendarStore.getByCharacter(characterId)
    setDays(template.map(t => saved.find(s => s.id === t.id) ?? t))
  }, [characterId, characters])

  const refreshDays = useCallback(() => {
    const char = characters.find(c => c.id === characterId)
    if (!char) return
    const template = getDaysForCharacter(char)
    const saved = calendarStore.getByCharacter(characterId)
    const merged = template.map(t => saved.find(s => s.id === t.id) ?? t)
    setDays(merged)
    // sync open dialog if it matches a refreshed day
    setViewDay(prev => {
      if (!prev) return prev
      return merged.find(d => d.id === prev.id) ?? prev
    })
  }, [characterId, characters])

  async function generateDay(day: CalendarDay) {
    const char = characters.find(c => c.id === characterId)
    if (!char) return

    setGeneratingIds(prev => new Set(prev).add(day.id))

    try {
      const res = await fetch('/api/calendar/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'context',
          character: { name: char.name, mode, basePromptStyle: char.basePromptStyle, story: char.story },
          day: { date: day.date, notes: day.notes ?? '', topic: day.topic, keywords: day.keywords },
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'API error')

      const updated: CalendarDay = {
        ...day,
        topic: data.topic ?? '',
        keywords: data.keywords ?? '',
        description: data.description ?? '',
        fanvueDescription: data.fanvue_description ?? '',
        status: 'generated',
        createdAt: new Date().toISOString(),
      }
      calendarStore.upsert(updated)
      toast.success('Day generated!')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error')
    } finally {
      setGeneratingIds(prev => {
        const next = new Set(prev)
        next.delete(day.id)
        return next
      })
      refreshDays()
    }
  }

  async function generateWeek(weekIndex: number) {
    const char = characters.find(c => c.id === characterId)
    if (!char) return

    const startIdx = weekIndex * 7
    const weekDays = days.slice(startIdx, startIdx + 7)

    setGeneratingWeek(weekIndex)

    try {
      const results = await Promise.allSettled(
        weekDays.map(day =>
          fetch('/api/calendar/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mode: 'context',
              character: { name: char.name, mode, basePromptStyle: char.basePromptStyle, story: char.story },
              day: { date: day.date, notes: day.notes ?? '' },
            }),
          }).then(r => r.json())
        )
      )

      const updatedDays: CalendarDay[] = []
      results.forEach((result, i) => {
        if (result.status === 'fulfilled' && !result.value.error) {
          const data = result.value
          updatedDays.push({
            ...weekDays[i],
            topic: data.topic ?? '',
            keywords: data.keywords ?? '',
            description: data.description ?? '',
            fanvueDescription: data.fanvue_description ?? '',
            status: 'generated' as const,
            createdAt: new Date().toISOString(),
          })
        }
      })
      calendarStore.upsertMany(updatedDays)
      const failed = results.length - updatedDays.length
      if (failed > 0) {
        toast.warning(`Week ${weekIndex + 1}: ${updatedDays.length} generated, ${failed} failed`)
      } else {
        toast.success(`Week ${weekIndex + 1} generated! (${updatedDays.length} days)`)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error')
    } finally {
      setGeneratingWeek(null)
      refreshDays()
    }
  }

  function scheduleDay(day: CalendarDay) {
    const params = new URLSearchParams({
      characterId: day.characterId,
      caption: day.fanvueDescription,
      date: day.date,
    })
    router.push(`/schedule?${params.toString()}`)
  }

  function saveDay(updated: CalendarDay) {
    calendarStore.upsert({ ...updated, status: updated.topic ? 'generated' : updated.status })
    refreshDays()
    toast.success('Saved')
  }

  const generatedCount = days.filter(d => d.status === 'generated').length
  const weeks = [0, 1, 2, 3].map(w => days.slice(w * 7, w * 7 + 7))
  const activeChar = characters.find(c => c.id === characterId)
  const charConfig = activeChar
    ? { name: activeChar.name, mode, basePromptStyle: activeChar.basePromptStyle, story: activeChar.story }
    : undefined

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-4 px-6 py-4 border-b border-border bg-card/50">
        <div className="flex items-center gap-2">
          <CalendarDays className="w-4 h-4 text-primary" />
          <h1 className="font-semibold text-base">30 Day Calendar</h1>
        </div>

        <Separator orientation="vertical" className="h-5 bg-border/50" />

        <Select value={characterId} onValueChange={(v: string | null) => {
          if (!v) return
          setCharacterId(v)
          const char = characters.find(c => c.id === v)
          if (char) setMode(char.defaultMode)
        }}>
          <SelectTrigger className="w-36 h-8 bg-input border-border text-sm">
            <SelectValue placeholder="Character" />
          </SelectTrigger>
          <SelectContent>
            {characters.map(c => (
              <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={mode} onValueChange={(v: string | null) => { if (v) setMode(v as 'SFW' | 'NSFW') }}>
          <SelectTrigger className="w-24 h-8 bg-input border-border text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODES.map(m => (
              <SelectItem key={m} value={m}>{m}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="ml-auto flex items-center gap-2">
          <Badge variant="secondary" className="text-xs">
            {generatedCount}/28 generated
          </Badge>
        </div>
      </div>

      {/* Week grid */}
      <div className="flex-1 overflow-y-auto p-6 space-y-8">
        {weeks.map((weekDays, wi) => (
          <div key={wi}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-muted-foreground">{WEEK_LABELS[wi]}</h2>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                disabled={generatingWeek !== null}
                onClick={() => generateWeek(wi)}
              >
                {generatingWeek === wi ? (
                  <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Generating…</>
                ) : (
                  <><Sparkles className="w-3 h-3 mr-1.5" />Generate week</>
                )}
              </Button>
            </div>
            <div className="grid grid-cols-7 gap-2">
              {weekDays.map(day => (
                <DayCard
                  key={day.id}
                  day={day}
                  onOpen={setViewDay}
                  onGenerate={generateDay}
                  generating={generatingIds.has(day.id)}
                  onSchedule={scheduleDay}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <DayDialog
        day={viewDay}
        open={viewDay !== null}
        onClose={() => setViewDay(null)}
        onSave={saveDay}
        onGenerateContext={generateDay}
        generatingContext={generatingIds.has(viewDay?.id ?? '')}
        character={charConfig}
        contentMode={mode}
        onSchedule={scheduleDay}
      />
    </div>
  )
}
