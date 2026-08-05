'use client'

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import {
  Loader2, CheckCircle2, XCircle, Clock, FolderDown,
  ListTodo, RefreshCw, Trash2, AlertCircle, FileSpreadsheet, Square,
} from 'lucide-react'
import { toCsv } from '@/lib/csv'

interface QueueJob {
  id: string
  job_type: string
  status: 'pending' | 'processing' | 'paused' | 'done' | 'failed' | 'cancelled'
  total_items: number
  done_items: number
  progress: number
  error: string | null
  output: {
    urls?: string[]
    rows?: { videoName: string; text: string }[]
    texts?: string[]
    carouselRows?: { prompt: string; images: string[]; status: 'done' | 'error'; error?: string }[]
  } | null
  attempts: number
  created_at: string
  started_at: string | null
  finished_at: string | null
}

function StatusBadge({ status }: { status: QueueJob['status'] }) {
  const cfg: Record<QueueJob['status'], { label: string; cls: string; icon: React.ReactNode }> = {
    pending:    { label: 'Waiting',      cls: 'bg-secondary text-muted-foreground',     icon: <Clock className="w-2.5 h-2.5" /> },
    processing: { label: 'Processing',   cls: 'bg-blue-500/15 text-blue-400',           icon: <Loader2 className="w-2.5 h-2.5 animate-spin" /> },
    paused:     { label: 'Paused',       cls: 'bg-amber-500/15 text-amber-400',         icon: <Clock className="w-2.5 h-2.5" /> },
    done:       { label: 'Done',         cls: 'bg-emerald-500/15 text-emerald-400',     icon: <CheckCircle2 className="w-2.5 h-2.5" /> },
    failed:     { label: 'Error',        cls: 'bg-destructive/15 text-destructive',     icon: <XCircle className="w-2.5 h-2.5" /> },
    cancelled:  { label: 'Cancelled',    cls: 'bg-secondary text-muted-foreground',     icon: <AlertCircle className="w-2.5 h-2.5" /> },
  }
  const { label, cls, icon } = cfg[status]
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium flex items-center gap-1 shrink-0 ${cls}`}>
      {icon}
      {label}
    </span>
  )
}

function duration(start: string | null, end: string | null): string | null {
  if (!start || !end) return null
  const ms = new Date(end).getTime() - new Date(start).getTime()
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function JobCard({ job, onStop, onDelete, onDownload, downloading }: {
  job: QueueJob
  onStop: () => void
  onDelete: () => void
  onDownload: () => void
  downloading: boolean
}) {
  const usesRows = job.job_type === 'video_transcribe' || job.job_type === 'video_ocr'
  const usesTexts = job.job_type === 'caption_shuffle' || job.job_type === 'caption_generate'
  const usesCarousel = job.job_type === 'bulk_carousel'
  const usesCopyPrompts = job.job_type === 'copy_prompts_generate'
  const successUrls = job.output?.urls?.filter(u => !u.startsWith('error:')) ?? []
  const failedCount = usesRows
    ? job.output?.rows?.filter(r => r.text.startsWith('error:')).length ?? 0
    : usesTexts ? 0
    : usesCarousel ? job.output?.carouselRows?.filter(r => r.status === 'error').length ?? 0
    : job.output?.urls?.filter(u => u.startsWith('error:')).length ?? 0
  const successCount = usesRows
    ? job.output?.rows?.filter(r => !r.text.startsWith('error:')).length ?? 0
    : usesTexts ? job.output?.texts?.length ?? 0
    : usesCarousel ? job.output?.carouselRows?.filter(r => r.status === 'done').length ?? 0
    : successUrls.length
  const hasDownloadableOutput = usesRows
    ? (job.output?.rows?.length ?? 0) > 0
    : usesTexts ? (job.output?.texts?.length ?? 0) > 0
    : usesCarousel ? (job.output?.carouselRows?.filter(r => r.status === 'done').length ?? 0) > 0
    : successUrls.length > 0
  const dur = duration(job.started_at, job.finished_at)

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium">
              {job.job_type === 'bulk_image' ? 'Bulk Image Generation'
                : job.job_type === 'video_repurpose' ? 'Video Repurpose'
                : job.job_type === 'video_caption' ? 'Caption Burn-in'
                : job.job_type === 'video_transcribe' ? 'Bulk Transcribe'
                : job.job_type === 'video_ocr' ? 'On-Screen Text OCR'
                : job.job_type === 'caption_shuffle' ? 'Caption Shuffle'
                : job.job_type === 'caption_generate' ? 'Caption Generate'
                : job.job_type === 'bulk_carousel' ? 'Bulk Carousel'
                : job.job_type === 'copy_prompts_generate' ? 'Copy Prompts'
                : job.job_type}
            </span>
            <StatusBadge status={job.status} />
          </div>
          <p className="text-xs text-muted-foreground">
            {new Date(job.created_at).toLocaleString()}
            {' · '}{`${job.total_items} ${job.job_type === 'bulk_image' ? 'images' : usesTexts ? 'captions' : usesCarousel ? 'carousels' : usesCopyPrompts ? 'prompts' : 'videos'}`}
            {dur && <> · {dur}</>}
            {job.attempts > 1 && <> · Attempt {job.attempts}</>}
          </p>
        </div>
        <div className="flex gap-1.5 shrink-0">
          {job.status === 'done' && hasDownloadableOutput && (
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={onDownload} disabled={downloading}>
              {downloading
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : usesRows || usesTexts ? <FileSpreadsheet className="w-3 h-3" /> : <FolderDown className="w-3 h-3" />}
              {usesRows || usesTexts ? 'CSV' : 'ZIP'}
            </Button>
          )}
          {/* Stop leaves the row (and its finished items) in place; Delete removes
              it outright. A running job used to offer neither — the only control
              was a "Cancel" button on pending jobs that actually deleted them. */}
          {(job.status === 'pending' || job.status === 'processing' || job.status === 'paused') && (
            <Button
              size="sm" variant="ghost"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
              onClick={onStop}
              title="Stop (keep in queue, progress kept)"
            >
              <Square className="w-3 h-3" />
            </Button>
          )}
          <Button
            size="sm" variant="ghost"
            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            title="Delete (remove from queue entirely)"
          >
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>
      </div>

      {/* Progress bar */}
      {(job.status === 'processing' || job.status === 'done') && job.total_items > 0 && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{job.done_items} / {job.total_items}</span>
            <span>{job.progress}%</span>
          </div>
          <div className="h-2 rounded-full bg-secondary overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ${job.status === 'done' ? 'bg-emerald-500' : 'bg-primary animate-pulse'}`}
              style={{ width: `${job.progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Results summary */}
      {job.status === 'done' && (
        <div className="flex items-center gap-3 text-xs">
          <span className="text-emerald-400 font-medium">{successCount} {usesRows || usesTexts ? 'processed' : 'generated'}</span>
          {failedCount > 0 && (
            <span className="text-destructive">{failedCount} failed</span>
          )}
        </div>
      )}

      {/* Error */}
      {job.error && (job.status === 'failed') && (
        <p className="text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2 font-mono break-all">
          {job.error}
        </p>
      )}
    </div>
  )
}

export function QueueTab() {
  const [jobs, setJobs] = useState<QueueJob[]>([])
  const [loading, setLoading] = useState(true)
  const [downloading, setDownloading] = useState<string | null>(null)

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch('/api/queue/list')
      if (res.ok) {
        const data = await res.json()
        setJobs(data.jobs ?? [])
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchJobs() }, [fetchJobs])

  // Auto-poll every 3s when there are active jobs
  useEffect(() => {
    const hasActive = jobs.some(j => j.status === 'pending' || j.status === 'processing')
    if (!hasActive) return
    const t = setTimeout(() => fetchJobs(), 3000)
    return () => clearTimeout(t)
  }, [jobs, fetchJobs])

  /** Soft cancel: the worker stops between items and the row stays, restartable. */
  async function stopJob(id: string) {
    if (!confirm('Stop this job? Finished items are kept and it can be started again later.')) return
    const res = await fetch(`/api/queue/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'stop' }),
    })
    if (res.ok) {
      toast.success('Stopped')
      fetchJobs()
    } else {
      const data = await res.json().catch(() => ({}))
      toast.error(typeof data.error === 'string' ? data.error : 'Could not stop job')
    }
  }

  /** Hard delete: cancels an in-flight worker first, then drops the row. */
  async function deleteJob(id: string) {
    const job = jobs.find(j => j.id === id)
    const active = job?.status === 'pending' || job?.status === 'processing' || job?.status === 'paused'
    if (!confirm(active
      ? 'Delete this job? It is still running — it will be stopped and removed, and its output is lost. This cannot be undone.'
      : 'Delete this job from the queue? This cannot be undone.')) return
    const res = await fetch(`/api/queue/${id}`, { method: 'DELETE' })
    if (res.ok) {
      toast.success('Deleted')
      fetchJobs()
    } else {
      toast.error('Could not delete job')
    }
  }

  function downloadRowsCsv(job: QueueJob) {
    const rows = (job.output?.rows ?? []).filter(r => !r.text.startsWith('error:'))
    if (!rows.length) return
    const isOcr = job.job_type === 'video_ocr'
    const csv = toCsv(rows.map(r => [r.text]))
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${isOcr ? 'on_screen_text' : 'transcripts'}_${job.id.slice(0, 8)}_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
    toast.success('CSV downloaded')
  }

  function downloadTextsCsv(job: QueueJob) {
    const texts = job.output?.texts ?? []
    if (!texts.length) return
    const prefix = job.job_type === 'caption_generate' ? 'caption_generate' : 'caption_shuffle'
    const csv = toCsv(texts.map(t => [t]))
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${prefix}_${job.id.slice(0, 8)}_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
    toast.success('CSV downloaded')
  }

  async function downloadCarouselZip(job: QueueJob) {
    const rows = (job.output?.carouselRows ?? []).filter(r => r.status === 'done' && r.images.length)
    if (!rows.length) return
    setDownloading(job.id)
    try {
      const JSZipMod = (await import('jszip')).default
      const zip = new JSZipMod()
      await Promise.all(rows.map(async (row, i) => {
        const folder = zip.folder(`carousel_${String(i + 1).padStart(2, '0')}`)!
        await Promise.all(row.images.map(async (url, imgIdx) => {
          try {
            const blob = await fetch(url).then(r => r.blob())
            const ext = blob.type.includes('png') ? 'png' : 'jpg'
            folder.file(`image_${imgIdx + 1}.${ext}`, blob)
          } catch {}
        }))
      }))
      const content = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(content)
      a.download = `bulk_carousel_${job.id.slice(0, 8)}_${new Date().toISOString().slice(0, 10)}.zip`
      a.click()
      URL.revokeObjectURL(a.href)
      toast.success('ZIP downloaded')
    } catch {
      toast.error('Download failed')
    } finally {
      setDownloading(null)
    }
  }

  async function downloadJob(job: QueueJob) {
    if (job.job_type === 'video_transcribe' || job.job_type === 'video_ocr') { downloadRowsCsv(job); return }
    if (job.job_type === 'caption_shuffle' || job.job_type === 'caption_generate') { downloadTextsCsv(job); return }
    if (job.job_type === 'bulk_carousel') { downloadCarouselZip(job); return }
    const successUrls = job.output?.urls?.filter(u => !u.startsWith('error:')) ?? []
    if (!successUrls.length) return
    setDownloading(job.id)
    try {
      const JSZipMod = (await import('jszip')).default
      const zip = new JSZipMod()
      await Promise.all(
        successUrls.map(async (url, i) => {
          try {
            const blob = await fetch(url).then(r => r.blob())
            const isVideo = job.job_type === 'video_repurpose' || job.job_type === 'video_caption'
            const ext = isVideo ? 'mp4' : (blob.type.includes('png') ? 'png' : 'jpg')
            const prefix = isVideo ? 'video' : 'image'
            zip.file(`${prefix}_${String(i + 1).padStart(3, '0')}.${ext}`, blob)
          } catch {}
        }),
      )
      const content = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(content)
      a.download = `queue_${job.id.slice(0, 8)}_${new Date().toISOString().slice(0, 10)}.zip`
      a.click()
      URL.revokeObjectURL(a.href)
      toast.success('ZIP downloaded')
    } catch {
      toast.error('Download failed')
    } finally {
      setDownloading(null)
    }
  }

  const activeCount = jobs.filter(j => j.status === 'pending' || j.status === 'processing').length
  const doneCount = jobs.filter(j => j.status === 'done').length
  const failedCount = jobs.filter(j => j.status === 'failed').length

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Background jobs — you can leave the page, processing continues
        </p>
        <Button variant="outline" size="sm" onClick={fetchJobs} disabled={loading}>
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-border bg-card p-3 text-center">
          <p className="text-2xl font-bold text-amber-400">{activeCount}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Active</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-3 text-center">
          <p className="text-2xl font-bold text-emerald-400">{doneCount}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Done</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-3 text-center">
          <p className={`text-2xl font-bold ${failedCount > 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
            {failedCount}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">Errors</p>
        </div>
      </div>

      {/* Info banner when active jobs */}
      {activeCount > 0 && (
        <div className="flex items-center gap-2 p-3 rounded-xl border border-primary/20 bg-primary/5 text-sm">
          <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" />
          <span className="text-primary">
            {activeCount} {activeCount === 1 ? 'job is' : 'jobs are'} processing in the background.
            The page refreshes automatically.
          </span>
        </div>
      )}

      {/* Jobs list */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <ListTodo className="w-12 h-12 mx-auto mb-3 opacity-15" />
          <p className="text-sm font-medium">Queue is empty</p>
          <p className="text-xs mt-1 opacity-70">
            Generator → Bulk Generate for images · Video Repurpose for videos · Captions → Auto for captions
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map(job => (
            <JobCard
              key={job.id}
              job={job}
              onStop={() => stopJob(job.id)}
              onDelete={() => deleteJob(job.id)}
              onDownload={() => downloadJob(job)}
              downloading={downloading === job.id}
            />
          ))}
        </div>
      )}
    </div>
  )
}
