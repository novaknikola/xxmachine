'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { CAROUSEL_PRESETS, DEFAULT_CAROUSEL_PRESET_ID } from '@/lib/carousel-presets'
import { cleanSceneRefUrls } from '@/lib/scene-refs'
import { SEEDREAM_MAX_IMAGES } from '@/lib/wavespeed'
import { withTriggerWord, buildStyledScenePrompt } from '@/lib/character-prompt'
import { DIMENSIONS, type Character } from '@/lib/types'
import { Loader2, Upload, Wand2, X } from 'lucide-react'
import type { ScrapedPromptItem } from './browse-tab'

interface GenerationPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: ScrapedPromptItem[]
  onSubmitted: () => void
}

type Mode = 'turbo-lora' | 'seedream-edit'

interface UploadedRef {
  id: string
  file: File
  previewUrl: string
}

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
  const [uploadedRefs, setUploadedRefs] = useState<UploadedRef[]>([])
  const [sceneRefUrlsRaw, setSceneRefUrlsRaw] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

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

  const faceRefUrls = character?.faceRefUrls ?? []
  const hasFaceRefs = faceRefUrls.length > 0
  const sceneRefUrls = cleanSceneRefUrls(sceneRefUrlsRaw)
  // Character identity first so it keeps Seedream's primary image slot, then
  // one-off uploads, then pasted scene links.
  const totalRefCount = faceRefUrls.length + uploadedRefs.length + sceneRefUrls.length
  const overCap = totalRefCount > SEEDREAM_MAX_IMAGES

  function addRefFiles(files: FileList | null) {
    if (!files?.length) return
    const room = SEEDREAM_MAX_IMAGES - (faceRefUrls.length + uploadedRefs.length + sceneRefUrls.length)
    if (room <= 0) { toast.error(`Already at ${SEEDREAM_MAX_IMAGES} reference images`); return }
    const picked = Array.from(files).slice(0, room)
    setUploadedRefs(prev => [
      ...prev,
      ...picked.map(file => ({ id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file) })),
    ])
    if (files.length > room) toast.message(`Only ${room} more image(s) added (max ${SEEDREAM_MAX_IMAGES})`)
  }

  /** Uploads happen on submit, not on pick, so abandoning the panel costs nothing. */
  async function uploadRefFiles(): Promise<string[]> {
    const urls: string[] = []
    for (const ref of uploadedRefs) {
      const res = await fetch('/api/queue/upload-input', {
        method: 'POST',
        headers: {
          'content-type': ref.file.type || 'image/jpeg',
          'x-file-name': encodeURIComponent(ref.file.name),
        },
        body: ref.file,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `Upload failed for ${ref.file.name}`)
      urls.push(data.url as string)
    }
    return urls
  }

  async function submit() {
    if (!items.length) return
    // The two modes are independent: LoRA + Turbo generates from a trained
    // character, Seedream Edit generates from reference images. Neither should
    // demand what the other needs.
    if (mode === 'turbo-lora') {
      if (!character) { toast.error('Pick a character — LoRA + Turbo generates from its trained LoRA'); return }
      if (!character.loraUrl) {
        toast.error('This character has no trained LoRA — pick Seedream Edit instead')
        return
      }
    }
    // Any of the three sources is a valid Seedream reference, so a character
    // without stored face refs is no longer a dead end here.
    if (mode === 'seedream-edit' && totalRefCount === 0) {
      toast.error('Seedream Edit needs at least one reference image — upload one, paste a URL, or add face refs in Admin')
      return
    }
    if (mode === 'seedream-edit' && overCap) {
      toast.error(`Seedream takes at most ${SEEDREAM_MAX_IMAGES} images — you have ${totalRefCount}`)
      return
    }
    if (!folderName.trim()) { toast.error('Enter a Drive folder name'); return }

    setSubmitting(true)
    try {
      const isSeedream = mode === 'seedream-edit'
      const referenceImageUrls = isSeedream
        ? [...faceRefUrls, ...(await uploadRefFiles()), ...sceneRefUrls].slice(0, SEEDREAM_MAX_IMAGES)
        : undefined

      const composedItems = items.map(it => {
        const styled = buildStyledScenePrompt(character, it.prompt)
        // A trigger word only means anything to a LoRA — injecting it into a
        // Seedream prompt just adds a stray token like "sofia_lora".
        return { promptId: it.id, prompt: isSeedream ? styled : withTriggerWord(styled, triggerWord) }
      })

      const res = await fetch('/api/queue/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_type: 'copy_prompts_generate',
          input: {
            items: composedItems,
            mode,
            loraUrl: isSeedream ? null : character?.loraUrl ?? null,
            loraScale: isSeedream ? undefined : character?.loraScale,
            referenceImageUrls,
            dimension,
            folderName: folderName.trim(),
            characterId: character?.id ?? null,
            characterName: character?.name ?? null,
            carousel: carouselEnabled
              ? { enabled: true, count: carouselCount, presetId: carouselPreset, grokSmart }
              : undefined,
          },
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to submit')

      // The files are uploaded and queued now, so the local previews are dead
      // weight — release the blobs rather than holding them for the session.
      for (const ref of uploadedRefs) URL.revokeObjectURL(ref.previewUrl)
      setUploadedRefs([])
      setSceneRefUrlsRaw('')

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
            <p className="text-xs font-medium text-muted-foreground">
              Character{mode === 'seedream-edit' && <span className="opacity-60"> (optional)</span>}
            </p>
            <Select value={characterId} onValueChange={v => setCharacterId(v ?? '')}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={mode === 'seedream-edit' ? 'None — identity comes from the references' : 'Pick a character'} />
              </SelectTrigger>
              <SelectContent>
                {characters.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {mode === 'seedream-edit' && (
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] text-muted-foreground/60">
                  Only used for its style prefix and stored face refs — Seedream Edit needs no LoRA.
                </p>
                {/* Without this a character picked for LoRA mode could not be
                    dropped again, and its style prefix would ride along into
                    every Seedream prompt. */}
                {characterId && (
                  <button
                    onClick={() => setCharacterId('')}
                    className="text-[10px] text-muted-foreground hover:text-foreground shrink-0 underline"
                  >
                    Clear
                  </button>
                )}
              </div>
            )}
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
          </div>

          {mode === 'seedream-edit' && (
            <div className="space-y-2 rounded-xl border border-border p-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium">Reference images</p>
                <span className={`text-[10px] ${overCap ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {totalRefCount}/{SEEDREAM_MAX_IMAGES}
                </span>
              </div>

              {hasFaceRefs ? (
                <div className="space-y-1">
                  <p className="text-[10px] text-muted-foreground">Character face refs</p>
                  <div className="flex gap-1.5 flex-wrap">
                    {faceRefUrls.slice(0, 6).map(url => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={url} src={url} alt="" className="w-10 h-10 rounded object-cover border border-border" />
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-[10px] text-muted-foreground">
                  {character
                    ? 'This character has no stored face refs — upload one below or paste a URL.'
                    : 'Pick a character to use its stored face refs, or supply images below.'}
                </p>
              )}

              <div className="space-y-1">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={e => { addRefFiles(e.target.files); e.target.value = '' }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full h-8 text-xs"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="w-3.5 h-3.5 mr-1.5" />
                  Upload reference photos
                </Button>
                {uploadedRefs.length > 0 && (
                  <div className="flex gap-1.5 flex-wrap pt-1">
                    {uploadedRefs.map(ref => (
                      <div key={ref.id} className="relative group">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={ref.previewUrl} alt="" className="w-10 h-10 rounded object-cover border border-border" />
                        <button
                          onClick={() => {
                            URL.revokeObjectURL(ref.previewUrl)
                            setUploadedRefs(prev => prev.filter(r => r.id !== ref.id))
                          }}
                          className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-black/70 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <X className="w-2.5 h-2.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground">Scene reference URLs — one per line</p>
                <Textarea
                  value={sceneRefUrlsRaw}
                  onChange={e => setSceneRefUrlsRaw(e.target.value)}
                  placeholder={'Pinterest pin, CDN link...\nhttps://i.pinimg.com/originals/...'}
                  className="text-[11px] font-mono min-h-[60px]"
                />
                {sceneRefUrls.length > 0 && (
                  <div className="flex gap-1.5 flex-wrap pt-1">
                    {sceneRefUrls.slice(0, 8).map(url => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={url}
                        src={`/api/proxy-image?url=${encodeURIComponent(url)}`}
                        alt=""
                        className="w-10 h-10 rounded object-cover border border-border"
                        onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden' }}
                      />
                    ))}
                  </div>
                )}
                <p className="text-[10px] text-muted-foreground/60">
                  Not downloaded — Seedream fetches each URL itself.
                </p>
              </div>
            </div>
          )}

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

          {/* LoRA-only: Seedream Edit has no trigger word to fire. */}
          {mode === 'turbo-lora' && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                Trigger word <span className="opacity-60">(applied to every prompt in this batch)</span>
              </p>
              <Input value={triggerWord} onChange={e => setTriggerWord(e.target.value)} placeholder="e.g. sofia_lora" />
            </div>
          )}
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
