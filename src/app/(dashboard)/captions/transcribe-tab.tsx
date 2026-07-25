'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { toast } from 'sonner'
import { Upload, X, Loader2, ListTodo, Film } from 'lucide-react'
import { uploadQueueInput } from '@/lib/upload-queue-input'

export function TranscribeTab() {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)

  const [files, setFiles] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)

  function addFiles(list: FileList | null) {
    if (!list) return
    setFiles(prev => [...prev, ...Array.from(list)])
  }

  function removeFile(idx: number) {
    setFiles(prev => prev.filter((_, i) => i !== idx))
  }

  async function submit() {
    if (!files.length) { toast.error('Upload at least one video'); return }
    if (files.length > 200) { toast.error('Maximum 200 videos per submission'); return }

    setSubmitting(true)
    try {
      toast.loading(`Uploading ${files.length} video${files.length > 1 ? 's' : ''}…`, { id: 'cap-transcribe-upload' })

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
      toast.dismiss('cap-transcribe-upload')
      if (failedNames.length) toast.warning(`${failedNames.length} video${failedNames.length > 1 ? 's' : ''} skipped (corrupted or unreadable)`)
      if (!items.length) throw new Error('All uploads failed — nothing to submit')

      const res = await fetch('/api/queue/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_type: 'video_transcribe', input: { items } }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(e.error ?? 'Submit failed')
      }

      toast.success(`${items.length} video${items.length > 1 ? 's' : ''} sent to queue`, {
        description: 'Transcripts will be ready to download as a CSV from the Queue tab',
        action: { label: 'Open Queue', onClick: () => router.push('/captions?tab=queue') },
      })
      setFiles([])
    } catch (err) {
      toast.dismiss('cap-transcribe-upload')
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-lg mx-auto space-y-4">
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
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
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

      <Button className="w-full" onClick={submit} disabled={submitting || files.length === 0}>
        {submitting
          ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending…</>
          : <><ListTodo className="w-4 h-4 mr-2" />Transcribe to CSV ({files.length})</>}
      </Button>
      <p className="text-[10px] text-muted-foreground text-center">
        No styling, no burn-in — just a CSV with one row per video (filename + full transcript).
        Edit it and re-upload to the Text tab for styled captions.
      </p>
    </div>
  )
}
