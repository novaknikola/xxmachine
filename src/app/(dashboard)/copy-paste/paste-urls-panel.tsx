'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent } from '@/components/ui/card'
import { FieldHint } from '@/components/ui/field'
import { Loader2, Link2, Upload, X } from 'lucide-react'

interface PasteUrlsPanelProps {
  onEnqueued: () => void
}

const MAX_REFS = 9

export function PasteUrlsPanel({ onEnqueued }: PasteUrlsPanelProps) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const [characterId, setCharacterId] = useState<string | null>(null)
  const [characterName, setCharacterName] = useState<string | null>(null)
  const [refUrls, setRefUrls] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)

  const lineCount = useMemo(
    () => text.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean).length,
    [text],
  )

  const loadDefaultCharacter = useCallback(async () => {
    const res = await fetch('/api/runpod/profiles')
    const data = await res.json()
    const list = (data.profiles ?? []) as Array<{
      character_id: string | null
      platform: string
      status: string
    }>
    const ids = list
      .filter(p => p.platform === 'Instagram' && p.status === 'ACTIVE' && p.character_id)
      .map(p => p.character_id!)

    let best: { id: string; name: string; faceRefUrls: string[] } | null = null
    for (const id of [...new Set(ids)]) {
      const fr = await fetch(`/api/characters/face-refs?characterId=${encodeURIComponent(id)}`)
      const frData = await fr.json()
      if (!fr.ok) continue
      const char = frData.character as { id: string; name: string; faceRefUrls: string[] }
      if (!best) best = char
      if (char.name.toLowerCase() === 'diana') {
        best = char
        break
      }
    }

    if (!best) {
      setCharacterId(null)
      setCharacterName(null)
      setRefUrls([])
      return
    }
    setCharacterId(best.id)
    setCharacterName(best.name)
    setRefUrls(best.faceRefUrls ?? [])
  }, [])

  useEffect(() => { loadDefaultCharacter() }, [loadDefaultCharacter])

  async function persistRefs(next: string[]) {
    if (!characterId) return
    const res = await fetch('/api/characters/face-refs', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characterId, faceRefUrls: next }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? 'Failed to save reference photos')
    setRefUrls(data.faceRefUrls ?? next)
  }

  async function onPickFiles(files: FileList | null) {
    if (!files?.length || !characterId) {
      if (!characterId) toast.error('Bind a character in Discovery first')
      return
    }
    const room = MAX_REFS - refUrls.length
    if (room <= 0) {
      toast.message(`Max ${MAX_REFS} reference photos`)
      return
    }
    const batch = Array.from(files).slice(0, room)
    setUploading(true)
    try {
      const uploaded: string[] = []
      for (const file of batch) {
        const res = await fetch('/api/queue/upload-input', {
          method: 'POST',
          headers: {
            'content-type': file.type || 'image/jpeg',
            'x-file-name': encodeURIComponent(file.name),
          },
          body: file,
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Upload failed')
        uploaded.push(data.url as string)
      }
      const next = [...refUrls, ...uploaded].slice(0, MAX_REFS)
      await persistRefs(next)
      toast.success(
        uploaded.length === 1
          ? 'Reference photo added'
          : `${uploaded.length} reference photos added`,
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function removeRef(url: string) {
    try {
      await persistRefs(refUrls.filter(u => u !== url))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Remove failed')
    }
  }

  async function submit() {
    if (!text.trim()) {
      toast.error('Paste an Instagram reel URL')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/monitor/enqueue-urls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to add reel')

      toast.success(
        data.total === 1
          ? 'Queued — classifying…'
          : `Queued ${data.total} — classifying…`,
      )
      setText('')
      onEnqueued()
      setTimeout(onEnqueued, 4_000)
      setTimeout(onEnqueued, 12_000)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add reel')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card>
      <CardContent className="pt-5 space-y-5">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <p className="text-sm font-medium">Reference photos</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {characterName
                  ? `Used for ${characterName} on Seedream Replicate`
                  : 'Used on Seedream Replicate'}
              </p>
            </div>
            {uploading && (
              <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Uploading…
              </span>
            )}
          </div>

          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
            multiple
            className="hidden"
            onChange={e => onPickFiles(e.target.files)}
          />
          <button
            type="button"
            disabled={!characterId || uploading}
            onClick={() => fileRef.current?.click()}
            className="w-full border-2 border-dashed border-border rounded-xl p-5 flex flex-col items-center gap-2 hover:border-primary/50 hover:bg-primary/5 transition-colors text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <Upload className="w-5 h-5" />
            <span className="text-sm">Upload reference photos</span>
            <span className="text-xs opacity-60">JPEG, PNG or WebP — up to {MAX_REFS}</span>
          </button>

          {refUrls.length > 0 && (
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
              {refUrls.map(url => (
                <div
                  key={url}
                  className="relative group aspect-square rounded-lg overflow-hidden border border-border bg-secondary/30"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={url} alt="" className="w-full h-full object-cover" />
                  <button
                    type="button"
                    onClick={() => removeRef(url)}
                    className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                    title="Remove"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div className="flex items-start gap-2">
            <Link2 className="w-4 h-4 mt-0.5 text-primary shrink-0" />
            <div>
              <p className="text-sm font-medium">Reel URL</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Paste a link — we fetch, classify, then you hit Replicate.
              </p>
            </div>
          </div>

          <Textarea
            value={text}
            onChange={e => setText(e.target.value)}
            rows={3}
            placeholder="https://www.instagram.com/reel/XXXX/"
            className="font-mono text-sm resize-y min-h-[80px]"
            disabled={submitting}
          />

          <Button
            className="w-full sm:w-auto"
            onClick={submit}
            disabled={submitting || !text.trim()}
          >
            {submitting
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Link2 className="w-4 h-4" />}
            {submitting ? 'Working…' : `Add to queue${lineCount > 1 ? ` (${lineCount})` : ''}`}
          </Button>
        </div>

        {!characterId && (
          <FieldHint>
            Bind a character to a tracked Instagram profile in Discovery before Replicate.
          </FieldHint>
        )}
      </CardContent>
    </Card>
  )
}
