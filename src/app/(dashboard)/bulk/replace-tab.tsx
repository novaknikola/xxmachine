'use client'

/**
 * Replace — puts our character into someone else's photo.
 *
 * Two reference sets: the character (identity) and the Pinterest examples
 * (scene/pose/framing to keep). Each example becomes one Seedream edit, so N
 * pins in = N images out. The scene reference is always sent ahead of the
 * character ones because the prompt addresses images by position — see
 * DEFAULT_SCENE_EDIT_PROMPT.
 *
 * Either side takes uploads or pasted URLs. Pasted links are handed to
 * Seedream as-is (it fetches them itself), so pins cost us no storage.
 */

import { useRef, useState } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { generationsStore } from '@/lib/store'
import { DIMENSIONS } from '@/lib/types'
import { cleanSceneRefUrls, DEFAULT_SCENE_EDIT_PROMPT } from '@/lib/scene-refs'
import { SEEDREAM_MAX_IMAGES, type SeedreamResolution } from '@/lib/wavespeed'
import {
  CONTENT_FORMATS,
  suggestedDimensionForFormat,
  type ContentFormat,
} from '@/lib/drive-archive/content-format'
import { maxItemsForJob } from '@/lib/queue-limits'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import { Info, ListTodo, Loader2, Play, RotateCcw, Square, Upload, X } from 'lucide-react'

const RUN_CONCURRENCY = 2

export interface ReplaceResultImage {
  id: string
  url: string
  prompt: string
  selected: boolean
}

interface LocalFile {
  id: string
  file: File
  url: string
}

interface ReplaceTabProps {
  /** Fires per finished image so the page can feed the grid + Train LoRA. */
  onGenerated: (img: ReplaceResultImage) => void
  onRunStart?: () => void
}

/** Upload picker + thumbnail grid + optional URL box, shared by both sides. */
function RefPicker({
  title,
  hint,
  files,
  urlsRaw,
  urlPlaceholder,
  onAdd,
  onRemove,
  onUrlsChange,
}: {
  title: string
  hint: string
  files: LocalFile[]
  urlsRaw: string
  urlPlaceholder: string
  onAdd: (files: FileList | null) => void
  onRemove: (id: string) => void
  onUrlsChange: (v: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const urls = cleanSceneRefUrls(urlsRaw)

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <input ref={inputRef} type="file" multiple className="hidden"
          accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
          onChange={e => { onAdd(e.target.files); e.target.value = '' }} />
        <button
          onClick={() => inputRef.current?.click()}
          className="w-full border-2 border-dashed border-border rounded-xl p-6 flex flex-col items-center gap-2 hover:border-primary/50 hover:bg-primary/5 transition-colors text-muted-foreground hover:text-foreground">
          <Upload className="w-6 h-6" />
          <span className="text-sm">Upload</span>
          <span className="text-xs opacity-60">{hint}</span>
        </button>

        {(files.length > 0 || urls.length > 0) && (
          <div className="grid grid-cols-4 gap-2">
            {files.map(img => (
              <div key={img.id} className="relative group aspect-square rounded-lg overflow-hidden border border-border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.url} alt="" className="absolute inset-0 w-full h-full object-cover" />
                <button onClick={() => onRemove(img.id)}
                  className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            ))}
            {urls.map(url => (
              <div key={url} className="relative aspect-square rounded-lg overflow-hidden border border-dashed border-border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt="" className="absolute inset-0 w-full h-full object-cover" />
              </div>
            ))}
          </div>
        )}

        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Or paste image URLs — one per line (optional)</Label>
          <Textarea
            placeholder={urlPlaceholder}
            value={urlsRaw}
            onChange={e => onUrlsChange(e.target.value)}
            rows={3}
            className="resize-none font-mono text-xs"
          />
        </div>
        <p className="text-xs text-muted-foreground text-center">
          {files.length + urls.length} image(s)
          {urls.length > 0 && <span className="opacity-60"> · {urls.length} by URL</span>}
        </p>
      </CardContent>
    </Card>
  )
}

export function ReplaceTab({ onGenerated, onRunStart }: ReplaceTabProps) {
  const { user } = useAuth()

  const [charFiles, setCharFiles] = useState<LocalFile[]>([])
  const [charUrlsRaw, setCharUrlsRaw] = useState('')
  const [pinFiles, setPinFiles] = useState<LocalFile[]>([])
  const [pinUrlsRaw, setPinUrlsRaw] = useState('')

  const [prompt, setPrompt] = useState(DEFAULT_SCENE_EDIT_PROMPT)
  const [format, setFormat] = useState<ContentFormat>('stories')
  const [dimension, setDimension] = useState(suggestedDimensionForFormat('stories'))
  const [resolution, setResolution] = useState<SeedreamResolution>('1k')
  const [driveFolder, setDriveFolder] = useState('')

  const [running, setRunning] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const abortRef = useRef(false)

  const charCount = charFiles.length + cleanSceneRefUrls(charUrlsRaw).length
  const pinCount = pinFiles.length + cleanSceneRefUrls(pinUrlsRaw).length
  // The pin occupies Seedream's first image slot, so identity refs get the rest.
  const maxCharRefs = SEEDREAM_MAX_IMAGES - 1
  const maxPins = maxItemsForJob({ usesSeedream: true })

  function addFiles(setter: (fn: (prev: LocalFile[]) => LocalFile[]) => void, files: FileList | null) {
    if (!files?.length) return
    const added = Array.from(files).map(file => ({
      id: crypto.randomUUID(),
      file,
      url: URL.createObjectURL(file),
    }))
    setter(prev => [...prev, ...added])
  }

  async function uploadLocal(files: LocalFile[]): Promise<string[]> {
    const urls: string[] = []
    for (const item of files) {
      const res = await fetch('/api/queue/upload-input', {
        method: 'POST',
        headers: {
          'content-type': item.file.type || 'image/jpeg',
          'x-file-name': encodeURIComponent(item.file.name || 'ref.jpg'),
        },
        body: item.file,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Upload failed')
      urls.push(data.url as string)
    }
    return urls
  }

  /** Validates the form and turns both sides into URL lists Seedream can fetch. */
  async function resolveInputs(): Promise<{ charUrls: string[]; pinUrls: string[] } | null> {
    if (!charCount) { toast.error('Add a reference photo of the character'); return null }
    if (!pinCount) { toast.error('Add at least one Pinterest example'); return null }
    if (!driveFolder.trim()) { toast.error('Enter a Drive folder name (girl)'); return null }
    if (charCount > maxCharRefs) {
      toast.error(`At most ${maxCharRefs} reference photos — the example takes the first slot`)
      return null
    }
    if (!prompt.trim()) { toast.error('Prompt cannot be empty'); return null }

    const charUrls = [...(await uploadLocal(charFiles)), ...cleanSceneRefUrls(charUrlsRaw)]
    const pinUrls = [...(await uploadLocal(pinFiles)), ...cleanSceneRefUrls(pinUrlsRaw)]
    return { charUrls, pinUrls }
  }

  async function replaceOne(pinUrl: string, charUrls: string[]) {
    const res = await fetch('/api/edit-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Scene first, identity after — the prompt names images by position.
        imageUrls: [pinUrl, ...charUrls].slice(0, SEEDREAM_MAX_IMAGES),
        prompt: prompt.trim(),
        size: dimension,
        resolution,
        saveHistory: true,
        historyPrompt: prompt.trim(),
        kind: 'seedream_edit',
        characterName: driveFolder.trim(),
        contentFormat: format,
      }),
    })
    const data = await res.json()
    if (!res.ok || !data.urls?.length) throw new Error(data.error ?? 'Replace failed')
    return data.urls as string[]
  }

  async function runHere() {
    const resolved = await resolveInputs().catch(err => {
      toast.error(err instanceof Error ? err.message : 'Upload failed')
      return null
    })
    if (!resolved) return
    const { charUrls, pinUrls } = resolved

    abortRef.current = false
    setRunning(true)
    setProgress({ done: 0, total: pinUrls.length })
    onRunStart?.()

    let done = 0
    let cursor = 0
    async function worker() {
      while (cursor < pinUrls.length) {
        if (abortRef.current) break
        const pinUrl = pinUrls[cursor++]
        try {
          const urls = await replaceOne(pinUrl, charUrls)
          const rowId = crypto.randomUUID()
          onGenerated({ id: rowId, url: urls[0], prompt: prompt.trim(), selected: true })
          generationsStore.add({
            id: rowId,
            kind: 'wan_edit',
            characterId: '',
            characterName: driveFolder.trim(),
            prompt: prompt.trim(),
            dimension,
            batch: 1,
            status: 'done',
            outputUrls: urls,
            inputImageUrl: pinUrl,
            createdAt: new Date().toISOString(),
            userId: user?.id ?? '',
          })
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Replace failed')
        }
        done++
        setProgress({ done, total: pinUrls.length })
      }
    }

    await Promise.all(Array.from({ length: RUN_CONCURRENCY }, worker))
    setRunning(false)
    if (abortRef.current) toast.info(`Stopped at ${done}/${pinUrls.length}`)
    else toast.success(`Replaced ${done}/${pinUrls.length} images`)
  }

  async function sendToQueue() {
    if (pinCount > maxPins) {
      toast.error(`At most ${maxPins} examples per queue job — you have ${pinCount}`)
      return
    }
    setSubmitting(true)
    try {
      const resolved = await resolveInputs()
      if (!resolved) return
      const { charUrls, pinUrls } = resolved

      const res = await fetch('/api/queue/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_type: 'copy_prompts_generate',
          input: {
            // One item per example; each carries its own scene reference and
            // the worker sends it ahead of the shared character refs.
            items: pinUrls.map(url => ({
              promptId: crypto.randomUUID(),
              prompt: prompt.trim(),
              referenceImageUrls: [url],
            })),
            mode: 'seedream-edit',
            referenceImageUrls: charUrls,
            dimension,
            folderName: driveFolder.trim(),
            contentFormat: format,
            seedreamResolution: resolution,
          },
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Queue submit failed')

      toast.success(`${pinUrls.length} image(s) sent to queue`, {
        description: 'Runs in the background and lands in Drive — you can leave the page',
        action: { label: 'Open Queue', onClick: () => { window.location.href = '/captions?tab=queue' } },
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Queue submit failed')
    } finally {
      setSubmitting(false)
    }
  }

  const busy = running || submitting

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <RefPicker
          title="1. Reference photo (our character)"
          hint={`Face + body shots — up to ${maxCharRefs}`}
          files={charFiles}
          urlsRaw={charUrlsRaw}
          urlPlaceholder={'https://.../face.jpg\nhttps://.../body.jpg'}
          onAdd={files => addFiles(setCharFiles, files)}
          onRemove={id => setCharFiles(prev => prev.filter(f => f.id !== id))}
          onUrlsChange={setCharUrlsRaw}
        />
        <RefPicker
          title="2. Pinterest examples"
          hint="Scenes to put the character into — one image = one output"
          files={pinFiles}
          urlsRaw={pinUrlsRaw}
          urlPlaceholder={'https://i.pinimg.com/originals/....jpg\nhttps://i.pinimg.com/originals/....jpg'}
          onAdd={files => addFiles(setPinFiles, files)}
          onRemove={id => setPinFiles(prev => prev.filter(f => f.id !== id))}
          onUrlsChange={setPinUrlsRaw}
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">
              3. Prompt
            </CardTitle>
            <Button size="sm" variant="ghost" className="h-7 text-xs gap-1"
              onClick={() => setPrompt(DEFAULT_SCENE_EDIT_PROMPT)}>
              <RotateCcw className="w-3 h-3" />Reset
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <Textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            rows={6}
            className="resize-none font-mono text-xs"
          />
          <p className="text-[10px] text-muted-foreground">
            Image 1 is the Pinterest example, image 2+ are the character — keep that wording if you edit this.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">
            4. Output
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Format</Label>
              <Select
                value={format}
                onValueChange={v => {
                  if (!v) return
                  const next = v as ContentFormat
                  setFormat(next)
                  setDimension(suggestedDimensionForFormat(next))
                }}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CONTENT_FORMATS.map(f => (
                    <SelectItem key={f.id} value={f.id}>{f.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Aspect ratio</Label>
              <Select value={dimension} onValueChange={v => { if (v) setDimension(v) }}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(DIMENSIONS).map(([ratio, px]) => (
                    <SelectItem key={ratio} value={ratio}>{ratio} — {px}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Resolution</Label>
              <Select value={resolution} onValueChange={v => { if (v) setResolution(v as SeedreamResolution) }}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1k">1k</SelectItem>
                  <SelectItem value="2k">2k</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Drive folder (girl)</Label>
              <Input value={driveFolder} onChange={e => setDriveFolder(e.target.value)}
                placeholder="e.g. tiana" className="h-8 text-xs" />
            </div>
          </div>

          <div className="flex items-center gap-2 p-3 rounded-lg bg-secondary/50 border border-border text-xs text-muted-foreground">
            <Info className="w-3.5 h-3.5 shrink-0" />
            <span>
              <strong className="text-foreground">{pinCount}</strong> example(s) ×{' '}
              <strong className="text-foreground">{charCount}</strong> reference photo(s) →{' '}
              <strong className="text-primary">{pinCount}</strong> image(s), saved to Drive under{' '}
              <span className="font-mono">{driveFolder.trim() || '…'}/{format === 'carousels' ? 'carousel' : format === 'reels' ? 'video' : 'stories'}</span>
            </span>
          </div>

          {!running ? (
            <div className="flex gap-2">
              <Button className="flex-1" onClick={runHere} disabled={busy || !pinCount || !charCount}>
                <Play className="w-4 h-4 mr-2" />Run here
              </Button>
              <Button variant="outline" className="flex-1" onClick={sendToQueue}
                disabled={busy || !pinCount || !charCount}>
                {submitting
                  ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending...</>
                  : <><ListTodo className="w-4 h-4 mr-2" />Send to queue</>}
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button className="flex-1" disabled>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Replacing... ({progress.done}/{progress.total})
              </Button>
              <Button variant="destructive" onClick={() => { abortRef.current = true }}>
                <Square className="w-4 h-4" />
              </Button>
            </div>
          )}

          {running && (
            <div className="h-2 rounded-full bg-secondary overflow-hidden">
              <div className="h-full bg-primary transition-all duration-300"
                style={{ width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%` }} />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
