'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { CAROUSEL_PRESETS, DEFAULT_CAROUSEL_PRESET_ID } from '@/lib/carousel-presets'
import { withTriggerWord, buildStyledScenePrompt } from '@/lib/character-prompt'
import { DIMENSIONS, type Character } from '@/lib/types'
import { Loader2, Wand2 } from 'lucide-react'
import type { ScrapedPromptItem } from './browse-tab'

interface GenerationPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: ScrapedPromptItem[]
  onSubmitted: () => void
}

type Mode = 'turbo-lora' | 'seedream-edit'

export function GenerationPanel({ open, onOpenChange, items, onSubmitted }: GenerationPanelProps) {
  const [characters, setCharacters] = useState<Character[]>([])
  const [characterId, setCharacterId] = useState('')
  const [mode, setMode] = useState<Mode>('turbo-lora')
  const [dimension, setDimension] = useState('9:16')
  const [folderName, setFolderName] = useState('')
  const [triggerWord, setTriggerWord] = useState('')
  const [carouselEnabled, setCarouselEnabled] = useState(false)
  const [carouselCount, setCarouselCount] = useState<1 | 2 | 3 | 4>(2)
  const [carouselPreset, setCarouselPreset] = useState(DEFAULT_CAROUSEL_PRESET_ID)
  const [grokSmart, setGrokSmart] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    fetch('/api/characters')
      .then(res => res.json())
      .then((data: Character[]) => setCharacters(Array.isArray(data) ? data : []))
      .catch(() => toast.error('Failed to load characters'))
  }, [open])

  const character = characters.find(c => c.id === characterId)

  useEffect(() => {
    setTriggerWord(character?.triggerWord ?? '')
  }, [character?.triggerWord])

  const hasFaceRefs = (character?.faceRefUrls?.length ?? 0) > 0

  async function submit() {
    if (!items.length) return
    if (!character) { toast.error('Pick a character'); return }
    if (mode === 'turbo-lora' && !character.loraUrl) {
      toast.error('This character has no trained LoRA — pick Seedream Edit instead')
      return
    }
    if (mode === 'seedream-edit' && !hasFaceRefs) {
      toast.error('This character has no face reference photos — add them in Admin, or pick LoRA + Turbo')
      return
    }
    if (!folderName.trim()) { toast.error('Enter a Drive folder name'); return }

    setSubmitting(true)
    try {
      const composedItems = items.map(it => ({
        promptId: it.id,
        prompt: withTriggerWord(buildStyledScenePrompt(character, it.prompt), triggerWord),
      }))

      const res = await fetch('/api/queue/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_type: 'copy_prompts_generate',
          input: {
            items: composedItems,
            mode,
            loraUrl: character.loraUrl,
            loraScale: character.loraScale,
            referenceImageUrls: mode === 'seedream-edit' ? character.faceRefUrls : undefined,
            dimension,
            folderName: folderName.trim(),
            characterId: character.id,
            characterName: character.name,
            carousel: carouselEnabled
              ? { enabled: true, count: carouselCount, presetId: carouselPreset, grokSmart }
              : undefined,
          },
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to submit')

      toast.success(`Queued ${items.length} item${items.length === 1 ? '' : 's'}`, {
        action: {
          label: 'Open Batches',
          onClick: () => { window.location.href = '/copy-prompts?tab=batches' },
        },
      })
      onSubmitted()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to submit')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md flex flex-col">
        <SheetHeader>
          <SheetTitle>Generate from {items.length} prompt{items.length === 1 ? '' : 's'}</SheetTitle>
          <SheetDescription>Regenerate the selected scenes using your own character.</SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 space-y-4">
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Character</p>
            <Select value={characterId} onValueChange={v => setCharacterId(v ?? '')}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Pick a character" /></SelectTrigger>
              <SelectContent>
                {characters.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Mode</p>
            <div className="flex rounded-lg border border-border overflow-hidden text-sm">
              <button
                onClick={() => setMode('turbo-lora')}
                className={`flex-1 px-3 py-2 transition-colors ${mode === 'turbo-lora' ? 'bg-primary text-primary-foreground font-medium' : 'text-muted-foreground hover:bg-secondary'}`}
              >
                LoRA + Turbo
              </button>
              <button
                onClick={() => setMode('seedream-edit')}
                className={`flex-1 px-3 py-2 transition-colors ${mode === 'seedream-edit' ? 'bg-primary text-primary-foreground font-medium' : 'text-muted-foreground hover:bg-secondary'}`}
              >
                Seedream Edit
              </button>
            </div>
            {mode === 'turbo-lora' && character && !character.loraUrl && (
              <p className="text-[11px] text-destructive">This character has no trained LoRA.</p>
            )}
            {mode === 'seedream-edit' && character && !hasFaceRefs && (
              <p className="text-[11px] text-destructive">This character has no face reference photos.</p>
            )}
            {mode === 'seedream-edit' && hasFaceRefs && (
              <div className="flex gap-1.5 flex-wrap pt-1">
                {character!.faceRefUrls!.slice(0, 6).map(url => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={url} src={url} alt="" className="w-10 h-10 rounded object-cover border border-border" />
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Dimension</p>
            <Select value={dimension} onValueChange={v => setDimension(v ?? '9:16')}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.keys(DIMENSIONS).map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5 rounded-xl border border-border p-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium">Carousel</p>
              <button onClick={() => setCarouselEnabled(v => !v)}>
                <Badge variant={carouselEnabled ? 'default' : 'outline'}>{carouselEnabled ? 'On' : 'Off'}</Badge>
              </button>
            </div>
            {carouselEnabled && (
              <div className="space-y-2 pt-1">
                <div className="flex gap-1.5">
                  {([1, 2, 3, 4] as const).map(n => (
                    <button
                      key={n}
                      onClick={() => setCarouselCount(n)}
                      className={`w-8 h-8 rounded-md border text-sm transition-colors ${carouselCount === n ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:bg-secondary'}`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <Select value={carouselPreset} onValueChange={v => setCarouselPreset(v ?? DEFAULT_CAROUSEL_PRESET_ID)}>
                  <SelectTrigger className="w-full h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CAROUSEL_PRESETS.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <button
                  onClick={() => setGrokSmart(v => !v)}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  <Wand2 className="w-3.5 h-3.5" />
                  Grok smart analysis {grokSmart ? 'on' : 'off'}
                </button>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Drive folder name</p>
            <Input value={folderName} onChange={e => setFolderName(e.target.value)} placeholder="e.g. sofia_copy_prompts" />
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              Trigger word <span className="opacity-60">(applied to every prompt in this batch)</span>
            </p>
            <Input value={triggerWord} onChange={e => setTriggerWord(e.target.value)} placeholder="e.g. sofia_lora" />
          </div>
        </div>

        <SheetFooter>
          <Button onClick={submit} disabled={submitting || !items.length} className="w-full">
            {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Wand2 className="w-4 h-4 mr-2" />}
            Generate {items.length} item{items.length === 1 ? '' : 's'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
