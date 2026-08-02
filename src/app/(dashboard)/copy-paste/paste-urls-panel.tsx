'use client'

import { useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent } from '@/components/ui/card'
import { FieldHint } from '@/components/ui/field'
import { Loader2, Link2, Upload, X } from 'lucide-react'

interface PasteUrlsPanelProps {
  onEnqueued: () => void
}

export function PasteUrlsPanel({ onEnqueued }: PasteUrlsPanelProps) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [referenceImageUrl, setReferenceImageUrl] = useState<string | null>(null)

  const lineCount = useMemo(
    () => text.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean).length,
    [text],
  )

  async function onPickFile(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    setUploading(true)
    try {
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
      setReferenceImageUrl(data.url as string)
      toast.success('Reference photo added')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function submit() {
    if (!text.trim()) {
      toast.error('Paste an Instagram reel URL')
      return
    }
    if (!referenceImageUrl) {
      toast.error('Upload a reference photo for this batch first')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/monitor/enqueue-urls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, referenceImageUrl }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to add reel')

      toast.success(
        data.total === 1
          ? 'Queued — analyzing…'
          : `Queued ${data.total} — analyzing…`,
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
          <div>
            <p className="text-sm font-medium">Reference photo</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              One photo for this whole batch — becomes Seedance&apos;s identity source.
            </p>
          </div>

          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
            className="hidden"
            onChange={e => onPickFile(e.target.files)}
          />

          {referenceImageUrl ? (
            <div className="relative group w-28 aspect-square rounded-lg overflow-hidden border border-border bg-secondary/30">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={referenceImageUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
              <button
                type="button"
                onClick={() => setReferenceImageUrl(null)}
                className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                title="Remove"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
              className="w-full border-2 border-dashed border-border rounded-xl p-5 flex flex-col items-center gap-2 hover:border-primary/50 hover:bg-primary/5 transition-colors text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {uploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
              <span className="text-sm">{uploading ? 'Uploading…' : 'Upload reference photo'}</span>
              <span className="text-xs opacity-60">JPEG, PNG or WebP — one per batch</span>
            </button>
          )}
        </div>

        <div className="space-y-3">
          <div className="flex items-start gap-2">
            <Link2 className="w-4 h-4 mt-0.5 text-primary shrink-0" />
            <div>
              <p className="text-sm font-medium">Reel URL</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Paste one or more links — we fetch, analyze, then you hit Replicate.
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
            disabled={submitting || !text.trim() || !referenceImageUrl}
          >
            {submitting
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Link2 className="w-4 h-4" />}
            {submitting ? 'Working…' : `Add to queue${lineCount > 1 ? ` (${lineCount})` : ''}`}
          </Button>
        </div>

        {!referenceImageUrl && (
          <FieldHint>
            Upload a reference photo before adding reels — every reel in this batch shares it.
          </FieldHint>
        )}
      </CardContent>
    </Card>
  )
}
