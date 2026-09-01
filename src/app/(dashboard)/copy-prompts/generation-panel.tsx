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
import { cleanSceneRefUrls, DEFAULT_SCENE_EDIT_PROMPT } from '@/lib/scene-refs'
import { maxItemsForJob } from '@/lib/queue-limits'
import { SEEDREAM_MAX_IMAGES } from '@/lib/wavespeed'
import { withTriggerWord, buildStyledScenePrompt } from '@/lib/character-prompt'
import { DIMENSIONS, type Character } from '@/lib/types'
import { Loader2, Sparkles, Upload, Wand2, X } from 'lucide-react'
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
  const [posePrompt, setPosePrompt] = useState('')
  const [uploadedRefs, setUploadedRefs] = useState<UploadedRef[]>([])
  const [sceneRefUrlsRaw, setSceneRefUrlsRaw] = useState('')
  const [pinPrompt, setPinPrompt] = useState(DEFAULT_SCENE_EDIT_PROMPT)
  const [submitting, setSubmitting] = useState(false)
  const [analyzedPrompts, setAnalyzedPrompts] = useState<Record<string, string>>({})
  const [analyzing, setAnalyzing] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Pins arrive with an image but no prompt of their own, so the batch needs
  // either a shared instruction (Seedream) or a per-image Grok description
  // (LoRA + Turbo) to know what's actually in the photo.
  const pinBatch = items.length > 0 && items.every(it => it.sceneRefUrl)
  const effMode: Mode = mode

  useEffect(() => {
    if (!open) return
    fetch('/api/characters')
      .then(res => res.json())
      .then((data: Character[]) => setCharacters(Array.isArray(data) ? data : []))
      .catch(() => toast.error('Failed to load characters'))
    // A pin batch defaults to Seedream Edit (identity swap via the pin image
    // itself) — the safer, previously-only option. LoRA + Turbo is still
    // reachable by switching the toggle, using Grok-analyzed scene prompts
    // instead of the image. Reset per open so a stale analysis from a
    // previous selection never leaks into a new one.
    setAnalyzedPrompts({})
    if (pinBatch) setMode('seedream-edit')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /** Grok describes each photo's pose/framing/background/lighting individually — items
   *  that already carry their own prompt (real scraped prompts) are left alone. */
  async function analyzeWithGrok() {
    const targets = items.filter(it => it.sceneRefUrl && !it.prompt?.trim() && !analyzedPrompts[it.id])
    if (!targets.length) return
    setAnalyzing(true)
    try {
      const res = await fetch('/api/grok/analyze-scene', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrls: targets.map(it => it.sceneRefUrl) }),
      })
      const data = await res.json() as { prompts?: string[]; error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Analysis failed')
      const prompts = data.prompts ?? []
      setAnalyzedPrompts(prev => {
        const next = { ...prev }
        targets.forEach((it, i) => { if (prompts[i]) next[it.id] = prompts[i] })
        return next
      })
      const failed = targets.length - prompts.filter(Boolean).length
      toast.success(`Analyzed ${targets.length - failed}/${targets.length} image${targets.length === 1 ? '' : 's'}${failed ? ` — ${failed} failed, try again` : ''}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Analysis failed')
    } finally {
      setAnalyzing(false)
    }
  }


  const character = characters.find(c => c.id === characterId)

  useEffect(() => {
    setTriggerWord(character?.triggerWord ?? '')
  }, [character?.triggerWord])

  const faceRefUrls = character?.faceRefUrls ?? []
  const hasFaceRefs = faceRefUrls.length > 0
  const sceneRefUrls = cleanSceneRefUrls(sceneRefUrlsRaw)
  // These are the job-level (identity) references. For a pin batch each item
  // additionally carries its own scene reference, which the worker sends ahead
  // of these — see DEFAULT_SCENE_EDIT_PROMPT.
  const totalRefCount = faceRefUrls.length + uploadedRefs.length + sceneRefUrls.length
  const overCap = totalRefCount > SEEDREAM_MAX_IMAGES

  // Mirrors the queue route's budget so the limit shows here rather than coming
  // back as an error after the panel is filled in.
  const slidesPerItem = carouselEnabled ? 1 + carouselCount : 1
  const maxItems = maxItemsForJob({
    usesSeedream: effMode === 'seedream-edit' || carouselEnabled,
    carouselCount: carouselEnabled ? carouselCount : null,
  })
  const overItemCap = items.length > maxItems

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
    if (effMode === 'turbo-lora') {
      if (!character) { toast.error('Pick a character — LoRA + Turbo generates from its trained LoRA'); return }
      if (!character.loraUrl) {
        toast.error('This character has no trained LoRA — pick Seedream Edit instead')
        return
      }
      if (pinBatch) {
        const missing = items.filter(it => !it.prompt?.trim() && !analyzedPrompts[it.id])
        if (missing.length) {
          toast.error(`${missing.length} image${missing.length === 1 ? '' : 's'} still need a scene description — click "Analyze with Grok"`)
          return
        }
      }
    }
    // Any of the three sources is a valid Seedream reference, so a character
    // without stored face refs is no longer a dead end here.
    if (pinBatch && effMode === 'seedream-edit' && !pinPrompt.trim()) {
      toast.error('Describe what to generate from the selected pins')
      return
    }
    // A pin is its own reference, so the per-item count carries the batch even
    // when no character refs or uploads were supplied.
    if (effMode === 'seedream-edit' && totalRefCount === 0 && !pinBatch) {
      toast.error('Seedream Edit needs at least one reference image — upload one, paste a URL, or add face refs in Admin')
      return
    }
    if (effMode === 'seedream-edit' && overCap) {
      toast.error(`Seedream takes at most ${SEEDREAM_MAX_IMAGES} images — you have ${totalRefCount}`)
      return
    }
    if (!folderName.trim()) { toast.error('Enter a Drive folder name'); return }
    if (carouselEnabled && !posePrompt.trim()) { toast.error('Write a pose-change prompt for the carousel'); return }

    setSubmitting(true)
    try {
      const isSeedream = effMode === 'seedream-edit'
      const referenceImageUrls = isSeedream
        ? [...faceRefUrls, ...(await uploadRefFiles()), ...sceneRefUrls].slice(0, SEEDREAM_MAX_IMAGES)
        : undefined

      const composedItems = items.map(it => {
        // A pin/clip carries no prompt of its own — fall back to whatever
        // Grok analyzed for its specific photo, so LoRA + Turbo (which never
        // sees the image itself) still knows what scene to generate.
        const effectivePrompt = it.prompt?.trim() || analyzedPrompts[it.id] || ''
        // A scene-edit prompt addresses the reference images by position and
        // states the identity itself, so it is sent verbatim. Prepending the
        // character's style prefix would push "Image 1 is..." off the front and
        // argue with the hair and wardrobe the prompt already pins down. The
        // Grok scene description (if any) is appended as extra detail, not a
        // replacement — the identity-swap instructions still lead.
        const styled = pinBatch && isSeedream
          ? pinPrompt.trim() + (analyzedPrompts[it.id] ? `\nScene detail: ${analyzedPrompts[it.id]}` : '')
          : buildStyledScenePrompt(character, effectivePrompt)
        // A trigger word only means anything to a LoRA — injecting it into a
        // Seedream prompt just adds a stray token like "sofia_lora".
        return {
          promptId: it.id,
          prompt: isSeedream ? styled : withTriggerWord(styled, triggerWord),
          // Reference images are a Seedream concept (image-to-image edit) —
          // LoRA + Turbo is pure text-to-image from the trained model and
          // never looks at the source photo, so sending it would be dead weight.
          referenceImageUrls: (isSeedream && it.sceneRefUrl) ? [it.sceneRefUrl] : undefined,
        }
      })

      const res = await fetch('/api/queue/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_type: 'copy_prompts_generate',
          input: {
            items: composedItems,
            mode: effMode,
            loraUrl: isSeedream ? null : character?.loraUrl ?? null,
            loraScale: isSeedream ? undefined : character?.loraScale,
            referenceImageUrls,
            dimension,
            folderName: folderName.trim(),
            characterId: character?.id ?? null,
            characterName: character?.name ?? null,
            carousel: carouselEnabled
              ? { enabled: true, count: carouselCount, posePrompt: posePrompt.trim() }
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
      setAnalyzedPrompts({})

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
              Character{effMode === 'seedream-edit' && <span className="opacity-60"> (optional)</span>}
            </p>
            <Select value={characterId} onValueChange={v => setCharacterId(v ?? '')}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={effMode === 'seedream-edit' ? 'None — identity comes from the references' : 'Pick a character'} />
              </SelectTrigger>
              <SelectContent>
                {characters.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {effMode === 'seedream-edit' && (
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
                className={`flex-1 px-3 py-2 transition-colors ${effMode === 'turbo-lora' ? 'bg-primary text-primary-foreground font-medium' : 'text-muted-foreground hover:bg-secondary'}`}
              >
                LoRA + Turbo
              </button>
              <button
                onClick={() => setMode('seedream-edit')}
                className={`flex-1 px-3 py-2 transition-colors ${effMode === 'seedream-edit' ? 'bg-primary text-primary-foreground font-medium' : 'text-muted-foreground hover:bg-secondary'}`}
              >
                Seedream Edit
              </button>
            </div>
            {effMode === 'turbo-lora' && character && !character.loraUrl && (
              <p className="text-[11px] text-destructive">This character has no trained LoRA.</p>
            )}
            {effMode === 'turbo-lora' && pinBatch && (
              <p className="text-[10px] text-muted-foreground/60">
                Text-to-image from the LoRA — the pin/clip photo itself isn&apos;t sent, only its Grok-analyzed
                scene description below (plus the trigger word) drive the result.
              </p>
            )}
          </div>

          {pinBatch && (
            <div className="space-y-1.5 rounded-xl border border-border p-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium">Scene analysis (Grok)</p>
                <span className="text-[10px] text-muted-foreground">
                  {items.filter(it => it.prompt?.trim() || analyzedPrompts[it.id]).length}/{items.length} described
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
                Describes each selected photo&apos;s pose, framing, background and lighting individually —
                {effMode === 'turbo-lora'
                  ? ' this is the only thing that tells LoRA + Turbo what scene to generate.'
                  : ' appended as extra detail under the identity-swap prompt below.'}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="w-full h-8 text-xs"
                onClick={() => void analyzeWithGrok()}
                disabled={analyzing || items.every(it => it.prompt?.trim() || analyzedPrompts[it.id])}
              >
                {analyzing ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 mr-1.5" />}
                Analyze {items.filter(it => !it.prompt?.trim() && !analyzedPrompts[it.id]).length} image{items.filter(it => !it.prompt?.trim() && !analyzedPrompts[it.id]).length === 1 ? '' : 's'} with Grok
              </Button>
            </div>
          )}

          {pinBatch && effMode === 'seedream-edit' && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                Prompt <span className="opacity-60">(applied to every selected pin)</span>
              </p>
              <Textarea
                value={pinPrompt}
                onChange={e => setPinPrompt(e.target.value)}
                placeholder="Recreate this scene with my character — same pose, composition and lighting"
                className="text-xs min-h-[72px]"
              />
              <div className="flex items-start justify-between gap-2">
                <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
                  {items.length} pin{items.length === 1 ? '' : 's'} → {items.length} job
                  {items.length === 1 ? '' : 's'}, each against its own scene. Sent verbatim, with no
                  character style prefix. <strong className="text-muted-foreground">image 1 = the pin,
                  image 2+ = your reference photos</strong> — keep that order in mind if you rewrite it.
                </p>
                {pinPrompt !== DEFAULT_SCENE_EDIT_PROMPT && (
                  <button
                    onClick={() => setPinPrompt(DEFAULT_SCENE_EDIT_PROMPT)}
                    className="text-[10px] text-muted-foreground hover:text-foreground shrink-0 underline"
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>
          )}

          {effMode === 'seedream-edit' && (
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
                <p className="text-[10px] text-muted-foreground">Scene reference URLs — Pinterest, CDN (one per line)</p>
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
                <div className="space-y-1">
                  <p className="text-[10px] text-muted-foreground">Pose change prompt</p>
                  <Textarea
                    value={posePrompt}
                    onChange={e => setPosePrompt(e.target.value)}
                    placeholder="e.g. three-quarter angle, camera rotated slightly right, same outfit and room"
                    className="text-xs min-h-[60px]"
                  />
                  <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
                    Edited against the base (first generated) image, not the original reference — used as-is, nothing added.
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Drive folder name</p>
            <Input value={folderName} onChange={e => setFolderName(e.target.value)} placeholder="e.g. sofia_copy_prompts" />
          </div>

          {/* LoRA-only: Seedream Edit has no trigger word to fire. */}
          {effMode === 'turbo-lora' && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                Trigger word <span className="opacity-60">(applied to every prompt in this batch)</span>
              </p>
              <Input value={triggerWord} onChange={e => setTriggerWord(e.target.value)} placeholder="e.g. sofia_lora" />
            </div>
          )}
        </div>

        <SheetFooter className="flex-col gap-2">
          <p className={`text-[10px] w-full ${overItemCap ? 'text-destructive' : 'text-muted-foreground/60'}`}>
            {items.length} × {slidesPerItem} slide{slidesPerItem === 1 ? '' : 's'} ={' '}
            <strong>{items.length * slidesPerItem} images</strong>
            {overItemCap
              ? ` — over the limit. Max ${maxItems} item${maxItems === 1 ? '' : 's'} at this carousel size; deselect ${items.length - maxItems} or lower the carousel count.`
              : ` · up to ${maxItems} items allowed here`}
          </p>
          <Button onClick={submit} disabled={submitting || !items.length || overItemCap} className="w-full">
            {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Wand2 className="w-4 h-4 mr-2" />}
            Generate {items.length} item{items.length === 1 ? '' : 's'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
