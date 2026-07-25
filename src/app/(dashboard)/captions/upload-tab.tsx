'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { Upload, X, Loader2, ListTodo, Film } from 'lucide-react'
import { CAPTION_STYLE_DEFS, type CaptionStyle } from '@/lib/captions'
import { uploadQueueInput } from '@/lib/upload-queue-input'
import { CaptionPositionPreview } from './caption-position-preview'
import { StylePreview, STYLES } from './style-preview'

const MAX_WORDS = 4
const MAX_DURATION = 3

export function UploadTab() {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)

  const [files, setFiles] = useState<File[]>([])
  const [style, setStyle] = useState<CaptionStyle>('tiktok')
  const [fontSize, setFontSize] = useState(CAPTION_STYLE_DEFS.tiktok.fontSize)
  const [posX, setPosX] = useState(50)
  const [posY, setPosY] = useState(80)
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  function addFiles(list: FileList | null) {
    if (!list) return
    setFiles(prev => [...prev, ...Array.from(list)])
  }

  function removeFile(idx: number) {
    setFiles(prev => prev.filter((_, i) => i !== idx))
  }

  function selectStyle(s: CaptionStyle) {
    setStyle(s)
    setFontSize(CAPTION_STYLE_DEFS[s].fontSize)
  }

  async function submit() {
    if (!files.length) { toast.error('Upload at least one video'); return }
    if (files.length > 200) { toast.error('Maximum 200 videos per submission'); return }

    setSubmitting(true)
    try {
      toast.loading(`Uploading ${files.length} video${files.length > 1 ? 's' : ''}…`, { id: 'cap-upload' })

      const items = []
      const failedNames: string[] = []
      for (const file of files) {
        try {
          items.push(await uploadQueueInput(file))
        } catch (err) {
          failedNames.push(file.name)
          console.error('[captions] upload failed:', err)
        }
      }
      toast.dismiss('cap-upload')
      if (failedNames.length) toast.warning(`${failedNames.length} video${failedNames.length > 1 ? 's' : ''} skipped (corrupted or unreadable)`)
      if (!items.length) throw new Error('All uploads failed — nothing to submit')

      const res = await fetch('/api/queue/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_type: 'video_caption',
          input: {
            items,
            style,
            customStyle: { fontSize, posX, posY, videoWidth: dims?.width, videoHeight: dims?.height },
            maxWords: MAX_WORDS,
            maxDuration: MAX_DURATION,
          },
        }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(e.error ?? 'Submit failed')
      }

      toast.success(`${items.length} video${items.length > 1 ? 's' : ''} sent to queue`, {
        description: 'Transcription and burn-in run automatically in the background',
        action: { label: 'Open Queue', onClick: () => router.push('/captions?tab=queue') },
      })
      setFiles([])
    } catch (err) {
      toast.dismiss('cap-upload')
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-6">
      {/* Left panel */}
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Videos (bulk)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <input ref={fileRef} type="file" accept="video/*" multiple className="hidden"
              onChange={e => { addFiles(e.target.files); if (fileRef.current) fileRef.current.value = '' }} />
            <button onClick={() => fileRef.current?.click()}
              className="w-full border-2 border-dashed border-border rounded-xl p-5 flex flex-col items-center gap-2 hover:border-primary/50 hover:bg-primary/5 transition-colors text-muted-foreground hover:text-foreground">
              <Upload className="w-5 h-5" />
              <span className="text-sm">Upload one or more videos</span>
              <span className="text-xs opacity-60">MP4, MOV · up to 200 at once</span>
            </button>

            {files.length > 0 && (
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {files.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/50">
                    <Film className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="flex-1 text-xs truncate">{f.name}</span>
                    <button onClick={() => removeFile(i)} className="text-muted-foreground hover:text-destructive shrink-0">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Caption style</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-5 gap-2">
              {STYLES.map(([id, def]) => (
                <StylePreview key={id} id={id} def={def} active={style === id} onClick={() => selectStyle(id)} />
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Font size</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <input
              type="range" min={20} max={120} value={fontSize}
              onChange={e => setFontSize(Number(e.target.value))}
              className="w-full accent-primary"
            />
            <p className="text-xs text-muted-foreground text-center">{fontSize}px</p>
          </CardContent>
        </Card>

        <Button className="w-full" onClick={submit} disabled={submitting || files.length === 0}>
          {submitting
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending…</>
            : <><ListTodo className="w-4 h-4 mr-2" />Queue Burn-in ({files.length})</>}
        </Button>
        <p className="text-[10px] text-muted-foreground text-center">
          Transcription runs automatically in the background — no text preview before sending
        </p>
      </div>

      {/* Right — position preview */}
      <div>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Caption position</CardTitle>
          </CardHeader>
          <CardContent>
            <CaptionPositionPreview
              videoFile={files[0] ?? null}
              posX={posX}
              posY={posY}
              fontSize={fontSize}
              onChange={(x, y) => { setPosX(x); setPosY(y) }}
              onDimensions={(w, h) => setDims({ width: w, height: h })}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
